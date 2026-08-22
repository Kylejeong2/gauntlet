import { BUDGET_LIMIT } from "../domain/budget.js";
import { usdMicros, type UsdMicros } from "../domain/ids.js";
import {
  reducePublication,
  type PublicationPlan,
} from "../domain/publication.js";
import type { ReviewerDefinition } from "../domain/reviewers.js";
import type {
  CandidateFinding,
  ChallengeVerdict,
  PublicationInput,
  ReviewerReport,
} from "../domain/types.js";
import type { CommitSha, RunId } from "../domain/ids.js";

type SandboxHandle = Readonly<{ id: string; estimatedCost?: UsdMicros }>;

export type ReviewRunInput = Readonly<{
  runId: RunId;
  owner: string;
  repository: string;
  pullNumber: number;
  baseSha: CommitSha;
  headSha: CommitSha;
  snapshotText: string;
  changedLines: PublicationInput["changedLines"];
  priorStableIdentities: readonly string[];
  coverageOmissions: readonly string[];
  reviewers: readonly ReviewerDefinition[];
}>;

type Costed<T> = Readonly<{ cost: UsdMicros }> & T;

export type ReviewAuditEvent =
  | Readonly<{ kind: "sandbox_prepared"; sailboxId: string }>
  | Readonly<{
      kind: "reviewer_completed";
      reviewer: ReviewerDefinition["id"];
      readiness: number;
      findingCount: number;
      cost: UsdMicros;
    }>
  | Readonly<{
      kind: "challenge_completed";
      findingId: CandidateFinding["id"];
      outcome: ChallengeVerdict["kind"];
      cost: UsdMicros;
    }>
  | Readonly<{ kind: "publication_reconciled"; reviewId: number }>
  | Readonly<{ kind: "publication_submitted"; reviewId: number }>
  | Readonly<{ kind: "sandbox_terminated"; sailboxId: string }>;

export type ReviewPorts = Readonly<{
  audit?: (event: ReviewAuditEvent) => void;
  sandbox: Readonly<{
    prepare: (input: ReviewRunInput) => Promise<SandboxHandle>;
    evidence?: (
      handle: SandboxHandle,
      reviewer: ReviewerDefinition["id"],
    ) => Promise<readonly string[]>;
    terminate: (handle: SandboxHandle) => Promise<void>;
  }>;
  model: Readonly<{
    review: (
      input: Readonly<{
        reviewer: ReviewerDefinition["id"];
        label: string;
        question: string;
        snapshot: string;
        toolEvidence: readonly string[];
      }>,
    ) => Promise<Costed<{ report: ReviewerReport }>>;
    challenge: (
      input: Readonly<{
        finding: CandidateFinding;
        snapshot: string;
        toolEvidence: readonly string[];
      }>,
    ) => Promise<Costed<{ verdict: ChallengeVerdict }>>;
  }>;
  github: Readonly<{
    findExisting?: (
      runId: RunId,
    ) => Promise<Readonly<{ reviewId: number }> | null>;
    publish: (
      plan: Extract<PublicationPlan, { kind: "publish" }>,
    ) => Promise<Readonly<{ reviewId: number }>>;
  }>;
}>;

export type ReviewRunResult = Readonly<{
  reviewId: number;
  cost: UsdMicros;
  reports: readonly ReviewerReport[];
  challenges: readonly ChallengeVerdict[];
}>;

const MAX_MODEL_REQUEST_USD_MICROS = 3_000;
const MAX_SAILBOX_USD_MICROS = 10_000;

export const estimateWorstCaseRunCost = (reviewerCount: number): UsdMicros => {
  if (
    !Number.isInteger(reviewerCount) ||
    reviewerCount < 1 ||
    reviewerCount > 10
  )
    throw new Error("Reviewer count must be between one and ten");
  const reviewerRequests = reviewerCount;
  const maximumChallenges = reviewerCount * 3;
  return usdMicros(
    MAX_SAILBOX_USD_MICROS +
      (reviewerRequests + maximumChallenges) * MAX_MODEL_REQUEST_USD_MICROS,
  );
};

export const runReview = async (
  input: ReviewRunInput,
  ports: ReviewPorts,
): Promise<ReviewRunResult> => {
  if (input.reviewers.length === 0 || input.reviewers.length > 10)
    throw new Error("A review requires between one and ten reviewers");
  const worstCaseCost = estimateWorstCaseRunCost(input.reviewers.length);
  if (worstCaseCost > BUDGET_LIMIT)
    throw new Error("Worst-case review plan exceeds the budget");
  const startedAt = Date.now();
  const sandbox = await ports.sandbox.prepare(input);
  ports.audit?.({ kind: "sandbox_prepared", sailboxId: sandbox.id });
  let cost = usdMicros(0);
  const addCost = (amount: UsdMicros): void => {
    const next = usdMicros(cost + amount);
    if (next > BUDGET_LIMIT) throw new Error("Review budget exceeded");
    cost = next;
  };

  try {
    addCost(sandbox.estimatedCost ?? usdMicros(0));
    const evidenceByReviewer = new Map<
      ReviewerDefinition["id"],
      readonly string[]
    >();
    for (const reviewer of input.reviewers) {
      const evidence =
        ports.sandbox.evidence === undefined
          ? []
          : await ports.sandbox.evidence(sandbox, reviewer.id);
      evidenceByReviewer.set(reviewer.id, evidence);
    }
    const reviewResults = await mapConcurrent(
      input.reviewers,
      2,
      async (reviewer) =>
        ports.model.review({
          reviewer: reviewer.id,
          label: reviewer.label,
          question: reviewer.question,
          snapshot: input.snapshotText,
          toolEvidence: evidenceByReviewer.get(reviewer.id) ?? [],
        }),
    );
    for (const result of reviewResults) addCost(result.cost);
    for (const result of reviewResults) {
      ports.audit?.({
        kind: "reviewer_completed",
        reviewer: result.report.reviewer,
        readiness: result.report.readiness,
        findingCount: result.report.findings.length,
        cost: result.cost,
      });
    }
    const reports = reviewResults.map((result) => result.report);
    const findings = reports.flatMap((report) => report.findings);
    const challengeResults = await mapConcurrent(findings, 2, async (finding) =>
      ports.model.challenge({
        finding,
        snapshot: input.snapshotText,
        toolEvidence: [],
      }),
    );
    for (const result of challengeResults) addCost(result.cost);
    for (const result of challengeResults) {
      ports.audit?.({
        kind: "challenge_completed",
        findingId: result.verdict.findingId,
        outcome: result.verdict.kind,
        cost: result.cost,
      });
    }
    const challenges = challengeResults.map((result) => result.verdict);
    const plan = reducePublication({
      runId: input.runId,
      headSha: input.headSha,
      selectedReviewers: input.reviewers.map((reviewer) => reviewer.id),
      reports,
      challenges,
      changedLines: input.changedLines,
      priorStableIdentities: input.priorStableIdentities,
      coverageOmissions: input.coverageOmissions,
      estimatedCost: cost,
      durationMs: Date.now() - startedAt,
    });
    if (plan.kind !== "publish")
      throw new Error(`Publication refused: ${plan.reason}`);
    const existingPublication =
      ports.github.findExisting === undefined
        ? null
        : await ports.github.findExisting(input.runId);
    const publication =
      existingPublication ?? (await ports.github.publish(plan));
    ports.audit?.({
      kind:
        existingPublication === null
          ? "publication_submitted"
          : "publication_reconciled",
      reviewId: publication.reviewId,
    });
    return { reviewId: publication.reviewId, cost, reports, challenges };
  } finally {
    await ports.sandbox.terminate(sandbox);
    ports.audit?.({ kind: "sandbox_terminated", sailboxId: sandbox.id });
  }
};

const mapConcurrent = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value === undefined)
          throw new Error("Missing concurrent work item");
        results[index] = await operation(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
};
