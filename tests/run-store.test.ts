import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deliveryId,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  usdMicros,
  workerId,
} from "../src/domain/ids.js";
import { migrate } from "../src/storage/migrations.js";
import { SqliteRunStore } from "../src/storage/run-store.js";

describe("SQLite RunStore", () => {
  let database: Database.Database;
  let store: SqliteRunStore;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    store = new SqliteRunStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it("applies direct migrations idempotently with required SQLite safety settings", () => {
    migrate(database);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(database.pragma("user_version", { simple: true })).toBe(1);
  });

  const request = (headSha = "a".repeat(40), delivery = "delivery-1") => ({
    deliveryId: deliveryId(delivery),
    runId: runId(`run-${headSha.slice(0, 7)}`),
    installationId: installationId(1),
    repositoryId: repositoryId(2),
    pullNumber: pullNumber(3),
    headSha,
    receivedAtMs: 100,
  });

  it("AC-1 accepts repeated deliveries and same-head deliveries exactly once", () => {
    const first = store.acceptRun(request());
    const sameDelivery = store.acceptRun(request());
    const anotherDelivery = store.acceptRun(
      request("a".repeat(40), "delivery-2"),
    );
    expect(first).toEqual({ kind: "created", runId: runId("run-aaaaaaa") });
    expect(sameDelivery).toEqual({
      kind: "duplicate_delivery",
      runId: runId("run-aaaaaaa"),
    });
    expect(anotherDelivery).toEqual({
      kind: "existing_target",
      runId: runId("run-aaaaaaa"),
    });
    expect(store.countRuns()).toBe(1);
  });

  it("AC-10 creates a distinct run for a new head", () => {
    store.acceptRun(request());
    expect(store.acceptRun(request("b".repeat(40), "delivery-2"))).toEqual({
      kind: "created",
      runId: runId("run-bbbbbbb"),
    });
    expect(store.countRuns()).toBe(2);
  });

  it("claims one lease per run, recovers expired leases, and rejects stale completion", () => {
    store.acceptRun(request());
    const first = store.claimNext({
      workerId: workerId("worker-a"),
      nowMs: 1_000,
      leaseDurationMs: 100,
    });
    expect(first?.runId).toBe(runId("run-aaaaaaa"));
    expect(
      store.claimNext({
        workerId: workerId("worker-b"),
        nowMs: 1_050,
        leaseDurationMs: 100,
      }),
    ).toBeNull();
    const recovered = store.claimNext({
      workerId: workerId("worker-b"),
      nowMs: 1_101,
      leaseDurationMs: 100,
    });
    expect(recovered?.attempt).toBe(2);
    expect(() => {
      store.completeLease({
        runId: runId("run-aaaaaaa"),
        workerId: workerId("worker-a"),
        nowMs: 1_110,
      });
    }).toThrow("lease owner");
    store.completeLease({
      runId: runId("run-aaaaaaa"),
      workerId: workerId("worker-b"),
      nowMs: 1_110,
    });
    expect(
      store.claimNext({
        workerId: workerId("worker-a"),
        nowMs: 1_200,
        leaseDurationMs: 100,
      }),
    ).toBeNull();
  });

  it("AC-13 atomically reserves budget, idempotently returns existing reservations, and denies overflow", () => {
    store.acceptRun(request());
    expect(
      store.reserveBudget({
        runId: runId("run-aaaaaaa"),
        key: "reviewer:security:1",
        amount: usdMicros(200_000),
        createdAtMs: 1_000,
      }).kind,
    ).toBe("reserved");
    expect(
      store.reserveBudget({
        runId: runId("run-aaaaaaa"),
        key: "reviewer:security:1",
        amount: usdMicros(1),
        createdAtMs: 1_001,
      }),
    ).toEqual({ kind: "already_reserved", amount: usdMicros(200_000) });
    expect(
      store.reserveBudget({
        runId: runId("run-aaaaaaa"),
        key: "challenge:1",
        amount: usdMicros(50_001),
        createdAtMs: 1_002,
      }),
    ).toEqual({ kind: "denied", available: usdMicros(50_000) });
    expect(store.getBudgetSummary(runId("run-aaaaaaa"))).toEqual({
      reserved: usdMicros(200_000),
      settled: usdMicros(0),
      remaining: usdMicros(50_000),
    });
  });
});
