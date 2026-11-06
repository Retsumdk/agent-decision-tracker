import { DecisionTracker, NotFoundError, ValidationError, type DecisionDraft, type OutcomeDraft } from "./engine.js";
import { startServer } from "./server.js";
import { runDemo } from "./demo.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_VALIDATION = 4;
export const EXIT_STORE = 5;

const GLOBAL_FLAGS = new Set(["file", "json", "help", "h"]);

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
  positionals: string[];
}

const COMMAND_FLAGS: Record<string, Set<string>> = {
  record: new Set(["agent", "task", "option", "chosen", "confidence", "basis", "reason", "assumption", "evidence", "parent", "tag", "context", "expect-desc", "criterion"]),
  outcome: new Set(["decision", "status", "actual", "deviation", "metric"]),
  show: new Set([]),
  list: new Set(["agent", "tag", "limit"]),
  attribute: new Set([]),
  influence: new Set([]),
  calibrate: new Set([]),
  stats: new Set([]),
  verify: new Set([]),
  serve: new Set(["port", "token"]),
  demo: new Set(["journal"]),
};

const ALIASES: Record<string, string> = {
  a: "agent",
  t: "task",
  o: "option",
  c: "chosen",
  b: "basis",
  r: "reason",
  p: "parent",
  g: "tag",
  d: "decision",
  s: "status",
  j: "journal",
};

const USAGE = `adt — causal decision tracker for AI agents

Usage:
  adt [--file <journal>] <command> [flags]

Commands:
  record      Log a decision (options, chosen, confidence, reasoning, parents)
  outcome     Record the final outcome of a decision
  show <id>   Print one decision (with its outcome, if recorded)
  list        List decisions (--agent, --tag, --limit)
  attribute <id>  Walk the causal chain behind a decision's outcome
  influence <id>  Count downstream decisions and their outcomes
  calibrate   Compare recorded confidence against realized outcomes
  stats       Aggregate counts by agent and outcome status
  verify      Re-hash the journal and verify the chain
  serve       Serve the HTTP API (--port, token via ADT_TOKEN)
  demo        Run the deterministic demo (--journal <path>)

Global flags:
  --file <path>   Journal path (default: .adt/journal.jsonl)
  --json          Machine-readable output

Exit codes: 0 ok · 2 usage · 3 not found · 4 validation · 5 store error
`;

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let i = 0;
  let command: string | null = null;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "-f" || arg === "--file") {
      const value = argv[i + 1];
      if (value === undefined) throw new ValidationError("USAGE", `${arg} requires a value`);
      const list = flags.get("file") ?? [];
      list.unshift(value);
      flags.set("file", list);
      i += 2;
      continue;
    }
    if (arg === "--json") {
      flags.set("json", ["true"]);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.set("help", ["true"]);
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      let name = arg.replace(/^-+/, "");
      let value: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = ALIASES[name] ?? name;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          flags.set(name, ["true"]);
          i += 1;
          continue;
        }
        i += 2;
      } else {
        i += 1;
      }
      const list = flags.get(name) ?? [];
      list.push(value);
      flags.set(name, list);
      continue;
    }
    if (command === null) {
      command = arg;
    } else {
      positionals.push(arg);
    }
    i += 1;
  }
  return { command: command ?? "", flags, positionals };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function flagAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function requireFlag(args: ParsedArgs, name: string): string {
  const v = flag(args, name);
  if (v === undefined) throw new ValidationError("USAGE", `--${name} is required`);
  return v;
}

function checkFlags(args: ParsedArgs): void {
  const allowed = COMMAND_FLAGS[args.command];
  if (!allowed) return;
  for (const name of args.flags.keys()) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (!allowed.has(name)) {
      throw new ValidationError("USAGE", `--${name} is not valid for command "${args.command}"`);
    }
  }
}

function parseKeyValue(raw: string, what: string): [string, string] {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new ValidationError("USAGE", `${what} must be key=value`);
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function parseOption(raw: string): { option: string; score: number; rationale?: string } {
  const parts = raw.split(":");
  if (parts.length < 2) {
    throw new ValidationError("USAGE", `--option must be label:score[:rationale], got "${raw}"`);
  }
  const label = parts[0] as string;
  const score = Number(parts[1]);
  if (!Number.isFinite(score)) {
    throw new ValidationError("USAGE", `--option score must be a number, got "${parts[1]}"`);
  }
  const out: { option: string; score: number; rationale?: string } = { option: label, score };
  if (parts.length >= 3) out.rationale = parts.slice(2).join(":");
  return out;
}

function errorExitCode(err: unknown): number {
  if (err instanceof ValidationError) {
    return err.code === "USAGE" ? EXIT_USAGE : EXIT_VALIDATION;
  }
  if (err instanceof NotFoundError) return EXIT_NOT_FOUND;
  return EXIT_STORE;
}

export async function run(argv: string[], stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    stderr(USAGE);
    return EXIT_USAGE;
  }

  if (args.command === "" || args.flags.has("help")) {
    stdout(USAGE.trimEnd());
    return args.command === "" && !args.flags.has("help") ? EXIT_USAGE : EXIT_OK;
  }

  const json = args.flags.has("json");
  const file = flag(args, "file") ?? ".adt/journal.jsonl";

  try {
    switch (args.command) {
      case "record": {
        checkFlags(args);
        const tracker = DecisionTracker.create(file);
        try {
          const draft: DecisionDraft = {
            agentId: requireFlag(args, "agent"),
            task: requireFlag(args, "task"),
            options: flagAll(args, "option").map(parseOption),
            chosen: requireFlag(args, "chosen"),
            confidence: Number(requireFlag(args, "confidence")),
            confidenceBasis: flag(args, "basis") as never,
            reasoning: {
              summary: requireFlag(args, "reason"),
            },
          };
          const assumptions = flagAll(args, "assumption");
          const evidence = flagAll(args, "evidence");
          if (assumptions.length > 0) draft.reasoning.assumptions = assumptions;
          if (evidence.length > 0) draft.reasoning.evidence = evidence;
          const contextEntries = flagAll(args, "context");
          if (contextEntries.length > 0) draft.context = Object.fromEntries(contextEntries.map((c) => parseKeyValue(c, "--context")));
          const expectDesc = flag(args, "expect-desc");
          if (expectDesc !== undefined) draft.expectedOutcome = { description: expectDesc, successCriteria: flagAll(args, "criterion") };
          const parents = flagAll(args, "parent");
          if (parents.length > 0) draft.parents = parents;
          const tags = flagAll(args, "tag");
          if (tags.length > 0) draft.tags = tags;
          const record = tracker.record(draft);
          if (json) {
            stdout(JSON.stringify(record, null, 2));
          } else {
            stdout(`recorded ${record.id} (seq ${record.seq}) — agent=${record.agentId} chosen=${record.chosen} confidence=${record.confidence}`);
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "outcome": {
        checkFlags(args);
        const tracker = DecisionTracker.create(file);
        try {
          const metrics: Record<string, number> = {};
          for (const m of flagAll(args, "metric")) {
            const [k, v] = parseKeyValue(m, "--metric");
            const num = Number(v);
            if (!Number.isFinite(num)) {
              throw new ValidationError("USAGE", `--metric value for "${k}" must be a number`);
            }
            metrics[k] = num;
          }
          const outcomeDraft: OutcomeDraft = {
            decisionId: requireFlag(args, "decision"),
            status: requireFlag(args, "status") as never,
            actual: requireFlag(args, "actual"),
          };
          const deviation = flag(args, "deviation");
          if (deviation !== undefined) outcomeDraft.deviation = deviation;
          if (Object.keys(metrics).length > 0) outcomeDraft.metrics = metrics;
          const record = tracker.recordOutcome(outcomeDraft);
          if (json) {
            stdout(JSON.stringify(record, null, 2));
          } else {
            stdout(`outcome ${record.id} — decision=${record.decisionId} status=${record.status}`);
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "show": {
        if (args.positionals.length !== 1) {
          throw new ValidationError("USAGE", "show requires exactly one decision id");
        }
        const tracker = DecisionTracker.create(file);
        try {
          const decision = tracker.getDecision(args.positionals[0] as string);
          const outcome = tracker.getOutcomeForDecision(decision.id);
          if (json) {
            stdout(JSON.stringify({ decision, outcome: outcome ?? null }, null, 2));
          } else {
            stdout(`decision ${decision.id} (seq ${decision.seq})`);
            stdout(`  agent:      ${decision.agentId}`);
            stdout(`  task:       ${decision.task}`);
            stdout(`  chosen:     ${decision.chosen} (confidence ${decision.confidence}, ${decision.confidenceBasis})`);
            stdout(`  options:    ${decision.options.map((o) => `${o.option}(${o.score})`).join(", ")}`);
            stdout(`  reasoning:  ${decision.reasoning.summary}`);
            if (decision.expectedOutcome) {
              stdout(`  expected:   ${decision.expectedOutcome.description}`);
              for (const c of decision.expectedOutcome.successCriteria) stdout(`    - ${c}`);
            }
            if (decision.parents.length > 0) stdout(`  parents:    ${decision.parents.join(", ")}`);
            if (decision.tags.length > 0) stdout(`  tags:       ${decision.tags.join(", ")}`);
            if (outcome) {
              stdout(`  outcome:    ${outcome.status} — ${outcome.actual}`);
              if (outcome.deviation) stdout(`    deviation: ${outcome.deviation}`);
              if (outcome.metrics) {
                for (const [k, v] of Object.entries(outcome.metrics)) stdout(`    ${k}: ${v}`);
              }
            } else {
              stdout(`  outcome:    none recorded yet`);
            }
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "list": {
        checkFlags(args);
        const tracker = DecisionTracker.create(file);
        try {
          const limitRaw = flag(args, "limit");
          const filter: { agentId?: string; tag?: string; limit?: number } = {};
          const agentFilter = flag(args, "agent");
          if (agentFilter !== undefined) filter.agentId = agentFilter;
          const tagFilter = flag(args, "tag");
          if (tagFilter !== undefined) filter.tag = tagFilter;
          if (limitRaw !== undefined) {
            const limit = Number(limitRaw);
            if (Number.isFinite(limit) && limit > 0) filter.limit = limit;
          }
          const records = tracker.listDecisions(filter);
          if (json) {
            stdout(JSON.stringify({ decisions: records }, null, 2));
          } else {
            if (records.length === 0) stdout("no decisions match");
            for (const d of records) {
              const out = tracker.getOutcomeForDecision(d.id);
              stdout(`${d.seq}  ${d.id}  ${d.agentId}  ${d.chosen}  conf=${d.confidence}${out ? `  outcome=${out.status}` : ""}`);
            }
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "attribute": {
        if (args.positionals.length !== 1) {
          throw new ValidationError("USAGE", "attribute requires exactly one decision id");
        }
        const tracker = DecisionTracker.create(file);
        try {
          const report = tracker.attribute(args.positionals[0] as string);
          if (json) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            stdout(`causal chain for ${report.decisionId}:`);
            for (const entry of report.chain) {
              const d = tracker.getDecision(entry.id);
              stdout(`  ${"  ".repeat(entry.depth)}-> ${entry.id} (${d.chosen}, confidence ${d.confidence})`);
            }
            if (report.outcome) {
              stdout(`outcome: ${report.outcome.status} — ${report.outcome.actual}`);
            }
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "influence": {
        if (args.positionals.length !== 1) {
          throw new ValidationError("USAGE", "influence requires exactly one decision id");
        }
        const tracker = DecisionTracker.create(file);
        try {
          const report = tracker.influence(args.positionals[0] as string);
          if (json) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            stdout(`influence of ${report.decisionId}:`);
            stdout(`  descendants: ${report.descendants} (${report.descendantsWithOutcomes} with outcomes)`);
            const parts = Object.entries(report.outcomeStatuses).map(([k, v]) => `${k}=${v}`);
            stdout(`  statuses:    ${parts.join(" ")}`);
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "calibrate": {
        const tracker = DecisionTracker.create(file);
        try {
          const report = tracker.calibration();
          if (json) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            stdout(`calibration (${report.scoredOutcomes} scored outcomes, aborted excluded):`);
            stdout("  bucket   n   mean-conf  observed  delta");
            for (const b of report.buckets) {
              const mean = b.meanConfidence === null ? "   -" : b.meanConfidence.toFixed(4);
              const rate = b.observedRate === null ? "   -" : b.observedRate.toFixed(4);
              const delta = b.delta === null ? "   -" : (b.delta >= 0 ? "+" : "") + b.delta.toFixed(4);
              stdout(`  ${b.label}  ${String(b.count).padStart(3)}  ${String(mean).padStart(9)}  ${String(rate).padStart(8)}  ${String(delta).padStart(7)}`);
            }
            if (report.overallDelta !== null) {
              stdout(`  overall: mean ${report.overallMeanConfidence} vs observed ${report.overallObservedRate} (delta ${report.overallDelta >= 0 ? "+" : ""}${report.overallDelta})`);
            }
          }
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "stats": {
        const tracker = DecisionTracker.create(file);
        try {
          const report = tracker.stats();
          stdout(JSON.stringify(report, null, 2));
          return EXIT_OK;
        } finally {
          tracker.store.close();
        }
      }
      case "verify": {
        const tracker = DecisionTracker.create(file);
        try {
          const report = tracker.verify();
          if (report.ok) {
            stdout(`ok: ${report.records} records, hash chain intact`);
            return EXIT_OK;
          }
          for (const line of report.lines) stderr(`error: ${line}`);
          return EXIT_STORE;
        } finally {
          tracker.store.close();
        }
      }
      case "serve": {
        checkFlags(args);
        const port = Number(flag(args, "port") ?? "8080");
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new ValidationError("USAGE", "--port must be an integer in [0,65535]");
        }
        const token = flag(args, "token");
        const tokenValue = token ?? process.env.ADT_TOKEN;
        const server = await startServer({ port, journal: file, ...(tokenValue !== undefined ? { token: tokenValue } : {}) });
        stdout(`adt serve listening on 127.0.0.1:${server.port}${tokenValue === undefined ? " (writes degraded: ADT_TOKEN unset)" : ""}`);
        return new Promise<number>(() => {});
      }
      case "demo": {
        checkFlags(args);
        return runDemo(flag(args, "journal"), (line) => stdout(line));
      }
      default:
        stderr(`error: unknown command "${args.command}"`);
        stderr(USAGE);
        return EXIT_USAGE;
    }
  } catch (err) {
    stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return errorExitCode(err);
  }
}
