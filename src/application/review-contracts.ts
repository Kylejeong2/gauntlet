import { BUDGET_LIMIT } from "../domain/budget.js";
import {
  usdMicros,
  type CommitSha,
  type RunId,
  type UsdMicros,
} from "../domain/ids.js";
import type { ReviewerDefinition } from "../domain/reviewers.js";
import type {
  CandidateFinding,
  ChallengeVerdict,
  PublicationInput,
  ReviewSummary,
  ReviewerReport,
} from "../domain/types.js";

type SandboxHandle = Readonly<{ id: string; estimatedCost?: UsdMicros }>;
type Costed<T> = Readonly<{ cost: UsdMicros }> & T;

export type ReviewRunInput = Readonly<{
  runId: RunId;
  owner: string;
  repository: string;
  pullNumber: number;
  baseSha: CommitSha;
  mergeBaseSha: CommitSha;
  headSha: CommitSha;
  snapshotText: string;
  changedLines: PublicationInput["changedLines"];
  priorStableIdentities: readonly string[];
  coverageOmissions: readonly string[];
  reviewers: readonly ReviewerDefinition[];
}>;

export type ReviewSandboxPort = Readonly<{
  prepare: (input: ReviewRunInput) => Promise<SandboxHandle>;
  evidence?: (
    handle: SandboxHandle,
    reviewer: ReviewerDefinition["id"],
  ) => Promise<readonly string[]>;
  terminate: (handle: SandboxHandle) => Promise<void>;
}>;

export type ReviewModelPort = Readonly<{
  review: (
    input: Readonly<{
      runId: RunId;
      reviewer: ReviewerDefinition["id"];
      label: string;
      question: string;
      snapshot: string;
      toolEvidence: readonly string[];
    }>,
  ) => Promise<Costed<{ report: ReviewerReport }>>;
  challenge: (
    input: Readonly<{
      runId: RunId;
      finding: CandidateFinding;
      snapshot: string;
      toolEvidence: readonly string[];
    }>,
  ) => Promise<Costed<{ verdict: ChallengeVerdict }>>;
  summarize: (
    input: Readonly<{
      runId: RunId;
      reports: readonly ReviewerReport[];
      challenges: readonly ChallengeVerdict[];
      coverageOmissions: readonly string[];
    }>,
  ) => Promise<Costed<{ summary: ReviewSummary }>>;
}>;

const MAX_MODEL_REQUEST_USD_MICROS = 3_000;
const MAX_SAILBOX_USD_MICROS = 10_000;
const MAX_PHASE_ATTEMPTS = 3;

export const estimateWorstCaseRunCost = (reviewerCount: number): UsdMicros => {
  if (
    !Number.isInteger(reviewerCount) ||
    reviewerCount < 1 ||
    reviewerCount > 10
  )
    throw new Error("Reviewer count must be between one and ten");
  const reviewerRequests = reviewerCount;
  const maximumChallenges = reviewerCount * 3;
  const retryableModelPhases = 3;
  const estimate = usdMicros(
    MAX_SAILBOX_USD_MICROS * MAX_PHASE_ATTEMPTS +
      (reviewerRequests + maximumChallenges + 1) *
        MAX_MODEL_REQUEST_USD_MICROS +
      retryableModelPhases *
        (MAX_PHASE_ATTEMPTS - 1) *
        MAX_MODEL_REQUEST_USD_MICROS,
  );
  if (estimate > BUDGET_LIMIT)
    throw new Error("Worst-case review plan exceeds the budget");
  return estimate;
};
