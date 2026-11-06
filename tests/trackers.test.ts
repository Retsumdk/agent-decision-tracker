import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionTracker, NotFoundError, ValidationError } from "../src/engine.js";
import { JournalStore } from "../src/store.js";
import { canonicalJson } from "../src/ids.js";

const DIRS: string[] = [];
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "adt-test-"));
  DIRS.push(dir);
  return dir;
}

function makeTracker(clockValues: number[] = []): { tracker: DecisionTracker; file: string } {
  const dir = workspace();
  const file = join(dir, "journal.jsonl");
  let cursor = 0;
  const clock = () => (clockValues[cursor++] ?? 1_700_000_000_000);
  return { tracker: DecisionTracker.create(file, clock), file };
}

function draft(overrides: Partial<Parameters<DecisionTracker["record"]>[0]> = {}): Parameters<DecisionTracker["record"]>[0] {
  return {
    agentId: "agent-1",
    task: "choose a retry policy",
    options: [
      { option: "exponential", score: 0.8 },
      { option: "fixed", score: 0.4 },
    ],
    chosen: "exponential",
    confidence: 0.7,
    confidenceBasis: "calibrated",
    reasoning: { summary: "tail-heavy failure distribution" },
    ...overrides,
  };
}

describe("record", () => {
  test("records a decision with derived ids and returns it", () => {
    const { tracker } = makeTracker([1_700_000_000_000]);
    const d = tracker.record(draft());
    expect(d.seq).toBe(1);
    expect(d.id).toMatch(/^dec-/);
    expect(d.confidence).toBe(0.7);
    expect(d.chosen).toBe("exponential");
    expect(d.options.length).toBe(2);
    expect(d.tags).toEqual([]);
  });

  test("rejects chosen option not present in options", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.record(draft({ chosen: "linear" }))).toThrow(ValidationError);
  });

  test("rejects confidence outside 0..1", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.record(draft({ confidence: 1.5 }))).toThrow(ValidationError);
    expect(() => tracker.record(draft({ confidence: -0.1 }))).toThrow(ValidationError);
  });

  test("rejects unknown parent decision ids", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.record(draft({ parents: ["dec-missing"] }))).toThrow(ValidationError);
  });

  test("rejects whitespace-only agent ids", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.record(draft({ agentId: "   " }))).toThrow(ValidationError);
  });

  test("rejects empty options list", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.record(draft({ options: [] }))).toThrow(ValidationError);
  });

  test("records declared parents and children index", () => {
    const { tracker } = makeTracker();
    const parent = tracker.record(draft());
    const child = tracker.record(draft({ task: "pick backoff cap", parents: [parent.id] }));
    expect(child.parents).toEqual([parent.id]);
    expect(tracker.childrenOf(parent.id).map((d) => d.id)).toEqual([child.id]);
  });

  test("rejects a parent cycle", () => {
    const { tracker } = makeTracker();
    const a = tracker.record(draft({ task: "a" }));
    const b = tracker.record(draft({ task: "b", parents: [a.id] }));
    expect(() =>
      tracker.record({ ...draft(), task: "c", parents: [b.id, a.id] }),
    ).toThrow(/cycle/);
  });

  test("byAgent filters and list is seq-ordered", () => {
    const { tracker } = makeTracker();
    const a = tracker.record(draft({ agentId: "a", task: "a" }));
    tracker.record(draft({ agentId: "b", task: "b" }));
    tracker.record(draft({ agentId: "a", task: "c" }));
    const list = tracker.list();
    expect(list.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(tracker.byAgent("a").map((d) => d.id)).toEqual([a.id, tracker.list()[2]!.id]);
  });
});

describe("outcomes", () => {
  test("records an outcome against a known decision", () => {
    const { tracker } = makeTracker();
    const d = tracker.record(draft());
    const o = tracker.recordOutcome({
      decisionId: d.id,
      status: "success",
      actual: "retry storms disappeared",
    });
    expect(o.decisionId).toBe(d.id);
    expect(o.seq).toBe(2);
    expect(tracker.outcomesFor(d.id).length).toBe(1);
  });

  test("rejects unknown decision", () => {
    const { tracker } = makeTracker();
    expect(() =>
      tracker.recordOutcome({ decisionId: "dec-x", status: "success", actual: "n/a" }),
    ).toThrow(NotFoundError);
  });

  test("rejects duplicate outcome ids and unknown status", () => {
    const { tracker } = makeTracker();
    const d = tracker.record(draft());
    const first = tracker.recordOutcome({ decisionId: d.id, status: "success", actual: "ok" });
    expect(() =>
      tracker.recordOutcome({ decisionId: d.id, status: "failure", actual: "no", outcomeId: first.id }),
    ).toThrow(ValidationError);
    expect(() =>
      tracker.recordOutcome({ decisionId: d.id, status: "aborted", actual: "no" } as never),
    ).toThrow(ValidationError);
  });
});

describe("attribution and influence", () => {
  test("full chain BFS with depth and ancestor entries", () => {
    const { tracker } = makeTracker();
    const a = tracker.record(draft({ task: "a" }));
    const b = tracker.record(draft({ task: "b", parents: [a.id] }));
    const c = tracker.record(draft({ task: "c", parents: [b.id] }));
    const attr = tracker.attribute(c.id);
    expect(attr.decisionId).toBe(c.id);
    expect(attr.totalAncestors).toBe(2);
    const chain = attr.chain.map((e) => ({ id: e.id, depth: e.depth, via: e.via }));
    expect(chain).toEqual([
      { id: b.id, depth: 1, via: null },
      { id: a.id, depth: 2, via: b.id },
    ]);
    expect(tracker.attribute(a.id).totalAncestors).toBe(0);
  });

  test("descendant influence counts and status tally", () => {
    const { tracker } = makeTracker();
    const root = tracker.record(draft({ task: "root" }));
    const c1 = tracker.record(draft({ task: "c1", parents: [root.id] }));
    tracker.record(draft({ task: "c2", parents: [root.id] }));
    const g1 = tracker.record(draft({ task: "g1", parents: [c1.id] }));
    tracker.recordOutcome({ decisionId: c1.id, status: "success", actual: "ok" });
    tracker.recordOutcome({ decisionId: g1.id, status: "failure", actual: "no" });
    const influence = tracker.influence(root.id);
    expect(influence.descendants).toBe(3);
    expect(influence.descendantsWithOutcomes).toBe(2);
    expect(influence.outcomeStatuses).toEqual({
      success: 1,
      failure: 1,
      partial: 0,
      aborted: 0,
    });
  });
});

describe("calibration", () => {
  test("buckets scored outcomes with monotonic upper bounds and signed deltas", () => {
    const { tracker } = makeTracker();
    const confidences = [0.05, 0.15, 0.55, 0.75, 0.85, 0.95];
    for (const [i, confidence] of confidences.entries()) {
      const d = tracker.record(draft({ task: `t${i}`, confidence, confidenceBasis: "calibrated" }));
      tracker.recordOutcome({
        decisionId: d.id,
        status: i % 2 === 0 ? "success" : "failure",
        actual: `o${i}`,
      });
    }
    tracker.record(draft({ task: "unscored", confidence: 0.5 }));
    const report = tracker.calibration();
    expect(report.scoredOutcomes).toBe(6);
    expect(report.unscoredDecisions).toBe(1);
    const labels = report.buckets.map((b) => b.label);
    expect(labels).toEqual(["00-19", "20-39", "40-59", "60-79", "80-99"]);
    const bucket40 = report.buckets[2]!;
    expect(bucket40.count).toBe(1);
    expect(bucket40.successes).toBe(1);
    expect(bucket40.observedRate).toBeCloseTo(1, 4);
    expect(bucket40.delta).not.toBeNull();
    const bucket80 = report.buckets[4]!;
    expect(bucket80.count).toBe(2);
    expect(bucket80.observedRate).toBeCloseTo(0.5, 4);
    for (const [i, b] of report.buckets.entries()) {
      if (i === 0) continue;
      expect(b.upper).toBeGreaterThan(report.buckets[i - 1]!.upper);
    }
  });

  test("aborted outcomes are not scored", () => {
    const { tracker } = makeTracker();
    const d = tracker.record(draft());
    tracker.recordOutcome({ decisionId: d.id, status: "aborted", actual: "superseded" });
    expect(tracker.calibration().scoredOutcomes).toBe(0);
  });
});

describe("stats and lookup", () => {
  test("stats aggregates agents and mean confidence", () => {
    const { tracker } = makeTracker();
    tracker.record(draft({ agentId: "a" }));
    tracker.record(draft({ agentId: "b", confidence: 0.5 }));
    const stats = tracker.stats();
    expect(stats.decisions).toBe(2);
    expect(stats.agents).toBe(2);
    expect(stats.outcomes).toBe(0);
    expect(stats.decisionsWithOutcomesPct).toBe(0);
    expect(stats.meanConfidence).toBeCloseTo(0.6, 6);
  });

  test("getDecision throws NotFoundError for unknown ids", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.getDecision("dec-nope")).toThrow(NotFoundError);
  });

  test("childrenOf validates unknown ids", () => {
    const { tracker } = makeTracker();
    expect(() => tracker.childrenOf("dec-nope")).toThrow(NotFoundError);
  });
});

describe("store persistence and integrity", () => {
  test("reopen restores decisions, outcomes and parent links", () => {
    const dir = workspace();
    const file = join(dir, "journal.jsonl");
    let clockAt = 1_700_000_000_000;
    const first = DecisionTracker.create(file, () => (clockAt += 1000));
    const parent = first.record(draft({ task: "parent" }));
    const child = first.record(draft({ task: "child", parents: [parent.id] }));
    first.recordOutcome({ decisionId: child.id, status: "partial", actual: "halfway" });
    const closed = first;
    void closed;

    const reopened = DecisionTracker.create(file, () => (clockAt += 1000));
    expect(reopened.list().length).toBe(2);
    expect(reopened.outcomesFor(child.id).length).toBe(1);
    expect(reopened.childrenOf(parent.id).map((d) => d.id)).toEqual([child.id]);
    const verify = reopened.verify();
    expect(verify.ok).toBe(true);
    expect(verify.records).toBe(3);
    reopened.store.close();
  });

  test("reopen repositions the append head at the last hash", () => {
    const dir = workspace();
    const file = join(dir, "journal.jsonl");
    let clockAt = 1_700_000_000_000;
    const first = DecisionTracker.create(file, () => (clockAt += 1000));
    const d = first.record(draft());
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const reopened = DecisionTracker.create(file, () => (clockAt += 1000));
    const followup = reopened.record(draft({ task: "after reopen" }));
    const newLines = readFileSync(file, "utf-8").trim().split("\n");
    expect(newLines.length).toBe(lines.length + 1);
    const appended = JSON.parse(newLines[newLines.length - 1]!) as { record: { id: string } };
    expect(appended.record.id).toBe(followup.id);
    const envelope = JSON.parse(lines[0]!) as { prevHash: string };
    expect(envelope.prevHash).toBe("GENESIS");
    void d;
    reopened.store.close();
  });

  test("verify detects tampering with file:line detail", () => {
    const dir = workspace();
    const file = join(dir, "journal.jsonl");
    const first = DecisionTracker.create(file, () => 1_700_000_000_000);
    first.record(draft());
    first.store.close();

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const target = JSON.parse(lines[0]!) as { record: { agentId: string } };
    target.record.agentId = "tampered";
    lines[0] = JSON.stringify(target);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const store = new JournalStore(file);
    const report = store.verify();
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toMatch(/hash mismatch/);
    store.close();
  });

  test("rejects duplicate ids on replay", () => {
    const dir = workspace();
    const file = join(dir, "journal.jsonl");
    const first = DecisionTracker.create(file, () => 1_700_000_000_000);
    const d = first.record(draft());
    first.store.close();

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const clone = JSON.parse(lines[0]!) as { record: { seq: number } };
    clone.record.seq = 99;
    writeFileSync(file, `${[...lines, JSON.stringify(clone)].join("\n")}\n`);

    const store = new JournalStore(file);
    expect(() => DecisionTracker.fromStore(store, () => 1_700_000_000_000)).toThrow(/duplicate/);
    store.close();
  });

  test("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
