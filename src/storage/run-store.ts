import type Database from "better-sqlite3";
import { z } from "zod";
import { BUDGET_LIMIT } from "../domain/budget.js";
import {
  challengeVerdictSchema,
  findingSchema,
  reviewerReportSchema,
  reviewSummarySchema,
} from "../domain/schemas.js";
import type {
  ChallengeVerdict,
  ReviewerReport,
  ReviewSummary,
} from "../domain/types.js";
import {
  commitSha,
  deliveryId,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  usdMicros,
  workerId,
  reviewerId,
  type RunId,
  type UsdMicros,
  type WorkerId,
  type ReviewerId,
  type FindingId,
} from "../domain/ids.js";
import {
  capturedPullRequestSnapshotSchema,
  persistedPullRequestSnapshotSchema,
  sameCapturedSnapshot,
  snapshotFileSchema,
  type CapturedPullRequestSnapshot,
  type PersistedPullRequestSnapshot,
} from "../domain/snapshot.js";

const acceptRunRequestSchema = z
  .object({
    deliveryId: z.unknown().transform(deliveryId),
    runId: z.unknown().transform(runId),
    installationId: z.unknown().transform(installationId),
    repositoryId: z.unknown().transform(repositoryId),
    pullNumber: z.unknown().transform(pullNumber),
    owner: z.string().trim().min(1).max(255),
    repository: z.string().trim().min(1).max(255),
    baseSha: z.unknown().transform(commitSha),
    headSha: z.unknown().transform(commitSha),
    receivedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const runReferenceRowSchema = z
  .object({ run_id: z.string().min(1) })
  .transform((row) => runId(row.run_id));
const reservationRowSchema = z.object({
  reserved_micros: z.number().int().nonnegative(),
});
const totalRowSchema = z.object({ total: z.number().int().nonnegative() });
const ineligibleReasonSchema = z.enum([
  "unsupported_action",
  "private_repository",
  "draft_pull_request",
  "bot_authored_pull_request",
  "malformed_payload",
]);
const deliveryEligibilityRowSchema = z.object({
  redacted_reason: ineligibleReasonSchema.nullable(),
});
const snapshotHeaderRowSchema = z.object({
  run_id: z.string(),
  installation_id: z.number().int().positive(),
  repository_id: z.number().int().positive(),
  pull_number: z.number().int().positive(),
  owner: z.string().min(1),
  repository_name: z.string().min(1),
  base_sha: z.string(),
  head_sha: z.string(),
  merge_base_sha: z.string(),
  coverage_omissions_json: z.string(),
  created_at_ms: z.number().int().nonnegative(),
});
const snapshotFileRowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  file_kind: z.enum(["reviewable", "omitted"]),
  path: z.string(),
  status: z.string(),
  changed_lines_json: z.string(),
  patch: z.string().nullable(),
  omission_reason: z.string().nullable(),
});
const queuedRunRowSchema = z
  .object({
    run_id: z.string(),
    installation_id: z.number().int().positive(),
    repository_id: z.number().int().positive(),
    pull_number: z.number().int().positive(),
    owner: z.string().min(1),
    repository_name: z.string().min(1),
    base_sha: z.string(),
    head_sha: z.string(),
  })
  .transform((row) => ({
    runId: runId(row.run_id),
    installationId: installationId(row.installation_id),
    repositoryId: repositoryId(row.repository_id),
    pullNumber: pullNumber(row.pull_number),
    owner: row.owner,
    repository: row.repository_name,
    baseSha: commitSha(row.base_sha),
    headSha: commitSha(row.head_sha),
  }));

const workKindSchema = z.enum([
  "snapshot",
  "plan",
  "prepare_sailbox",
  "review",
  "challenge",
  "reduce",
  "publish",
  "cleanup",
]);
const runStateSchema = z.enum([
  "accepted",
  "snapshotting",
  "planning",
  "preparing_sailbox",
  "reviewing",
  "challenging",
  "reducing",
  "publishing",
  "cleaning_up",
  "completed",
  "failed",
]);
const workLeaseRowSchema = z
  .object({
    work_key: z.string().min(1),
    run_id: z.string().min(1),
    kind: workKindSchema,
    owner: z.string().min(1),
    lease_expires_at_ms: z.number().int(),
    attempt: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
  })
  .transform((row) => ({
    workKey: row.work_key,
    runId: runId(row.run_id),
    kind: row.kind,
    workerId: workerId(row.owner),
    expiresAtMs: row.lease_expires_at_ms,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
  }));
const pendingWorkRowSchema = z
  .object({
    work_key: z.string(),
    kind: workKindSchema,
    attempt: z.number().int().nonnegative(),
  })
  .transform((row) => ({
    key: row.work_key,
    kind: row.kind,
    attempt: row.attempt,
  }));
const reviewerReportRowSchema = z.object({ report_json: z.string() });
const challengeRowSchema = z.object({
  finding_json: z.string(),
  outcome: z.enum(["confirmed", "rejected", "inconclusive", "failed"]),
  reason: z.string(),
});
const persistedChallengeRowSchema = z.object({
  outcome: z.enum(["confirmed", "rejected", "inconclusive", "failed"]),
  reason: z.string(),
});
const reviewPlanRowSchema = z.object({
  selected_reviewers_json: z.string(),
  prior_stable_identities_json: z.string(),
});
const reviewSummaryRowSchema = z.object({ summary_json: z.string() });
const sailboxRowSchema = z
  .object({
    sailbox_id: z.string(),
    sailbox_name: z.string().nullable(),
    status: z.enum(["creating", "active", "terminated"]),
    estimated_cost_micros: z.number().int().nonnegative(),
  })
  .transform((row) => ({
    id: row.sailbox_id.startsWith("pending:") ? null : row.sailbox_id,
    name: row.sailbox_name ?? row.sailbox_id,
    status: row.status,
    estimatedCost: usdMicros(row.estimated_cost_micros),
  }));
const publicationRowSchema = z
  .object({
    publication_key: z.string(),
    github_review_id: z.number().int().positive().nullable(),
    body_digest: z.string(),
  })
  .transform((row) => ({
    key: row.publication_key,
    reviewId: row.github_review_id,
    bodyDigest: row.body_digest,
  }));

export type WorkKind = z.infer<typeof workKindSchema>;
export type WorkLease = z.infer<typeof workLeaseRowSchema>;
export type ReviewPlan = Readonly<{
  selectedReviewers: readonly ReviewerId[];
  priorStableIdentities: readonly string[];
}>;

export type AcceptRunResult =
  | Readonly<{ kind: "created"; runId: RunId }>
  | Readonly<{ kind: "duplicate_delivery"; runId: RunId }>
  | Readonly<{ kind: "existing_target"; runId: RunId }>;

export type QueuedRun = z.infer<typeof queuedRunRowSchema>;

export type ReserveBudgetResult =
  | Readonly<{ kind: "reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "already_reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "denied"; available: UsdMicros }>;

export type IneligibleDeliveryReason = z.infer<typeof ineligibleReasonSchema>;
export type RecordIneligibleDeliveryResult = Readonly<{
  kind: "recorded" | "duplicate_delivery";
  reason: IneligibleDeliveryReason;
}>;

export class SqliteRunStore {
  readonly #database: Database.Database;

  public constructor(database: Database.Database) {
    this.#database = database;
  }

  public acceptRun(rawRequest: unknown): AcceptRunResult {
    const request = acceptRunRequestSchema.parse(rawRequest);
    return this.#database.transaction(() => {
      const delivery = this.#database
        .prepare("SELECT run_id FROM webhook_deliveries WHERE delivery_id = ?")
        .get(request.deliveryId);
      if (delivery !== undefined) {
        return {
          kind: "duplicate_delivery",
          runId: runReferenceRowSchema.parse(delivery),
        } satisfies AcceptRunResult;
      }

      const target = this.#database
        .prepare(
          "SELECT run_id FROM review_runs WHERE installation_id = ? AND repository_id = ? AND pull_number = ? AND head_sha = ?",
        )
        .get(
          request.installationId,
          request.repositoryId,
          request.pullNumber,
          request.headSha,
        );
      if (target !== undefined) {
        const existingRunId = runReferenceRowSchema.parse(target);
        this.#insertDelivery({
          deliveryId: request.deliveryId,
          runId: existingRunId,
          receivedAtMs: request.receivedAtMs,
        });
        return {
          kind: "existing_target",
          runId: existingRunId,
        } satisfies AcceptRunResult;
      }

      this.#database
        .prepare(
          `INSERT INTO review_runs (
            run_id, installation_id, repository_id, pull_number, owner, repository_name,
            base_sha, head_sha, state, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(
          request.runId,
          request.installationId,
          request.repositoryId,
          request.pullNumber,
          request.owner,
          request.repository,
          request.baseSha,
          request.headSha,
          request.receivedAtMs,
        );
      this.#insertDelivery({
        deliveryId: request.deliveryId,
        runId: request.runId,
        receivedAtMs: request.receivedAtMs,
      });
      this.#insertWork({
        key: `${request.runId}:snapshot`,
        runId: request.runId,
        kind: "snapshot",
        createdAtMs: request.receivedAtMs,
      });
      return {
        kind: "created",
        runId: request.runId,
      } satisfies AcceptRunResult;
    })();
  }

  public countRuns(): number {
    const parsed = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        this.#database
          .prepare("SELECT COUNT(*) AS count FROM review_runs")
          .get(),
      );
    return parsed.count;
  }

  public recordIneligibleDelivery(
    rawRequest: Readonly<{
      deliveryId: unknown;
      reason: unknown;
      receivedAtMs: number;
    }>,
  ): RecordIneligibleDeliveryResult {
    const request = z
      .object({
        deliveryId: z.unknown().transform(deliveryId),
        reason: ineligibleReasonSchema,
        receivedAtMs: z.number().int().nonnegative(),
      })
      .strict()
      .parse(rawRequest);
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          "SELECT redacted_reason FROM webhook_deliveries WHERE delivery_id = ?",
        )
        .get(request.deliveryId);
      if (existing !== undefined) {
        const row = deliveryEligibilityRowSchema.parse(existing);
        if (row.redacted_reason === null)
          throw new Error("Delivery was already accepted");
        return {
          kind: "duplicate_delivery",
          reason: row.redacted_reason,
        } satisfies RecordIneligibleDeliveryResult;
      }
      this.#database
        .prepare(
          `INSERT INTO webhook_deliveries (
             delivery_id, run_id, eligibility, redacted_reason, received_at_ms
           ) VALUES (?, NULL, 'rejected', ?, ?)`,
        )
        .run(request.deliveryId, request.reason, request.receivedAtMs);
      return {
        kind: "recorded",
        reason: request.reason,
      } satisfies RecordIneligibleDeliveryResult;
    })();
  }

  public getRun(targetRunId: RunId): QueuedRun {
    const row = this.#database
      .prepare(
        `SELECT run_id, installation_id, repository_id, pull_number, owner,
                repository_name, base_sha, head_sha
         FROM review_runs WHERE run_id = ?`,
      )
      .get(targetRunId);
    if (row === undefined) throw new Error("Run not found");
    return queuedRunRowSchema.parse(row);
  }

  public getRunCreatedAt(targetRunId: RunId): number {
    return z
      .object({ created_at_ms: z.number().int().nonnegative() })
      .parse(
        this.#database
          .prepare("SELECT created_at_ms FROM review_runs WHERE run_id = ?")
          .get(targetRunId),
      ).created_at_ms;
  }

  public getSnapshot(targetRunId: RunId): PersistedPullRequestSnapshot | null {
    const rawHeader = this.#database
      .prepare(
        `SELECT r.run_id, r.installation_id, r.repository_id, r.pull_number,
                r.owner, r.repository_name, s.base_sha, s.head_sha,
                s.merge_base_sha, s.coverage_omissions_json, s.created_at_ms
         FROM snapshots s
         JOIN review_runs r ON r.run_id = s.run_id
         WHERE s.run_id = ?`,
      )
      .get(targetRunId);
    if (rawHeader === undefined) return null;
    const header = snapshotHeaderRowSchema.parse(rawHeader);
    const rawFiles = this.#database
      .prepare(
        `SELECT ordinal, file_kind, path, status, changed_lines_json, patch,
                omission_reason
         FROM snapshot_files WHERE run_id = ? ORDER BY ordinal`,
      )
      .all(targetRunId);
    const files = rawFiles.map((rawFile) => {
      const file = snapshotFileRowSchema.parse(rawFile);
      if (file.file_kind === "reviewable") {
        if (file.patch === null || file.omission_reason !== null)
          throw new Error("Invalid persisted reviewable snapshot file");
        return snapshotFileSchema.parse({
          ordinal: file.ordinal,
          kind: "reviewable",
          path: file.path,
          status: file.status,
          patch: file.patch,
          changedLines: parseJson(file.changed_lines_json),
        });
      }
      if (file.patch !== null || file.omission_reason !== "patch_unavailable")
        throw new Error("Invalid persisted omitted snapshot file");
      return snapshotFileSchema.parse({
        ordinal: file.ordinal,
        kind: "omitted",
        path: file.path,
        status: file.status,
        reason: file.omission_reason,
      });
    });
    return persistedPullRequestSnapshotSchema.parse({
      persisted: true,
      runId: header.run_id,
      installationId: header.installation_id,
      repositoryId: header.repository_id,
      pullNumber: header.pull_number,
      owner: header.owner,
      repository: header.repository_name,
      baseSha: header.base_sha,
      headSha: header.head_sha,
      mergeBaseSha: header.merge_base_sha,
      files,
      coverageOmissions: parseJson(header.coverage_omissions_json),
      capturedAtMs: header.created_at_ms,
    });
  }

  public putSnapshotOnce(
    request: Readonly<{
      runId: RunId;
      snapshot: CapturedPullRequestSnapshot;
      capturedAtMs: number;
    }>,
  ): PersistedPullRequestSnapshot {
    const snapshot = capturedPullRequestSnapshotSchema.parse(request.snapshot);
    if (!Number.isSafeInteger(request.capturedAtMs) || request.capturedAtMs < 0)
      throw new Error("Invalid snapshot capture time");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getSnapshot(request.runId);
      if (existing !== null) {
        const stored: CapturedPullRequestSnapshot = {
          formatVersion: 1,
          mergeBaseSha: existing.mergeBaseSha,
          files: [...existing.files],
          coverageOmissions: [...existing.coverageOmissions],
        };
        if (!sameCapturedSnapshot(stored, snapshot))
          throw new Error("Snapshot conflict for existing run");
        this.#database.exec("COMMIT");
        return existing;
      }
      const target = this.getRun(request.runId);
      this.#database
        .prepare(
          `INSERT INTO snapshots (
             run_id, base_sha, head_sha, merge_base_sha,
             coverage_omissions_json, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.runId,
          target.baseSha,
          target.headSha,
          snapshot.mergeBaseSha,
          JSON.stringify(snapshot.coverageOmissions),
          request.capturedAtMs,
        );
      const insertFile = this.#database.prepare(
        `INSERT INTO snapshot_files (
           run_id, path, status, changed_lines_json, patch, context_text,
           omission_reason, ordinal, file_kind
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      );
      for (const file of snapshot.files) {
        insertFile.run(
          request.runId,
          file.path,
          file.status,
          JSON.stringify(file.kind === "reviewable" ? file.changedLines : []),
          file.kind === "reviewable" ? file.patch : null,
          file.kind === "omitted" ? file.reason : null,
          file.ordinal,
          file.kind,
        );
      }
      const persisted = this.getSnapshot(request.runId);
      if (persisted === null) throw new Error("Snapshot commit failed");
      this.#database.exec("COMMIT");
      return persisted;
    } catch (error: unknown) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public putReviewPlanOnce(
    request: Readonly<{
      runId: RunId;
      plan: ReviewPlan;
      createdAtMs: number;
    }>,
  ): ReviewPlan {
    const plan = parseReviewPlan(request.plan);
    return this.#database.transaction(() => {
      const existing = this.getReviewPlan(request.runId);
      if (existing !== null) {
        if (JSON.stringify(existing) !== JSON.stringify(plan))
          throw new Error("Review plan conflict for existing checkpoint");
        return existing;
      }
      this.#database
        .prepare(
          `INSERT INTO review_plans
             (run_id, selected_reviewers_json, prior_stable_identities_json, created_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          request.runId,
          JSON.stringify(plan.selectedReviewers),
          JSON.stringify(plan.priorStableIdentities),
          request.createdAtMs,
        );
      return plan;
    })();
  }

  public getReviewPlan(targetRunId: RunId): ReviewPlan | null {
    const raw = this.#database
      .prepare(
        `SELECT selected_reviewers_json, prior_stable_identities_json
         FROM review_plans WHERE run_id = ?`,
      )
      .get(targetRunId);
    if (raw === undefined) return null;
    const row = reviewPlanRowSchema.parse(raw);
    return parseReviewPlan({
      selectedReviewers: parseJson(row.selected_reviewers_json),
      priorStableIdentities: parseJson(row.prior_stable_identities_json),
    });
  }

  public putReviewSummaryOnce(
    request: Readonly<{
      runId: RunId;
      summary: ReviewSummary;
      cost: UsdMicros;
      createdAtMs: number;
    }>,
  ): ReviewSummary {
    const summary = reviewSummarySchema.parse(request.summary);
    const existing = this.getReviewSummary(request.runId);
    if (existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(summary))
        throw new Error("Review summary conflict for existing checkpoint");
      return existing;
    }
    this.#database
      .prepare(
        `INSERT INTO review_summaries
           (run_id, summary_json, cost_micros, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        request.runId,
        JSON.stringify(summary),
        request.cost,
        request.createdAtMs,
      );
    return summary;
  }

  public getReviewSummary(targetRunId: RunId): ReviewSummary | null {
    const raw = this.#database
      .prepare("SELECT summary_json FROM review_summaries WHERE run_id = ?")
      .get(targetRunId);
    if (raw === undefined) return null;
    return reviewSummarySchema.parse(
      parseJson(reviewSummaryRowSchema.parse(raw).summary_json),
    );
  }

  public getReviewSummaryCreatedAt(targetRunId: RunId): number {
    return z
      .object({ created_at_ms: z.number().int().nonnegative() })
      .parse(
        this.#database
          .prepare(
            "SELECT created_at_ms FROM review_summaries WHERE run_id = ?",
          )
          .get(targetRunId),
      ).created_at_ms;
  }

  public beginSailbox(
    request: Readonly<{
      runId: RunId;
      name: string;
      createdAtMs: number;
    }>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO sailboxes
           (run_id, sailbox_id, sailbox_name, status, creation_receipt_json,
            created_at_ms)
         VALUES (?, ?, ?, 'creating', '{}', ?)
         ON CONFLICT(run_id) DO UPDATE SET
           sailbox_id = excluded.sailbox_id,
           sailbox_name = excluded.sailbox_name,
           status = 'creating',
           creation_receipt_json = '{}',
           termination_receipt_json = NULL,
           created_at_ms = excluded.created_at_ms,
           terminated_at_ms = NULL
         WHERE sailboxes.status = 'terminated'`,
      )
      .run(
        request.runId,
        `pending:${request.runId}`,
        request.name,
        request.createdAtMs,
      );
  }

  public recordSailboxCreated(
    request: Readonly<{
      runId: RunId;
      id: string;
      estimatedCost: UsdMicros;
      createdAtMs: number;
    }>,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE sailboxes
         SET sailbox_id = ?, status = 'active',
             estimated_cost_micros = estimated_cost_micros + ?,
             creation_receipt_json = ?
         WHERE run_id = ? AND status IN ('creating', 'active')`,
      )
      .run(
        request.id,
        request.estimatedCost,
        JSON.stringify({
          sailboxId: request.id,
          createdAtMs: request.createdAtMs,
        }),
        request.runId,
      );
    if (changed.changes !== 1)
      throw new Error("Cannot record Sailbox creation without an intent");
  }

  public getSailbox(targetRunId: RunId): Readonly<{
    id: string | null;
    name: string;
    status: "creating" | "active" | "terminated";
    estimatedCost: UsdMicros;
  }> | null {
    const raw = this.#database
      .prepare(
        `SELECT sailbox_id, sailbox_name, status, estimated_cost_micros
         FROM sailboxes WHERE run_id = ?`,
      )
      .get(targetRunId);
    return raw === undefined ? null : sailboxRowSchema.parse(raw);
  }

  public recordSailboxTerminated(
    request: Readonly<{
      runId: RunId;
      id: string;
      terminatedAtMs: number;
    }>,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE sailboxes
         SET status = 'terminated', terminated_at_ms = ?,
             termination_receipt_json = ?
         WHERE run_id = ? AND sailbox_id = ?`,
      )
      .run(
        request.terminatedAtMs,
        JSON.stringify({
          sailboxId: request.id,
          terminatedAtMs: request.terminatedAtMs,
        }),
        request.runId,
        request.id,
      );
    if (changed.changes !== 1)
      throw new Error("Cannot record Sailbox termination");
  }

  public beginPublication(
    request: Readonly<{
      runId: RunId;
      key: string;
      bodyDigest: string;
      createdAtMs: number;
    }>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO publications
           (publication_key, run_id, body_digest, created_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(publication_key) DO NOTHING`,
      )
      .run(request.key, request.runId, request.bodyDigest, request.createdAtMs);
    const stored = this.getPublication(request.runId);
    if (stored?.bodyDigest !== request.bodyDigest)
      throw new Error("Publication intent conflict");
  }

  public recordPublicationSubmitted(
    request: Readonly<{
      runId: RunId;
      reviewId: number;
      submittedAtMs: number;
    }>,
  ): void {
    const changed = this.#database
      .prepare(
        `UPDATE publications
         SET github_review_id = ?, submitted_at_ms = ?, submit_result_json = ?
         WHERE run_id = ?
           AND (github_review_id IS NULL OR github_review_id = ?)`,
      )
      .run(
        request.reviewId,
        request.submittedAtMs,
        JSON.stringify({ reviewId: request.reviewId }),
        request.runId,
        request.reviewId,
      );
    if (changed.changes !== 1) throw new Error("Publication receipt conflict");
  }

  public getPublication(targetRunId: RunId): Readonly<{
    key: string;
    reviewId: number | null;
    bodyDigest: string;
  }> | null {
    const raw = this.#database
      .prepare(
        `SELECT publication_key, github_review_id, body_digest
         FROM publications WHERE run_id = ?`,
      )
      .get(targetRunId);
    return raw === undefined ? null : publicationRowSchema.parse(raw);
  }

  public getActualCost(targetRunId: RunId): UsdMicros {
    const row = z.object({ total: z.number().int().nonnegative() }).parse(
      this.#database
        .prepare(
          `SELECT
               COALESCE((SELECT SUM(cost_micros) FROM reviewer_reports WHERE run_id = ?), 0) +
               COALESCE((SELECT SUM(v.cost_micros) FROM challenge_verdicts v
                         JOIN findings f ON f.finding_id = v.finding_id
                         WHERE f.run_id = ?), 0) +
               COALESCE((SELECT SUM(cost_micros) FROM review_summaries WHERE run_id = ?), 0) +
               COALESCE((SELECT estimated_cost_micros FROM sailboxes WHERE run_id = ?), 0)
               AS total`,
        )
        .get(targetRunId, targetRunId, targetRunId, targetRunId),
    );
    return usdMicros(row.total);
  }

  public appendRunEvent(
    request: Readonly<{
      runId: RunId;
      kind: string;
      payload: Readonly<Record<string, unknown>>;
      createdAtMs: number;
    }>,
  ): void {
    if (request.kind.length === 0 || request.kind.length > 255)
      throw new Error("Invalid run event kind");
    this.#appendRunEvent(request);
  }

  public claimNextWork(
    request: Readonly<{
      workerId: WorkerId;
      nowMs: number;
      leaseDurationMs: number;
    }>,
  ): WorkLease | null {
    const expiresAtMs = request.nowMs + request.leaseDurationMs;
    if (!Number.isSafeInteger(expiresAtMs) || request.leaseDurationMs <= 0)
      throw new Error("Invalid work lease duration");
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `UPDATE work_items
         SET owner = ?, lease_expires_at_ms = ?, attempt = attempt + 1
         WHERE work_key = (
           SELECT work_key FROM work_items
           WHERE completed_at_ms IS NULL
             AND failed_at_ms IS NULL
             AND next_attempt_at_ms <= ?
             AND (owner IS NULL OR lease_expires_at_ms < ?)
           ORDER BY created_at_ms, work_key
           LIMIT 1
         )
         RETURNING work_key, run_id, kind, owner, lease_expires_at_ms,
                   attempt, max_attempts`,
        )
        .get(request.workerId, expiresAtMs, request.nowMs, request.nowMs);
      if (row === undefined) return null;
      const lease = workLeaseRowSchema.parse(row);
      const state = stateForWork(lease.kind);
      this.#database
        .prepare(
          "UPDATE review_runs SET state = ? WHERE run_id = ? AND state NOT IN ('completed', 'failed')",
        )
        .run(state, lease.runId);
      this.#appendRunEvent({
        runId: lease.runId,
        kind: "work_claimed",
        payload: {
          workKey: lease.workKey,
          workKind: lease.kind,
          attempt: lease.attempt,
        },
        createdAtMs: request.nowMs,
      });
      return lease;
    })();
  }

  public heartbeatWork(
    request: Readonly<{
      lease: WorkLease;
      nowMs: number;
      leaseDurationMs: number;
    }>,
  ): WorkLease {
    const expiresAtMs = request.nowMs + request.leaseDurationMs;
    if (!Number.isSafeInteger(expiresAtMs) || request.leaseDurationMs <= 0)
      throw new Error("Invalid work lease duration");
    const row = this.#database
      .prepare(
        `UPDATE work_items
         SET lease_expires_at_ms = ?
         WHERE work_key = ? AND owner = ? AND attempt = ?
           AND completed_at_ms IS NULL AND failed_at_ms IS NULL
         RETURNING work_key, run_id, kind, owner, lease_expires_at_ms,
                   attempt, max_attempts`,
      )
      .get(
        expiresAtMs,
        request.lease.workKey,
        request.lease.workerId,
        request.lease.attempt,
      );
    if (row === undefined)
      throw new Error("Cannot heartbeat work: lease owner does not match");
    return workLeaseRowSchema.parse(row);
  }

  public assertWorkLease(
    request: Readonly<{
      lease: WorkLease;
      nowMs: number;
    }>,
  ): void {
    const active = this.#database
      .prepare(
        `SELECT 1 FROM work_items
         WHERE work_key = ? AND owner = ? AND attempt = ?
           AND lease_expires_at_ms >= ?
           AND completed_at_ms IS NULL AND failed_at_ms IS NULL`,
      )
      .get(
        request.lease.workKey,
        request.lease.workerId,
        request.lease.attempt,
        request.nowMs,
      );
    if (active === undefined) throw new Error("Work lease is stale or expired");
  }

  public completeWork(
    request: Readonly<{
      lease: WorkLease;
      nowMs: number;
      nextState: z.infer<typeof runStateSchema>;
      nextWork?: Readonly<{ kind: WorkKind; key: string }>;
    }>,
  ): void {
    runStateSchema.parse(request.nextState);
    this.#database.transaction(() => {
      const completed = this.#database
        .prepare(
          `UPDATE work_items
           SET completed_at_ms = ?, owner = NULL, lease_expires_at_ms = NULL
           WHERE work_key = ? AND owner = ? AND attempt = ?
             AND completed_at_ms IS NULL AND failed_at_ms IS NULL`,
        )
        .run(
          request.nowMs,
          request.lease.workKey,
          request.lease.workerId,
          request.lease.attempt,
        );
      if (completed.changes !== 1)
        throw new Error("Cannot complete work: lease owner does not match");
      const cancellation = z
        .object({ cancel_reason: z.string().nullable() })
        .nullable()
        .parse(
          this.#database
            .prepare(
              `SELECT cancel_reason FROM review_runs
               WHERE run_id = ? AND cancel_requested_at_ms IS NOT NULL`,
            )
            .get(request.lease.runId) ?? null,
        );
      const cancelled =
        cancellation !== null && request.lease.kind !== "cleanup";
      const nextState = cancelled ? "cleaning_up" : request.nextState;
      const nextWork = cancelled
        ? ({
            kind: "cleanup",
            key: `${request.lease.runId}:cleanup`,
          } as const)
        : request.nextWork;
      if (cancelled)
        this.#database
          .prepare(
            "UPDATE review_runs SET terminal_failure_reason = ? WHERE run_id = ?",
          )
          .run(
            `cancelled: ${cancellation.cancel_reason ?? "operator request"}`.slice(
              0,
              2_000,
            ),
            request.lease.runId,
          );
      const terminal = nextState === "completed";
      const advanced = this.#database
        .prepare(
          `UPDATE review_runs
           SET state = ?, completed_at_ms = CASE WHEN ? THEN ? ELSE completed_at_ms END,
               failure_reason = CASE WHEN ? = 'failed' THEN terminal_failure_reason ELSE failure_reason END,
               lease_owner = NULL, lease_expires_at_ms = NULL
           WHERE run_id = ? AND state NOT IN ('completed', 'failed')`,
        )
        .run(
          nextState,
          terminal ? 1 : 0,
          request.nowMs,
          nextState,
          request.lease.runId,
        );
      if (advanced.changes !== 1)
        throw new Error("Cannot complete work for terminal run");
      if (nextWork !== undefined)
        this.#insertWork({
          key: nextWork.key,
          runId: request.lease.runId,
          kind: nextWork.kind,
          createdAtMs: request.nowMs,
        });
      this.#appendRunEvent({
        runId: request.lease.runId,
        kind: "work_completed",
        payload: {
          workKey: request.lease.workKey,
          nextState,
          nextWorkKey: nextWork?.key ?? null,
          cancelled,
        },
        createdAtMs: request.nowMs,
      });
    })();
  }

  public requestCancellation(
    request: Readonly<{
      runId: RunId;
      reason: string;
      requestedAtMs: number;
    }>,
  ): "requested" | "terminal" {
    const reason = request.reason.trim().slice(0, 2_000);
    if (reason.length === 0) throw new Error("Cancellation reason is required");
    return this.#database.transaction(() => {
      const changed = this.#database
        .prepare(
          `UPDATE review_runs
           SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
               cancel_reason = COALESCE(cancel_reason, ?)
           WHERE run_id = ? AND state NOT IN ('completed', 'failed')`,
        )
        .run(request.requestedAtMs, reason, request.runId);
      if (changed.changes === 0) return "terminal" as const;
      this.#appendRunEvent({
        runId: request.runId,
        kind: "cancellation_requested",
        payload: { reason },
        createdAtMs: request.requestedAtMs,
      });
      return "requested" as const;
    })();
  }

  public isCancellationRequested(targetRunId: RunId): boolean {
    return (
      z.object({ requested: z.number().int().min(0).max(1) }).parse(
        this.#database
          .prepare(
            `SELECT CASE WHEN cancel_requested_at_ms IS NULL THEN 0 ELSE 1 END AS requested
               FROM review_runs WHERE run_id = ?`,
          )
          .get(targetRunId),
      ).requested === 1
    );
  }

  public retryWork(
    request: Readonly<{
      lease: WorkLease;
      nowMs: number;
      retryAtMs: number;
      reason: string;
    }>,
  ): "retry_scheduled" | "dead_lettered" {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT attempt, max_attempts FROM work_items
           WHERE work_key = ? AND owner = ? AND attempt = ?
             AND completed_at_ms IS NULL AND failed_at_ms IS NULL`,
        )
        .get(
          request.lease.workKey,
          request.lease.workerId,
          request.lease.attempt,
        );
      const attempt = z
        .object({
          attempt: z.number().int().positive(),
          max_attempts: z.number().int().positive(),
        })
        .parse(row);
      const reason = request.reason.slice(0, 2_000);
      if (attempt.attempt < attempt.max_attempts) {
        this.#database
          .prepare(
            `UPDATE work_items
             SET owner = NULL, lease_expires_at_ms = NULL,
                 next_attempt_at_ms = ?, last_error = ?
             WHERE work_key = ?`,
          )
          .run(request.retryAtMs, reason, request.lease.workKey);
        this.#appendRunEvent({
          runId: request.lease.runId,
          kind: "work_retry_scheduled",
          payload: {
            workKey: request.lease.workKey,
            attempt: attempt.attempt,
            retryAtMs: request.retryAtMs,
          },
          createdAtMs: request.nowMs,
        });
        return "retry_scheduled" as const;
      }
      this.#database
        .prepare(
          `UPDATE work_items
           SET owner = NULL, lease_expires_at_ms = NULL, last_error = ?, failed_at_ms = ?
           WHERE work_key = ?`,
        )
        .run(reason, request.nowMs, request.lease.workKey);
      if (request.lease.kind === "cleanup") {
        this.#database
          .prepare(
            `UPDATE review_runs
             SET state = 'failed', failure_reason = ?, terminal_failure_reason = ?
             WHERE run_id = ?`,
          )
          .run(reason, reason, request.lease.runId);
      } else {
        this.#database
          .prepare(
            `UPDATE review_runs
             SET state = 'cleaning_up', terminal_failure_reason = ?
             WHERE run_id = ?`,
          )
          .run(reason, request.lease.runId);
        this.#insertWork({
          key: `${request.lease.runId}:cleanup`,
          runId: request.lease.runId,
          kind: "cleanup",
          createdAtMs: request.nowMs,
        });
      }
      this.#appendRunEvent({
        runId: request.lease.runId,
        kind: "work_dead_lettered",
        payload: {
          workKey: request.lease.workKey,
          attempt: attempt.attempt,
        },
        createdAtMs: request.nowMs,
      });
      return "dead_lettered" as const;
    })();
  }

  public getRunProgress(targetRunId: RunId): Readonly<{
    state: z.infer<typeof runStateSchema>;
    terminalFailureReason: string | null;
    pendingWork: readonly Readonly<{
      key: string;
      kind: WorkKind;
      attempt: number;
    }>[];
  }> {
    const run = z
      .object({
        state: runStateSchema,
        terminal_failure_reason: z.string().nullable(),
      })
      .parse(
        this.#database
          .prepare(
            "SELECT state, terminal_failure_reason FROM review_runs WHERE run_id = ?",
          )
          .get(targetRunId),
      );
    const pendingWork = this.#database
      .prepare(
        `SELECT work_key, kind, attempt FROM work_items
         WHERE run_id = ? AND completed_at_ms IS NULL AND failed_at_ms IS NULL
         ORDER BY created_at_ms, work_key`,
      )
      .all(targetRunId)
      .map((row) => pendingWorkRowSchema.parse(row));
    return {
      state: run.state,
      terminalFailureReason: run.terminal_failure_reason,
      pendingWork,
    };
  }

  public putReviewerReportOnce(
    request: Readonly<{
      runId: RunId;
      report: ReviewerReport;
      cost: UsdMicros;
      createdAtMs: number;
    }>,
  ): ReviewerReport {
    const report = reviewerReportSchema.parse(request.report);
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          "SELECT report_json FROM reviewer_reports WHERE run_id = ? AND reviewer_id = ?",
        )
        .get(request.runId, report.reviewer);
      if (existing !== undefined) {
        const stored = reviewerReportSchema.parse(
          parseJson(reviewerReportRowSchema.parse(existing).report_json),
        );
        if (JSON.stringify(stored) !== JSON.stringify(report))
          throw new Error("Reviewer report conflict for existing checkpoint");
        return stored;
      }
      this.#database
        .prepare(
          `INSERT INTO reviewer_reports
             (run_id, reviewer_id, report_json, created_at_ms, cost_micros)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          request.runId,
          report.reviewer,
          JSON.stringify(report),
          request.createdAtMs,
          request.cost,
        );
      const insertFinding = this.#database.prepare(
        `INSERT INTO findings
           (finding_id, run_id, reviewer_id, stable_identity, path, line,
            finding_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const finding of report.findings)
        insertFinding.run(
          findingKey(request.runId, finding.id),
          request.runId,
          finding.reviewer,
          finding.stableIdentity,
          finding.location.path,
          finding.location.line,
          JSON.stringify(finding),
          request.createdAtMs,
        );
      return report;
    })();
  }

  public getReviewerReports(targetRunId: RunId): readonly ReviewerReport[] {
    return this.#database
      .prepare(
        "SELECT report_json FROM reviewer_reports WHERE run_id = ? ORDER BY reviewer_id",
      )
      .all(targetRunId)
      .map((row) =>
        reviewerReportSchema.parse(
          parseJson(reviewerReportRowSchema.parse(row).report_json),
        ),
      );
  }

  public putChallengeOnce(
    request: Readonly<{
      runId: RunId;
      verdict: ChallengeVerdict;
      cost: UsdMicros;
      createdAtMs: number;
    }>,
  ): ChallengeVerdict {
    const verdict = challengeVerdictSchema.parse(request.verdict);
    return this.#database.transaction(() => {
      const storageFindingId = findingKey(request.runId, verdict.findingId);
      const finding = this.#database
        .prepare("SELECT run_id FROM findings WHERE finding_id = ?")
        .get(storageFindingId);
      const owner = z.object({ run_id: z.string() }).parse(finding);
      if (owner.run_id !== request.runId)
        throw new Error("Challenge finding belongs to another run");
      const existing = this.#database
        .prepare(
          "SELECT outcome, reason FROM challenge_verdicts WHERE finding_id = ?",
        )
        .get(storageFindingId);
      if (existing !== undefined) {
        const row = persistedChallengeRowSchema.parse(existing);
        const stored = challengeVerdictSchema.parse({
          kind: row.outcome,
          findingId: verdict.findingId,
          reason: row.reason,
        });
        if (JSON.stringify(stored) !== JSON.stringify(verdict))
          throw new Error("Challenge verdict conflict for existing checkpoint");
        return stored;
      }
      this.#database
        .prepare(
          `INSERT INTO challenge_verdicts
             (finding_id, outcome, reason, created_at_ms, cost_micros)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          storageFindingId,
          verdict.kind,
          verdict.reason,
          request.createdAtMs,
          request.cost,
        );
      return verdict;
    })();
  }

  public getChallenges(targetRunId: RunId): readonly ChallengeVerdict[] {
    return this.#database
      .prepare(
        `SELECT f.finding_json, v.outcome, v.reason
         FROM challenge_verdicts v
         JOIN findings f ON f.finding_id = v.finding_id
         WHERE f.run_id = ? ORDER BY v.finding_id`,
      )
      .all(targetRunId)
      .map(challengeRowToVerdict);
  }

  public reserveBudget(
    request: Readonly<{
      runId: RunId;
      key: string;
      amount: UsdMicros;
      createdAtMs: number;
    }>,
  ): ReserveBudgetResult {
    if (request.key.length === 0)
      throw new Error("Reservation key must not be empty");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existingRaw = this.#database
        .prepare(
          "SELECT reserved_micros FROM budget_reservations WHERE run_id = ? AND reservation_key = ?",
        )
        .get(request.runId, request.key);
      if (existingRaw !== undefined) {
        const existing = usdMicros(
          reservationRowSchema.parse(existingRaw).reserved_micros,
        );
        this.#database.exec("COMMIT");
        return { kind: "already_reserved", amount: existing };
      }
      const total = totalRowSchema.parse(
        this.#database
          .prepare(
            "SELECT COALESCE(SUM(reserved_micros), 0) AS total FROM budget_reservations WHERE run_id = ?",
          )
          .get(request.runId),
      ).total;
      const available = usdMicros(BUDGET_LIMIT - total);
      if (request.amount > available) {
        this.#database.exec("COMMIT");
        return { kind: "denied", available };
      }
      this.#database
        .prepare(
          "INSERT INTO budget_reservations (run_id, reservation_key, reserved_micros, created_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(request.runId, request.key, request.amount, request.createdAtMs);
      this.#database.exec("COMMIT");
      return { kind: "reserved", amount: request.amount };
    } catch (error: unknown) {
      if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public getBudgetSummary(targetRunId: RunId): Readonly<{
    reserved: UsdMicros;
    settled: UsdMicros;
    remaining: UsdMicros;
  }> {
    const row = z
      .object({
        reserved: z.number().int().nonnegative(),
        settled: z.number().int().nonnegative(),
      })
      .parse(
        this.#database
          .prepare(
            `SELECT
               COALESCE(SUM(reserved_micros), 0) AS reserved,
               COALESCE(SUM(settled_micros), 0) AS settled
             FROM budget_reservations WHERE run_id = ?`,
          )
          .get(targetRunId),
      );
    return {
      reserved: usdMicros(row.reserved),
      settled: usdMicros(row.settled),
      remaining: usdMicros(BUDGET_LIMIT - row.reserved),
    };
  }

  public settleBudget(
    request: Readonly<{
      runId: RunId;
      key: string;
      actualAmount: UsdMicros;
      settledAtMs: number;
    }>,
  ): void {
    const reservation = this.#database
      .prepare(
        "SELECT reserved_micros FROM budget_reservations WHERE run_id = ? AND reservation_key = ?",
      )
      .get(request.runId, request.key);
    if (reservation === undefined)
      throw new Error("Budget reservation not found");
    const reserved = reservationRowSchema.parse(reservation).reserved_micros;
    if (request.actualAmount > reserved)
      throw new Error("Settled amount exceeds reservation");
    this.#database
      .prepare(
        `UPDATE budget_reservations
         SET settled_micros = ?, settled_at_ms = ?
         WHERE run_id = ? AND reservation_key = ?`,
      )
      .run(
        request.actualAmount,
        request.settledAtMs,
        request.runId,
        request.key,
      );
  }

  #insertDelivery(
    input: Readonly<{ deliveryId: string; runId: RunId; receivedAtMs: number }>,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO webhook_deliveries (delivery_id, run_id, eligibility, received_at_ms) VALUES (?, ?, 'accepted', ?)",
      )
      .run(input.deliveryId, input.runId, input.receivedAtMs);
  }

  #insertWork(
    input: Readonly<{
      key: string;
      runId: RunId;
      kind: WorkKind;
      createdAtMs: number;
    }>,
  ): void {
    workKindSchema.parse(input.kind);
    this.#database
      .prepare(
        `INSERT INTO work_items
           (work_key, run_id, kind, created_at_ms, next_attempt_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(work_key) DO NOTHING`,
      )
      .run(
        input.key,
        input.runId,
        input.kind,
        input.createdAtMs,
        input.createdAtMs,
      );
  }

  #appendRunEvent(
    input: Readonly<{
      runId: RunId;
      kind: string;
      payload: Readonly<Record<string, unknown>>;
      createdAtMs: number;
    }>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO run_events
           (run_id, kind, redacted_payload_json, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.kind,
        JSON.stringify(input.payload),
        input.createdAtMs,
      );
  }
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid persisted JSON");
  }
};

const challengeRowToVerdict = (value: unknown): ChallengeVerdict => {
  const row = challengeRowSchema.parse(value);
  const finding = findingSchema.parse(parseJson(row.finding_json));
  return challengeVerdictSchema.parse({
    kind: row.outcome,
    findingId: finding.id,
    reason: row.reason,
  });
};

const findingKey = (targetRunId: RunId, targetFindingId: FindingId): string =>
  `${targetRunId}:${targetFindingId}`;

const parseReviewPlan = (value: unknown): ReviewPlan => {
  const parsed = z
    .object({
      selectedReviewers: z
        .array(z.unknown().transform(reviewerId))
        .min(1)
        .max(10),
      priorStableIdentities: z.array(z.string().min(1).max(512)).max(10_000),
    })
    .strict()
    .parse(value);
  if (
    new Set(parsed.selectedReviewers).size !== parsed.selectedReviewers.length
  )
    throw new Error("Review plan contains duplicate reviewers");
  return parsed;
};

const stateForWork = (kind: WorkKind): z.infer<typeof runStateSchema> => {
  switch (kind) {
    case "snapshot":
      return "snapshotting";
    case "plan":
      return "planning";
    case "prepare_sailbox":
      return "preparing_sailbox";
    case "review":
      return "reviewing";
    case "challenge":
      return "challenging";
    case "reduce":
      return "reducing";
    case "publish":
      return "publishing";
    case "cleanup":
      return "cleaning_up";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};
