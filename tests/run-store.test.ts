import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deliveryId,
  commitSha,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  usdMicros,
  workerId,
} from "../src/domain/ids.js";
import { migrate } from "../src/storage/migrations.js";
import { SqliteRunStore } from "../src/storage/run-store.js";
import type { CapturedPullRequestSnapshot } from "../src/domain/snapshot.js";

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
    expect(database.pragma("user_version", { simple: true })).toBe(3);
  });

  const request = (headSha = "a".repeat(40), delivery = "delivery-1") => ({
    deliveryId: deliveryId(delivery),
    runId: runId(`run-${headSha.slice(0, 7)}`),
    installationId: installationId(1),
    repositoryId: repositoryId(2),
    pullNumber: pullNumber(3),
    owner: "Kylejeong2",
    repository: "gauntlet",
    baseSha: commitSha("0".repeat(40)),
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

  it("records an ineligible signed delivery without creating a run", () => {
    expect(
      store.recordIneligibleDelivery({
        deliveryId: deliveryId("ignored-1"),
        reason: "bot_authored_pull_request",
        receivedAtMs: 100,
      }),
    ).toEqual({ kind: "recorded", reason: "bot_authored_pull_request" });
    expect(
      store.recordIneligibleDelivery({
        deliveryId: deliveryId("ignored-1"),
        reason: "private_repository",
        receivedAtMs: 101,
      }),
    ).toEqual({
      kind: "duplicate_delivery",
      reason: "bot_authored_pull_request",
    });
    expect(store.countRuns()).toBe(0);
  });

  it("persists the immutable target needed for crash recovery", () => {
    store.acceptRun(request());
    expect(store.getRun(runId("run-aaaaaaa"))).toEqual({
      runId: runId("run-aaaaaaa"),
      installationId: installationId(1),
      repositoryId: repositoryId(2),
      pullNumber: pullNumber(3),
      owner: "Kylejeong2",
      repository: "gauntlet",
      baseSha: commitSha("0".repeat(40)),
      headSha: commitSha("a".repeat(40)),
    });
  });

  it("puts one normalized snapshot and reloads the exact target", () => {
    store.acceptRun(request());
    const snapshot: CapturedPullRequestSnapshot = {
      formatVersion: 1,
      mergeBaseSha: commitSha("f".repeat(40)),
      files: [
        {
          ordinal: 0,
          kind: "reviewable",
          path: "src/index.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
          changedLines: [1],
        },
        {
          ordinal: 1,
          kind: "omitted",
          path: "image.png",
          status: "modified",
          reason: "patch_unavailable",
        },
      ],
      coverageOmissions: ["image.png: GitHub did not provide a patch"],
    };
    const persisted = store.putSnapshotOnce({
      runId: runId("run-aaaaaaa"),
      snapshot,
      capturedAtMs: 500,
    });
    expect(persisted).toMatchObject({
      persisted: true,
      runId: runId("run-aaaaaaa"),
      installationId: installationId(1),
      repositoryId: repositoryId(2),
      pullNumber: pullNumber(3),
      owner: "Kylejeong2",
      repository: "gauntlet",
      baseSha: commitSha("0".repeat(40)),
      headSha: commitSha("a".repeat(40)),
      mergeBaseSha: commitSha("f".repeat(40)),
      capturedAtMs: 500,
      files: snapshot.files,
    });
    expect(store.getSnapshot(runId("run-aaaaaaa"))).toEqual(persisted);
    expect(
      store.putSnapshotOnce({
        runId: runId("run-aaaaaaa"),
        snapshot,
        capturedAtMs: 600,
      }),
    ).toEqual(persisted);
    expect(() =>
      store.putSnapshotOnce({
        runId: runId("run-aaaaaaa"),
        snapshot: {
          ...snapshot,
          mergeBaseSha: commitSha("e".repeat(40)),
        },
        capturedAtMs: 700,
      }),
    ).toThrow("Snapshot conflict");
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
    store.settleBudget({
      runId: runId("run-aaaaaaa"),
      key: "reviewer:security:1",
      actualAmount: usdMicros(123),
      settledAtMs: 2_000,
    });
    expect(store.getBudgetSummary(runId("run-aaaaaaa")).settled).toBe(
      usdMicros(123),
    );
    expect(() => {
      store.settleBudget({
        runId: runId("run-aaaaaaa"),
        key: "reviewer:security:1",
        actualAmount: usdMicros(200_001),
        settledAtMs: 2_001,
      });
    }).toThrow("exceeds reservation");
  });
});
