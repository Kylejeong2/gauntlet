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

const acceptRunRequestSchema = z
  .object({
    deliveryId: z.unknown().transform(deliveryId),
    runId: z.unknown().transform(runId),
    installationId: z.unknown().transform(installationId),
    repositoryId: z.unknown().transform(repositoryId),
    pullNumber: z.unknown().transform(pullNumber),
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

export type ReserveBudgetResult =
  | Readonly<{ kind: "reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "already_reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "denied"; available: UsdMicros }>;

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
            run_id, installation_id, repository_id, pull_number, head_sha, state, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(
          request.runId,
          request.installationId,
          request.repositoryId,
          request.pullNumber,
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
