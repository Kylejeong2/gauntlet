import { createHash } from "node:crypto";
import {
  estimateWorstCaseRunCost,
  type ReviewModelPort,
  type ReviewRunInput,
  type ReviewSandboxPort,
} from "./review-contracts.js";
import {
  reducePublication,
  type PublicationPlan,
} from "../domain/publication.js";
import {
  REVIEWER_REGISTRY,
  selectReviewers,
  type ReviewerDefinition,
} from "../domain/reviewers.js";
import { projectSnapshot } from "../domain/snapshot.js";
import type {
  CapturedPullRequestSnapshot,
  PersistedPullRequestSnapshot,
} from "../domain/snapshot.js";
import type { RunId, UsdMicros } from "../domain/ids.js";
import { usdMicros } from "../domain/ids.js";
import type {
  QueuedRun,
  ReviewPlan,
  SqliteRunStore,
  WorkLease,
} from "../storage/run-store.js";

type SandboxHandle = Readonly<{ id: string; estimatedCost?: UsdMicros }>;

export const PUBLICATION_LEASE_DURATION_MS = 30 * 60_000;

export type DurableReviewEnginePorts = Readonly<{
  github: Readonly<{
    snapshot: (run: QueuedRun) => Promise<CapturedPullRequestSnapshot>;
    priorStableIdentities: (run: QueuedRun) => Promise<readonly string[]>;
    findExisting: (
      run: QueuedRun,
    ) => Promise<Readonly<{ reviewId: number }> | null>;
    publish: (
      run: QueuedRun,
      plan: Extract<PublicationPlan, { kind: "publish" }>,
    ) => Promise<Readonly<{ reviewId: number }>>;
  }>;
  sandbox: ReviewSandboxPort &
    Readonly<{
      resume: (
        input: ReviewRunInput,
        handle: Readonly<{ id: string }>,
      ) => Promise<SandboxHandle>;
      find: (
        input: ReviewRunInput,
        name: string,
      ) => Promise<SandboxHandle | null>;
    }>;
  model: ReviewModelPort;
  audit?: (event: Readonly<Record<string, unknown>>) => void;
}>;

export class DurableReviewEngine {
  readonly #store: SqliteRunStore;
  readonly #ports: DurableReviewEnginePorts;
  readonly #clock: () => number;
  readonly #publicationLeaseDurationMs: number;

  public constructor(
    options: Readonly<{
      store: SqliteRunStore;
      ports: DurableReviewEnginePorts;
      clock?: () => number;
      publicationLeaseDurationMs?: number;
    }>,
  ) {
    this.#store = options.store;
    this.#ports = options.ports;
    this.#clock = options.clock ?? Date.now;
    this.#publicationLeaseDurationMs =
      options.publicationLeaseDurationMs ?? PUBLICATION_LEASE_DURATION_MS;
    if (
      !Number.isSafeInteger(this.#publicationLeaseDurationMs) ||
      this.#publicationLeaseDurationMs <= 0
    )
      throw new Error("publicationLeaseDurationMs must be a positive integer");
  }

  public async advance(lease: WorkLease): Promise<void> {
    this.#fence(lease);
    if (
      lease.kind !== "cleanup" &&
      this.#store.isCancellationRequested(lease.runId)
    ) {
      this.#store.completeWork({
        lease,
        nowMs: this.#clock(),
        nextState: "cleaning_up",
        nextWork: { kind: "cleanup", key: `${lease.runId}:cleanup` },
      });
      return;
    }
    switch (lease.kind) {
      case "snapshot":
        await this.#snapshot(lease);
        return;
      case "plan":
        await this.#plan(lease);
        return;
      case "prepare_sailbox":
        await this.#prepareSailbox(lease);
        return;
      case "review":
        await this.#review(lease);
        return;
      case "challenge":
        await this.#challenge(lease);
        return;
      case "reduce":
        await this.#reduce(lease);
        return;
      case "publish":
        await this.#publish(lease);
        return;
      case "cleanup":
        await this.#cleanup(lease);
        return;
      default: {
        const exhaustive: never = lease.kind;
        return exhaustive;
      }
    }
  }

  async #snapshot(lease: WorkLease): Promise<void> {
    const run = this.#store.getRun(lease.runId);
    if (this.#store.getSnapshot(run.runId) === null) {
      const snapshot = await this.#ports.github.snapshot(run);
      this.#fence(lease);
      this.#store.putSnapshotOnce({
        runId: run.runId,
        snapshot,
        capturedAtMs: this.#clock(),
      });
    }
    this.#advanceTo(lease, "planning", "plan");
  }

  async #plan(lease: WorkLease): Promise<void> {
    const run = this.#store.getRun(lease.runId);
    const snapshot = this.#requireSnapshot(run.runId);
    if (this.#store.getReviewPlan(run.runId) === null) {
      const projection = projectSnapshot(snapshot);
      const optional = [
        /(?:^|\/)tests?\//i.test(projection.text) ||
        /\.(?:test|spec)\./i.test(projection.text)
          ? "test-quality"
          : undefined,
        /\b(?:mutex|lock|atomic|concurr|parallel|worker|queue|transaction)\b/i.test(
          projection.text,
        )
          ? "concurrency"
          : undefined,
      ].filter((value): value is string => value !== undefined);
      const reviewers = selectReviewers(optional);
      const reservation = this.#store.reserveBudget({
        runId: run.runId,
        key: "worst-case-run",
        amount: estimateWorstCaseRunCost(reviewers.length),
        createdAtMs: this.#clock(),
      });
      if (reservation.kind === "denied")
        throw new Error("Run budget reservation denied");
      const priorStableIdentities =
        await this.#ports.github.priorStableIdentities(run);
      this.#fence(lease);
      this.#store.putReviewPlanOnce({
        runId: run.runId,
        plan: {
          selectedReviewers: reviewers.map((reviewer) => reviewer.id),
          priorStableIdentities,
        },
        createdAtMs: this.#clock(),
      });
    }
    this.#advanceTo(lease, "preparing_sailbox", "prepare_sailbox");
  }

  async #prepareSailbox(lease: WorkLease): Promise<void> {
    await this.#ensureSandbox(lease);
    this.#advanceTo(lease, "reviewing", "review");
  }

  async #review(lease: WorkLease): Promise<void> {
    const input = this.#reviewInput(lease.runId);
    const plan = this.#requirePlan(lease.runId);
    const completed = new Set(
      this.#store
        .getReviewerReports(lease.runId)
        .map((report) => report.reviewer),
    );
    const handle = await this.#ensureSandbox(lease);
    let operationError: unknown;
    try {
      for (const reviewer of reviewerDefinitions(plan)) {
        if (completed.has(reviewer.id)) continue;
        const evidence =
          this.#ports.sandbox.evidence === undefined
            ? []
            : await this.#ports.sandbox.evidence(handle, reviewer.id);
        this.#fence(lease);
        const result = await this.#ports.model.review({
          runId: lease.runId,
          reviewer: reviewer.id,
          label: reviewer.label,
          question: reviewer.question,
          snapshot: input.snapshotText,
          toolEvidence: evidence,
        });
        this.#fence(lease);
        this.#store.putReviewerReportOnce({
          runId: lease.runId,
          report: result.report,
          cost: result.cost,
          createdAtMs: this.#clock(),
        });
        this.#audit({
          kind: "reviewer_checkpointed",
          runId: lease.runId,
          reviewer: reviewer.id,
        });
      }
    } catch (error: unknown) {
      operationError = error;
    }
    try {
      await this.#terminateSandbox(lease, handle);
    } catch (cleanupError: unknown) {
      if (operationError === undefined) throw asError(cleanupError);
      this.#audit({
        kind: "sailbox_cleanup_failed",
        runId: lease.runId,
        error: errorMessage(cleanupError),
      });
    }
    if (operationError !== undefined) throw asError(operationError);
    this.#advanceTo(lease, "challenging", "challenge");
  }

  async #challenge(lease: WorkLease): Promise<void> {
    const input = this.#reviewInput(lease.runId);
    const reports = this.#store.getReviewerReports(lease.runId);
    const completed = new Set(
      this.#store
        .getChallenges(lease.runId)
        .map((verdict) => verdict.findingId),
    );
    for (const finding of reports.flatMap((report) => report.findings)) {
      if (completed.has(finding.id)) continue;
      const result = await this.#ports.model.challenge({
        runId: lease.runId,
        finding,
        snapshot: input.snapshotText,
        toolEvidence: [],
      });
      this.#fence(lease);
      this.#store.putChallengeOnce({
        runId: lease.runId,
        verdict: result.verdict,
        cost: result.cost,
        createdAtMs: this.#clock(),
      });
      this.#audit({
        kind: "challenge_checkpointed",
        runId: lease.runId,
        findingId: finding.id,
      });
    }
    this.#advanceTo(lease, "reducing", "reduce");
  }

  async #reduce(lease: WorkLease): Promise<void> {
    const snapshot = this.#requireSnapshot(lease.runId);
    if (this.#store.getReviewSummary(lease.runId) === null) {
      const result = await this.#ports.model.summarize({
        runId: lease.runId,
        reports: this.#store.getReviewerReports(lease.runId),
        challenges: this.#store.getChallenges(lease.runId),
        coverageOmissions: projectSnapshot(snapshot).coverageOmissions,
      });
      this.#fence(lease);
      this.#store.putReviewSummaryOnce({
        runId: lease.runId,
        summary: result.summary,
        cost: result.cost,
        createdAtMs: this.#clock(),
      });
    }
    this.#advanceTo(lease, "publishing", "publish");
  }

  async #publish(lease: WorkLease): Promise<void> {
    const run = this.#store.getRun(lease.runId);
    const existingReceipt = this.#store.getPublication(lease.runId);
    if (existingReceipt?.reviewId === null || existingReceipt === null) {
      const plan = this.#publicationPlan(run);
      const bodyDigest = createHash("sha256").update(plan.body).digest("hex");
      this.#store.beginPublication({
        lease,
        runId: run.runId,
        key: `${run.runId}:github-review`,
        bodyDigest,
        createdAtMs: this.#clock(),
      });
      const existing = await this.#ports.github.findExisting(run);
      this.#fence(lease);
      let publication = existing;
      if (publication === null) {
        this.#store.heartbeatWork({
          lease,
          nowMs: this.#clock(),
          leaseDurationMs: this.#publicationLeaseDurationMs,
        });
        this.#fence(lease);
        publication = await this.#ports.github.publish(run, plan);
      }
      this.#fence(lease);
      this.#store.recordPublicationSubmitted({
        lease,
        runId: run.runId,
        reviewId: publication.reviewId,
        submittedAtMs: this.#clock(),
      });
    }
    this.#advanceTo(lease, "cleaning_up", "cleanup");
  }

  async #cleanup(lease: WorkLease): Promise<void> {
    const sandbox = this.#store.getSailbox(lease.runId);
    if (sandbox !== null && sandbox.status !== "terminated") {
      const input = this.#reviewInput(lease.runId);
      const handle =
        sandbox.status === "active" && sandbox.id !== null
          ? await this.#ports.sandbox.resume(input, { id: sandbox.id })
          : await this.#ports.sandbox.find(input, sandbox.name);
      if (handle === null)
        throw new Error(
          `Pending Sailbox ${sandbox.name} could not be reconciled for cleanup`,
        );
      this.#fence(lease);
      if (sandbox.status === "creating") {
        this.#store.recordSailboxCreated({
          runId: lease.runId,
          id: handle.id,
          estimatedCost: handle.estimatedCost ?? usdMicros(0),
          createdAtMs: this.#clock(),
        });
        this.#audit({
          kind: "sailbox_reconciled",
          runId: lease.runId,
          sailboxId: handle.id,
        });
      }
      await this.#terminateSandbox(lease, handle);
    }
    const progress = this.#store.getRunProgress(lease.runId);
    if (progress.terminalFailureReason === null) {
      const actualCost = this.#store.getActualCost(lease.runId);
      this.#store.settleBudget({
        runId: lease.runId,
        key: "worst-case-run",
        actualAmount: actualCost,
        settledAtMs: this.#clock(),
      });
      this.#store.completeWork({
        lease,
        nowMs: this.#clock(),
        nextState: "completed",
      });
    } else {
      this.#store.completeWork({
        lease,
        nowMs: this.#clock(),
        nextState: "failed",
      });
    }
  }

  #publicationPlan(
    run: QueuedRun,
  ): Extract<PublicationPlan, { kind: "publish" }> {
    const snapshot = this.#requireSnapshot(run.runId);
    const projection = projectSnapshot(snapshot);
    const plan = this.#requirePlan(run.runId);
    const summary = this.#store.getReviewSummary(run.runId);
    if (summary === null) throw new Error("Review summary is missing");
    const publication = reducePublication({
      runId: run.runId,
      headSha: run.headSha,
      selectedReviewers: plan.selectedReviewers,
      reports: this.#store.getReviewerReports(run.runId),
      challenges: this.#store.getChallenges(run.runId),
      changedLines: projection.changedLines,
      priorStableIdentities: plan.priorStableIdentities,
      coverageOmissions: projection.coverageOmissions,
      estimatedCost: this.#store.getActualCost(run.runId),
      durationMs: Math.max(
        0,
        this.#store.getReviewSummaryCreatedAt(run.runId) -
          this.#store.getRunCreatedAt(run.runId),
      ),
      reviewSummary: summary,
    });
    if (publication.kind !== "publish")
      throw new Error(`Publication refused: ${publication.reason}`);
    return publication;
  }

  async #ensureSandbox(lease: WorkLease): Promise<SandboxHandle> {
    const targetRunId = lease.runId;
    const input = this.#reviewInput(targetRunId);
    const existing = this.#store.getSailbox(targetRunId);
    if (existing?.status === "active" && existing.id !== null) {
      const resumed = await this.#ports.sandbox.resume(input, {
        id: existing.id,
      });
      this.#fence(lease);
      return resumed;
    }
    const name = sailboxName(targetRunId);
    this.#store.beginSailbox({
      runId: targetRunId,
      name,
      createdAtMs: this.#clock(),
    });
    const reconciled =
      existing?.status === "creating"
        ? await this.#ports.sandbox.find(input, name)
        : null;
    const handle = reconciled ?? (await this.#ports.sandbox.prepare(input));
    this.#fence(lease);
    this.#store.recordSailboxCreated({
      runId: targetRunId,
      id: handle.id,
      estimatedCost: handle.estimatedCost ?? usdMicros(0),
      createdAtMs: this.#clock(),
    });
    this.#audit({
      kind: reconciled === null ? "sailbox_checkpointed" : "sailbox_reconciled",
      runId: targetRunId,
      sailboxId: handle.id,
    });
    return handle;
  }

  async #terminateSandbox(
    lease: WorkLease,
    handle: SandboxHandle,
  ): Promise<void> {
    this.#fence(lease);
    await this.#ports.sandbox.terminate(handle);
    this.#fence(lease);
    this.#store.recordSailboxTerminated({
      runId: lease.runId,
      id: handle.id,
      terminatedAtMs: this.#clock(),
    });
    this.#audit({
      kind: "sailbox_termination_checkpointed",
      runId: lease.runId,
      sailboxId: handle.id,
    });
  }

  #reviewInput(targetRunId: RunId): ReviewRunInput {
    const run = this.#store.getRun(targetRunId);
    const snapshot = this.#requireSnapshot(targetRunId);
    const projection = projectSnapshot(snapshot);
    const plan = this.#requirePlan(targetRunId);
    return {
      runId: run.runId,
      owner: run.owner,
      repository: run.repository,
      pullNumber: run.pullNumber,
      baseSha: run.baseSha,
      mergeBaseSha: snapshot.mergeBaseSha,
      headSha: run.headSha,
      snapshotText: projection.text,
      changedLines: projection.changedLines,
      priorStableIdentities: plan.priorStableIdentities,
      coverageOmissions: projection.coverageOmissions,
      reviewers: reviewerDefinitions(plan),
    };
  }

  #requireSnapshot(targetRunId: RunId): PersistedPullRequestSnapshot {
    const snapshot = this.#store.getSnapshot(targetRunId);
    if (snapshot === null) throw new Error("Persisted snapshot is missing");
    return snapshot;
  }

  #requirePlan(targetRunId: RunId): ReviewPlan {
    const plan = this.#store.getReviewPlan(targetRunId);
    if (plan === null) throw new Error("Persisted review plan is missing");
    return plan;
  }

  #advanceTo(
    lease: WorkLease,
    nextState:
      | "planning"
      | "preparing_sailbox"
      | "reviewing"
      | "challenging"
      | "reducing"
      | "publishing"
      | "cleaning_up",
    nextKind:
      | "plan"
      | "prepare_sailbox"
      | "review"
      | "challenge"
      | "reduce"
      | "publish"
      | "cleanup",
  ): void {
    this.#store.completeWork({
      lease,
      nowMs: this.#clock(),
      nextState,
      nextWork: { kind: nextKind, key: `${lease.runId}:${nextKind}` },
    });
  }

  #audit(
    event: Readonly<{ kind: string; runId: RunId } & Record<string, unknown>>,
  ): void {
    const { kind, runId: targetRunId, ...payload } = event;
    this.#store.appendRunEvent({
      runId: targetRunId,
      kind,
      payload,
      createdAtMs: this.#clock(),
    });
    this.#ports.audit?.(event);
  }

  #fence(lease: WorkLease): void {
    this.#store.assertWorkLease({ lease, nowMs: this.#clock() });
  }
}

const reviewerDefinitions = (plan: ReviewPlan): readonly ReviewerDefinition[] =>
  plan.selectedReviewers.map((selected) => {
    const definition = REVIEWER_REGISTRY.find(
      (candidate) => candidate.id === selected,
    );
    if (definition === undefined)
      throw new Error(`Unknown reviewer in persisted plan: ${selected}`);
    return definition;
  });

const sailboxName = (targetRunId: RunId): string =>
  `gauntlet-${targetRunId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48)}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(errorMessage(error));
