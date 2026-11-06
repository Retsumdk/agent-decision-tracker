#!/usr/bin/env bun
/**
 * Deterministic demo for agent-decision-tracker.
 *
 * Runs a fixed, hand-checked scenario on a manual clock so every run is
 * byte-identical (CI diffs the output against demo-output.txt):
 *
 *   1. A root decision: agent "planner" picks a retry policy.
 *   2. A child decision inherits from the root (attribution chain).
 *   3. Both get real outcomes: root success, child failure.
 *   4. Calibration is computed and the journal is verified.
 *
 * The journal is written to a fresh temp directory every run; the printed
 * output contains only deterministic values (ids are content-derived).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionTracker } from "./engine.js";
import { fmtDate } from "./format.js";

const STEP = 7_000_000; // ms between demo events (clock advances every call)

export function runDemo(journalPath?: string, out: (line: string) => void = (line) => console.log(line)): number {
  const owned = journalPath === undefined;
  const dir = owned ? mkdtempSync(join(tmpdir(), "adt-demo-")) : undefined;
  const journal = journalPath ?? join(dir as string, "demo.jsonl");
  let clock = 1_753_440_000_000; // fixed start: 2025-07-25T10:40:00Z
  const now = () => (clock += STEP);

  out("agent-decision-tracker — deterministic demo");
  out(`journal: ${owned ? "<tempdir>/demo.jsonl" : journal}`);
  out("");

  const tracker = DecisionTracker.create(journal, now);

  // 1. Root decision with explicit option scores.
  const root = tracker.record({
    agentId: "planner",
    task: "choose retry policy for outbound webhooks",
    options: [
      { option: "exponential", score: 0.82 },
      { option: "fixed", score: 0.45 },
      { option: "none", score: 0.10 },
    ],
    chosen: "exponential",
    confidence: 0.8,
    confidenceBasis: "calibrated",
    reasoning: {
      summary: "tail-heavy failure distribution favors backoff",
      evidence: ["webhook failures cluster in bursts", "fixed retries amplified bursts last sprint"],
    },
    tags: ["retries", "webhooks"],
  });
  out(`[1] recorded decision ${root.id}`);
  out(`    agent=planner task=choose retry policy for outbound webhooks`);
  out(`    chosen=exponential confidence=0.80 (calibrated)`);
  out(`    options: exponential=0.82 fixed=0.45 none=0.10`);
  out(`    at=${fmtDate(root.ts)}`);

  // 2. Child decision that inherited the policy and now picks its cap.
  const child = tracker.record({
    agentId: "scheduler",
    task: "choose backoff cap for the retry policy",
    parents: [root.id],
    options: [
      { option: "cap-30s", score: 0.75 },
      { option: "cap-300s", score: 0.50 },
    ],
    chosen: "cap-30s",
    confidence: 0.55,
    confidenceBasis: "speculative",
    reasoning: { summary: "caps beyond 30s stall the pipeline; guessed" },
    tags: ["retries"],
  });
  out("");
  out(`[2] recorded decision ${child.id}`);
  out(`    agent=scheduler task=choose backoff cap for the retry policy`);
  out(`    parents: ${child.parents.join(", ")}`);
  out(`    chosen=cap-30s confidence=0.55 (speculative)`);

  // 3. Attribution chain for the child.
  const attr = tracker.attribute(child.id);
  out("");
  out(`[3] attribution chain for ${child.id}:`);
  out(`    depth=1 ${attr.chain[0]!.id} (parent)`);
  out(`    totalAncestors=${attr.totalAncestors}`);

  // 4. Outcomes land: root succeeded, child failed.
  const outRoot = tracker.recordOutcome({
    decisionId: root.id,
    status: "success",
    actual: "webhook success rate 99.4% after one sprint",
  });
  const outChild = tracker.recordOutcome({
    decisionId: child.id,
    status: "failure",
    actual: "cap-30s starved slow providers; rolled back to 300s",
  });
  out("");
  out(`[4] outcomes recorded:`);
  out(`    ${root.id} -> ${outRoot.status}`);
  out(`    ${child.id} -> ${outChild.status}`);

  // 5. Influence of the root across the subtree.
  const influence = tracker.influence(root.id);
  out("");
  out(`[5] influence of ${root.id}:`);
  out(`    descendants=${influence.descendants} descendantsWithOutcomes=${influence.descendantsWithOutcomes}`);
  out(`    outcomeStatuses: ${Object.entries(influence.outcomeStatuses)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status}=${n}`)
    .join(" ")}`);

  // 6. Calibration report.
  const calibration = tracker.calibration();
  out("");
  out(`[6] calibration (scored=${calibration.scoredOutcomes}, unscored=${calibration.unscoredDecisions}):`);
  for (const bucket of calibration.buckets) {
    if (bucket.count === 0) continue;
    const delta = bucket.delta === null ? "n/a" : `${bucket.delta > 0 ? "+" : ""}${bucket.delta.toFixed(2)}`;
    out(
      `    conf ${bucket.label}: n=${bucket.count} observed=${((bucket.observedRate ?? 0) * 100).toFixed(1)}% delta=${delta}`,
    );
  }

  // 7. Stats + journal integrity.
  const stats = tracker.stats();
  const verify = tracker.verify();
  out("");
  out(`[7] stats: decisions=${stats.decisions} agents=${stats.agents} outcomes=${stats.outcomes}`);
  out(`    decisionsWithOutcomesPct=${stats.decisionsWithOutcomesPct} meanConfidence=${(stats.meanConfidence ?? 0).toFixed(3)}`);
  out(`    verify: ok=${verify.ok} records=${verify.records}`);

  tracker.store.close();
  if (!verify.ok) {
    if (owned && dir) rmSync(dir, { recursive: true, force: true });
    out("demo journal failed verification");
    return 1;
  }

  if (owned && dir) rmSync(dir, { recursive: true, force: true });
  return 0;
}

if (import.meta.main) {
  process.exit(runDemo(process.argv[2]));
}
