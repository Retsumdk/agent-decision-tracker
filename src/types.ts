export interface OptionAssessment {
  option: string;
  score: number;
  rationale?: string;
}

export type ConfidenceBasis = "calibrated" | "heuristic" | "speculative" | "observed";

export interface ExpectedOutcome {
  description: string;
  successCriteria: string[];
}

export interface Reasoning {
  summary: string;
  assumptions?: string[];
  evidence?: string[];
}

export interface DecisionRecord {
  id: string;
  seq: number;
  agentId: string;
  ts: number;
  task: string;
  context: Record<string, string>;
  options: OptionAssessment[];
  chosen: string;
  confidence: number;
  confidenceBasis: ConfidenceBasis;
  reasoning: Reasoning;
  expectedOutcome?: ExpectedOutcome;
  parents: string[];
  tags: string[];
}

export type OutcomeStatus = "success" | "failure" | "partial" | "aborted";

export interface OutcomeRecord {
  id: string;
  seq: number;
  decisionId: string;
  ts: number;
  status: OutcomeStatus;
  actual: string;
  deviation?: string;
  metrics?: Record<string, number>;
}

export type JournalRecord = DecisionRecord | OutcomeRecord;

export interface JournalEnvelope {
  seq: number;
  prevHash: string;
  hash: string;
  record: JournalRecord;
}

export const OUTCOME_STATUSES: readonly OutcomeStatus[] = [
  "success",
  "failure",
  "partial",
  "aborted",
] as const;

export const CONFIDENCE_BASES: readonly ConfidenceBasis[] = [
  "calibrated",
  "heuristic",
  "speculative",
  "observed",
] as const;

export function outcomeWeight(status: OutcomeStatus): number | null {
  switch (status) {
    case "success":
      return 1;
    case "partial":
      return 0.5;
    case "failure":
      return 0;
    case "aborted":
      return null;
  }
}
