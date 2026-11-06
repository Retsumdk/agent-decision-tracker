import { canonicalJson, contentId } from "./ids.js";
import { JournalStore, StoreError, type VerifyReport } from "./store.js";
import {
  CONFIDENCE_BASES,
  OUTCOME_STATUSES,
  outcomeWeight,
  type ConfidenceBasis,
  type DecisionRecord,
  type JournalEnvelope,
  type JournalRecord,
  type OptionAssessment,
  type OutcomeRecord,
  type OutcomeStatus,
} from "./types.js";

export type Clock = () => number;

export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export class NotFoundError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
  }
}

export interface DecisionDraft {
  agentId: string;
  task: string;
  options: OptionAssessment[];
  chosen: string;
  confidence: number;
  confidenceBasis?: ConfidenceBasis;
  reasoning: { summary: string; assumptions?: string[]; evidence?: string[] };
  context?: Record<string, string>;
  expectedOutcome?: { description: string; successCriteria: string[] };
  parents?: string[];
  tags?: string[];
}

export interface OutcomeDraft {
  decisionId: string;
  status: OutcomeStatus;
  actual: string;
  deviation?: string;
  metrics?: Record<string, number>;
  outcomeId?: string;
}

export interface AncestorEntry {
  id: string;
  depth: number;
  via: string | null;
}

export interface AttributionReport {
  decisionId: string;
  totalAncestors: number;
  chain: AncestorEntry[];
  hasOutcome: boolean;
  outcome?: OutcomeRecord;
}

export interface InfluenceReport {
  decisionId: string;
  descendants: number;
  descendantsWithOutcomes: number;
  outcomeStatuses: Record<OutcomeStatus, number>;
}

export interface CalibrationBucket {
  label: string;
  upper: number;
  count: number;
  successes: number;
  meanConfidence: number | null;
  observedRate: number | null;
  delta: number | null;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  scoredOutcomes: number;
  unscoredDecisions: number;
  overallMeanConfidence: number | null;
  overallObservedRate: number | null;
  overallDelta: number | null;
}

export interface TrackerStats {
  decisions: number;
  outcomes: number;
  agents: number;
  byStatus: Record<OutcomeStatus, number>;
  meanConfidence: number | null;
  decisionsWithOutcomesPct: number | null;
}

const BUCKET_BOUNDS: readonly { label: string; min: number; max: number; upper: number }[] = [
  { label: "00-19", min: 0, max: 0.2, upper: 0.19 },
  { label: "20-39", min: 0.2, max: 0.4, upper: 0.39 },
  { label: "40-59", min: 0.4, max: 0.6, upper: 0.59 },
  { label: "60-79", min: 0.6, max: 0.8, upper: 0.79 },
  { label: "80-99", min: 0.8, max: 1.0000001, upper: 0.99 },
] as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("VALIDATION", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class DecisionTracker {
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly outcomes = new Map<string, OutcomeRecord>();
  private readonly outcomeByDecision = new Map<string, OutcomeRecord>();
  private readonly children = new Map<string, Set<string>>();

  constructor(
    readonly store: JournalStore,
    private readonly clock: Clock = () => Date.now(),
  ) {
    for (const [i, env] of store.all().entries()) {
      this.absorb(env.record, i + 1);
    }
  }

  static create(file: string, clock?: Clock): DecisionTracker {
    return new DecisionTracker(new JournalStore(file), clock);
  }

  static fromStore(store: JournalStore, clock?: Clock): DecisionTracker {
    return new DecisionTracker(store, clock);
  }

  private absorb(record: JournalRecord, lineNo = 0): void {
    if (this.decisions.has(record.id) || this.outcomes.has(record.id)) {
      throw new ValidationError("DUPLICATE_ID", `duplicate record id ${record.id} in journal replay`);
    }
    if (record.id.startsWith("dec-")) {
      const d = record as DecisionRecord;
      if (typeof d.task !== "string" || !Array.isArray(d.parents) || !Array.isArray(d.options)) {
        throw new StoreError(`malformed decision record ${record.id}`, this.store.file, lineNo);
      }
      this.decisions.set(d.id, d);
      for (const p of d.parents) {
        let set = this.children.get(p);
        if (!set) {
          set = new Set<string>();
          this.children.set(p, set);
        }
        set.add(d.id);
      }
    } else if (record.id.startsWith("out-")) {
      const o = record as OutcomeRecord;
      if (typeof o.decisionId !== "string" || typeof o.status !== "string") {
        throw new StoreError(`malformed outcome record ${record.id}`, this.store.file, lineNo);
      }
      this.outcomes.set(o.id, o);
      this.outcomeByDecision.set(o.decisionId, o);
    } else {
      throw new StoreError(`record ${record.id} has an unknown id prefix`, this.store.file, lineNo);
    }
  }

  get decisionCount(): number {
    return this.decisions.size;
  }

  get outcomeCount(): number {
    return this.outcomes.size;
  }

  getDecision(id: string): DecisionRecord {
    const d = this.decisions.get(id);
    if (!d) throw new NotFoundError("NOT_FOUND", `decision ${id} not found`);
    return d;
  }

  getOutcomeForDecision(decisionId: string): OutcomeRecord | undefined {
    return this.outcomeByDecision.get(decisionId);
  }

  record(draft: DecisionDraft): DecisionRecord {
    const agentId = requireNonEmpty(draft.agentId, "agentId");
    const task = requireNonEmpty(draft.task, "task");
    if (!Array.isArray(draft.options) || draft.options.length === 0) {
      throw new ValidationError("VALIDATION", "options must contain at least one assessment");
    }
    const seen = new Set<string>();
    const options: OptionAssessment[] = draft.options.map((o, i) => {
      const label = requireNonEmpty(o?.option, `options[${i}].option`);
      if (seen.has(label)) {
        throw new ValidationError("VALIDATION", `duplicate option label "${label}"`);
      }
      seen.add(label);
      if (!isFiniteNumber(o?.score)) {
        throw new ValidationError("VALIDATION", `options[${i}].score must be a finite number`);
      }
      const entry: OptionAssessment = { option: label, score: o.score };
      if (o?.rationale !== undefined) {
        entry.rationale = requireNonEmpty(o.rationale, `options[${i}].rationale`);
      }
      return entry;
    });
    const chosen = requireNonEmpty(draft.chosen, "chosen");
    if (!seen.has(chosen)) {
      throw new ValidationError("VALIDATION", `chosen "${chosen}" is not among the assessed options`);
    }
    if (!isFiniteNumber(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
      throw new ValidationError("VALIDATION", "confidence must be a number in [0,1]");
    }
    const basis: ConfidenceBasis = draft.confidenceBasis ?? "heuristic";
    if (!CONFIDENCE_BASES.includes(basis)) {
      throw new ValidationError("VALIDATION", `confidenceBasis must be one of ${CONFIDENCE_BASES.join(", ")}`);
    }
    const summary = requireNonEmpty(draft.reasoning?.summary, "reasoning.summary");
    const parents: string[] = [];
    if (draft.parents !== undefined) {
      if (!Array.isArray(draft.parents)) {
        throw new ValidationError("VALIDATION", "parents must be an array of decision ids");
      }
      for (const p of draft.parents) {
        const pid = requireNonEmpty(p, "parents[]");
        if (parents.includes(pid)) {
          throw new ValidationError("VALIDATION", `duplicate parent ${pid}`);
        }
        if (!this.decisions.has(pid)) {
          throw new ValidationError("VALIDATION", `parent decision ${pid} not found`);
        }
        parents.push(pid);
      }
      for (let i = 0; i < parents.length; i++) {
        for (let j = 0; j < parents.length; j++) {
          if (i === j) continue;
          const p = parents[i] as string;
          const q = parents[j] as string;
          if (this.ancestorSet(q).has(p)) {
            throw new ValidationError("VALIDATION", `parent ${p} creates a cycle (it is already an ancestor of ${q})`);
          }
        }
      }
    }
    const context: Record<string, string> = {};
    if (draft.context !== undefined) {
      for (const [k, v] of Object.entries(draft.context)) {
        context[requireNonEmpty(k, "context key")] = requireNonEmpty(v, `context["${k}"]`);
      }
    }
    const reasoning: DecisionRecord["reasoning"] = { summary };
    if (draft.reasoning.assumptions !== undefined) {
      if (!Array.isArray(draft.reasoning.assumptions)) {
        throw new ValidationError("VALIDATION", "assumptions must be an array of strings");
      }
      const assumptions = draft.reasoning.assumptions.map((a, i) => requireNonEmpty(a, `assumptions[${i}]`));
      if (assumptions.length > 0) reasoning.assumptions = assumptions;
    }
    if (draft.reasoning.evidence !== undefined) {
      if (!Array.isArray(draft.reasoning.evidence)) {
        throw new ValidationError("VALIDATION", "evidence must be an array of strings");
      }
      const evidence = draft.reasoning.evidence.map((e, i) => requireNonEmpty(e, `evidence[${i}]`));
      if (evidence.length > 0) reasoning.evidence = evidence;
    }
    const ts = this.clock();
    const seq = this.store.nextSeq;
    const record: DecisionRecord = {
      id: "",
      seq,
      agentId,
      ts,
      task,
      context,
      options,
      chosen,
      confidence: draft.confidence,
      confidenceBasis: basis,
      reasoning,
      parents,
      tags: (draft.tags ?? []).map((t, i) => requireNonEmpty(t, `tags[${i}]`)),
    };
    if (draft.expectedOutcome !== undefined) {
      const description = requireNonEmpty(draft.expectedOutcome.description, "expectedOutcome.description");
      if (!Array.isArray(draft.expectedOutcome.successCriteria)) {
        throw new ValidationError("VALIDATION", "successCriteria must be an array of strings");
      }
      const criteria = draft.expectedOutcome.successCriteria.map((c, i) => requireNonEmpty(c, `successCriteria[${i}]`));
      if (criteria.length === 0) {
        throw new ValidationError("VALIDATION", "successCriteria must contain at least one criterion");
      }
      record.expectedOutcome = { description, successCriteria: criteria };
    }
    const id = contentId("dec", [
      agentId,
      task,
      canonicalJson(options),
      chosen,
      String(draft.confidence),
      basis,
      canonicalJson(reasoning),
      canonicalJson(context),
      canonicalJson(record.expectedOutcome ?? null),
      parents.join(">"),
      canonicalJson(record.tags),
    ]);
    if (this.decisions.has(id)) {
      throw new ValidationError("REPLAY", `an identical decision is already recorded (${id})`);
    }
    record.id = id;
    this.store.append(record);
    this.absorb(record, this.store.size);
    return record;
  }

  recordOutcome(draft: OutcomeDraft): OutcomeRecord {
    const decision = this.getDecision(draft.decisionId);
    if (this.outcomeByDecision.has(decision.id)) {
      throw new ValidationError("ALREADY_RECORDED", `decision ${decision.id} already has a final outcome`);
    }
    if (!OUTCOME_STATUSES.includes(draft.status)) {
      throw new ValidationError("VALIDATION", `status must be one of ${OUTCOME_STATUSES.join(", ")}`);
    }
    const actual = requireNonEmpty(draft.actual, "actual");
    const metrics: Record<string, number> = {};
    if (draft.metrics !== undefined) {
      for (const [k, v] of Object.entries(draft.metrics)) {
        if (!isFiniteNumber(v)) {
          throw new ValidationError("VALIDATION", `metrics["${k}"] must be a finite number`);
        }
        metrics[requireNonEmpty(k, "metric key")] = v;
      }
    }
    const ts = this.clock();
    const seq = this.store.nextSeq;
    const id = draft.outcomeId !== undefined
      ? requireNonEmpty(draft.outcomeId, "outcomeId")
      : contentId("out", [decision.id, draft.status, actual, draft.deviation ?? "", canonicalJson(metrics)]);
    if (this.outcomes.has(id)) {
      throw new ValidationError("REPLAY", `outcome ${id} is already recorded`);
    }
    const record: OutcomeRecord = {
      id: "",
      seq,
      decisionId: decision.id,
      ts,
      status: draft.status,
      actual,
    };
    if (draft.deviation !== undefined) {
      record.deviation = requireNonEmpty(draft.deviation, "deviation");
    }
    if (Object.keys(metrics).length > 0) record.metrics = metrics;
    record.id = id;
    this.store.append(record);
    this.absorb(record, this.store.size);
    return record;
  }

  private ancestorSet(decisionId: string): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...(this.decisions.get(decisionId)?.parents ?? [])];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const pid of this.decisions.get(cur)?.parents ?? []) queue.push(pid);
    }
    return seen;
  }

  list(): DecisionRecord[] {
    return this.listDecisions();
  }

  byAgent(agentId: string): DecisionRecord[] {
    return this.listDecisions({ agentId });
  }

  outcomesFor(decisionId: string): OutcomeRecord[] {
    const outcome = this.outcomeByDecision.get(decisionId);
    return outcome ? [outcome] : [];
  }

  childrenOf(decisionId: string): DecisionRecord[] {
    this.getDecision(decisionId);
    const ids = [...(this.children.get(decisionId) ?? [])];
    return ids
      .map((id) => this.decisions.get(id))
      .filter((d): d is DecisionRecord => d !== undefined)
      .sort((a, b) => a.seq - b.seq);
  }

  attribute(decisionId: string): AttributionReport {
    this.getDecision(decisionId);
    const chain: AncestorEntry[] = [];
    const queue: { id: string; depth: number; via: string | null }[] = [
      { id: decisionId, depth: 0, via: null },
    ];
    const seen = new Set<string>([decisionId]);
    while (queue.length > 0) {
      const cur = queue.shift() as { id: string; depth: number; via: string | null };
      const parentIds = this.decisions.get(cur.id)?.parents ?? [];
      for (const pid of parentIds) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        chain.push({ id: pid, depth: cur.depth + 1, via: cur.depth === 0 ? null : cur.id });
        queue.push({ id: pid, depth: cur.depth + 1, via: cur.id });
      }
    }
    const outcome = this.outcomeByDecision.get(decisionId);
    const report: AttributionReport = {
      decisionId,
      totalAncestors: chain.length,
      chain,
      hasOutcome: outcome !== undefined,
    };
    if (outcome !== undefined) report.outcome = outcome;
    return report;
  }

  influence(decisionId: string): InfluenceReport {
    this.getDecision(decisionId);
    const statuses: Record<OutcomeStatus, number> = { success: 0, failure: 0, partial: 0, aborted: 0 };
    // The decision's own final outcome is part of its influence report; the
    // descendant counts below are strict (the decision is never its own descendant).
    const own = this.outcomeByDecision.get(decisionId);
    if (own) statuses[own.status]++;
    let descendants = 0;
    let withOutcomes = 0;
    const queue: string[] = [...(this.children.get(decisionId) ?? [])];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      descendants++;
      const out = this.outcomeByDecision.get(cur);
      if (out) {
        withOutcomes++;
        statuses[out.status]++;
      }
      for (const child of this.children.get(cur) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return { decisionId, descendants, descendantsWithOutcomes: withOutcomes, outcomeStatuses: statuses };
  }

  calibration(): CalibrationReport {
    const buckets: CalibrationBucket[] = BUCKET_BOUNDS.map((b) => ({
      label: b.label,
      upper: b.upper,
      count: 0,
      successes: 0,
      meanConfidence: null,
      observedRate: null,
      delta: null,
    }));
    let scored = 0;
    let confSum = 0;
    let rateSum = 0;
    for (const decision of [...this.decisions.values()].sort((a, b) => a.seq - b.seq)) {
      const outcome = this.outcomeByDecision.get(decision.id);
      if (!outcome) continue;
      const weight = outcomeWeight(outcome.status);
      if (weight === null) continue;
      scored++;
      confSum += decision.confidence;
      rateSum += weight;
      const bounds = BUCKET_BOUNDS.find((b) => decision.confidence >= b.min && decision.confidence < b.max);
      if (bounds) {
        const bucket = buckets[BUCKET_BOUNDS.indexOf(bounds)];
        if (bucket) {
          bucket.count++;
          if (weight === 1) bucket.successes++;
          bucket.meanConfidence = (bucket.meanConfidence ?? 0) + decision.confidence;
          bucket.observedRate = (bucket.observedRate ?? 0) + weight;
        }
      }
    }
    let decisionsWithOutcome = 0;
    for (const bucket of buckets) {
      if (bucket.count > 0) {
        const mean = round4((bucket.meanConfidence as number) / bucket.count);
        const rate = round4((bucket.observedRate as number) / bucket.count);
        bucket.meanConfidence = mean;
        bucket.observedRate = rate;
        bucket.delta = round4(rate - mean);
      } else {
        bucket.meanConfidence = null;
        bucket.observedRate = null;
        bucket.delta = null;
      }
    }
    for (const decision of this.decisions.values()) {
      if (this.outcomeByDecision.has(decision.id)) decisionsWithOutcome++;
    }
    const report: CalibrationReport = {
      buckets,
      scoredOutcomes: scored,
      unscoredDecisions: this.decisions.size - decisionsWithOutcome,
      overallMeanConfidence: null,
      overallObservedRate: null,
      overallDelta: null,
    };
    if (scored > 0) {
      const mean = round4(confSum / scored);
      const rate = round4(rateSum / scored);
      report.overallMeanConfidence = mean;
      report.overallObservedRate = rate;
      report.overallDelta = round4(rate - mean);
    }
    return report;
  }

  stats(): TrackerStats {
    const byStatus: Record<OutcomeStatus, number> = { success: 0, failure: 0, partial: 0, aborted: 0 };
    const agents = new Set<string>();
    let confSum = 0;
    for (const d of this.decisions.values()) {
      agents.add(d.agentId);
      confSum += d.confidence;
    }
    for (const o of this.outcomes.values()) byStatus[o.status]++;
    const n = this.decisions.size;
    return {
      decisions: n,
      outcomes: this.outcomes.size,
      agents: agents.size,
      byStatus,
      meanConfidence: n > 0 ? round4(confSum / n) : null,
      decisionsWithOutcomesPct: n > 0 ? round4((this.outcomeByDecision.size / n) * 100) : null,
    };
  }

  listDecisions(filter?: { agentId?: string; tag?: string; limit?: number }): DecisionRecord[] {
    let records = [...this.decisions.values()].sort((a, b) => a.seq - b.seq);
    if (filter?.agentId !== undefined) records = records.filter((d) => d.agentId === filter.agentId);
    if (filter?.tag !== undefined) records = records.filter((d) => d.tags.includes(filter.tag as string));
    if (filter?.limit !== undefined && filter.limit > 0) records = records.slice(0, filter.limit);
    return records;
  }

  verify(): VerifyReport {
    return this.store.verify();
  }

  envelopes(): readonly JournalEnvelope[] {
    return this.store.all();
  }
}
