import type Database from "better-sqlite3";
import { z } from "zod";
import { BUDGET_LIMIT } from "../domain/budget.js";
import {
  commitSha,
  deliveryId,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  usdMicros,
  workerId,
  type RunId,
  type UsdMicros,
  type WorkerId,
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
const leaseRowSchema = z
  .object({
    run_id: z.string(),
    lease_owner: z.string(),
    lease_expires_at_ms: z.number().int(),
    lease_attempt: z.number().int().positive(),
  })
  .transform((row) => ({
    runId: runId(row.run_id),
    workerId: workerId(row.lease_owner),
    expiresAtMs: row.lease_expires_at_ms,
    attempt: row.lease_attempt,
  }));
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

export type AcceptRunResult =
  | Readonly<{ kind: "created"; runId: RunId }>
  | Readonly<{ kind: "duplicate_delivery"; runId: RunId }>
  | Readonly<{ kind: "existing_target"; runId: RunId }>;

export type Lease = Readonly<{
  runId: RunId;
  workerId: WorkerId;
  expiresAtMs: number;
  attempt: number;
}>;

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

  public claimNext(
    request: Readonly<{
      workerId: WorkerId;
      nowMs: number;
      leaseDurationMs: number;
    }>,
  ): Lease | null {
    const expiresAtMs = request.nowMs + request.leaseDurationMs;
    if (!Number.isSafeInteger(expiresAtMs) || request.leaseDurationMs <= 0)
      throw new Error("Invalid lease duration");
    const row = this.#database
      .prepare(
        `UPDATE review_runs
         SET lease_owner = ?, lease_expires_at_ms = ?, lease_attempt = lease_attempt + 1
         WHERE run_id = (
           SELECT run_id FROM review_runs
           WHERE state NOT IN ('completed', 'failed')
             AND (lease_owner IS NULL OR lease_expires_at_ms < ?)
           ORDER BY created_at_ms, run_id
           LIMIT 1
         )
         RETURNING run_id, lease_owner, lease_expires_at_ms, lease_attempt`,
      )
      .get(request.workerId, expiresAtMs, request.nowMs);
    return row === undefined ? null : leaseRowSchema.parse(row);
  }

  public completeLease(
    request: Readonly<{ runId: RunId; workerId: WorkerId; nowMs: number }>,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE review_runs
         SET state = 'completed', completed_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL
         WHERE run_id = ? AND lease_owner = ?`,
      )
      .run(request.nowMs, request.runId, request.workerId);
    if (result.changes !== 1)
      throw new Error("Cannot complete lease: lease owner does not match");
  }

  public failLease(
    request: Readonly<{
      runId: RunId;
      workerId: WorkerId;
      nowMs: number;
      reason: string;
    }>,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE review_runs
         SET state = 'failed', failure_reason = ?, lease_owner = NULL, lease_expires_at_ms = NULL
         WHERE run_id = ? AND lease_owner = ?`,
      )
      .run(request.reason.slice(0, 2_000), request.runId, request.workerId);
    if (result.changes !== 1)
      throw new Error("Cannot fail lease: lease owner does not match");
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
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid persisted JSON");
  }
};
