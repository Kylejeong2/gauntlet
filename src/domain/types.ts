import type {
  CommitSha,
  FindingId,
  ReviewerId,
  RunId,
  UsdMicros,
} from "./ids.js";

export type Severity = "critical" | "high" | "medium" | "low";
export type Readiness = 1 | 2 | 3 | 4 | 5;

export type CandidateFinding = Readonly<{
  id: FindingId;
  reviewer: ReviewerId;
  location: Readonly<{ path: string; line: number }>;
  severity: Severity;
  confidence: number;
  title: string;
  trigger: string;
  evidence: string;
  proposedAction: string;
  stableIdentity: string;
}>;

export type ReviewerReport = Readonly<{
  reviewer: ReviewerId;
  readiness: Readiness;
  rationale: string;
  examinedAreas: readonly string[];
  findings: readonly CandidateFinding[];
}>;

export type ChallengeVerdict =
  | Readonly<{ kind: "confirmed"; findingId: FindingId; reason: string }>
  | Readonly<{ kind: "rejected"; findingId: FindingId; reason: string }>
  | Readonly<{ kind: "inconclusive"; findingId: FindingId; reason: string }>
  | Readonly<{ kind: "failed"; findingId: FindingId; reason: string }>;

export type ReviewSummary = Readonly<{
  headline: string;
  overview: string;
  keyChanges: readonly string[];
  keyRisks: readonly string[];
  recommendedActions: readonly string[];
}>;

export type RunState =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "snapshotting" }>
  | Readonly<{ kind: "planning" }>
  | Readonly<{ kind: "preparing_sailbox" }>
  | Readonly<{ kind: "reviewing" }>
  | Readonly<{ kind: "challenging" }>
  | Readonly<{ kind: "reducing" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "cleaning_up" }>
  | Readonly<{ kind: "completed"; completedAtMs: number }>
  | Readonly<{ kind: "failed"; failedAtMs: number; reason: string }>;

export type RunView = Readonly<{
  runId: RunId;
  state: RunState;
  pendingWorkKeys: readonly string[];
}>;

export type PublicationInput = Readonly<{
  runId: RunId;
  headSha: CommitSha;
  selectedReviewers: readonly ReviewerId[];
  reports: readonly ReviewerReport[];
  challenges: readonly ChallengeVerdict[];
  changedLines: readonly Readonly<{ path: string; lines: readonly number[] }>[];
  priorStableIdentities: readonly string[];
  coverageOmissions: readonly string[];
  estimatedCost: UsdMicros;
  durationMs: number;
  reviewSummary: ReviewSummary;
}>;
