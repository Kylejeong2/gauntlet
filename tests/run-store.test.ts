import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deliveryId,
  commitSha,
  installationId,
  pullNumber,
  repositoryId,
  findingId,
  reviewerId,
  runId,
  usdMicros,
  workerId,
} from "../src/domain/ids.js";
import { migrate } from "../src/storage/migrations.js";
import { SqliteRunStore } from "../src/storage/run-store.js";
import type { CapturedPullRequestSnapshot } from "../src/domain/snapshot.js";
import type { ChallengeVerdict, ReviewerReport } from "../src/domain/types.js";

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
    expect(database.pragma("user_version", { simple: true })).toBe(5);
  });

  it("backfills phase work when upgrading an in-flight version-three run", () => {
    const legacy = new Database(":memory:");
    try {
      migrate(legacy, 3);
      legacy
        .prepare(
          `INSERT INTO review_runs
             (run_id, installation_id, repository_id, pull_number, head_sha,
              state, created_at_ms, owner, repository_name, base_sha)
           VALUES (?, 1, 2, 3, ?, 'challenging', 100, 'Kylejeong2',
                   'gauntlet', ?)`,
        )
        .run("legacy-run", "b".repeat(40), "a".repeat(40));
      migrate(legacy);
      const upgraded = new SqliteRunStore(legacy);
      expect(
        upgraded.claimNextWork({
          workerId: workerId("migration-worker"),
          nowMs: 200,
          leaseDurationMs: 100,
        }),
      ).toMatchObject({
        workKey: "legacy-run:challenge",
        kind: "challenge",
      });
    } finally {
      legacy.close();
    }
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

  it("fences publication receipts with the current durable work claim", () => {
    store.acceptRun(request());
    const first = store.claimNextWork({
      workerId: workerId("publisher-a"),
      nowMs: 1_000,
      leaseDurationMs: 100,
    });
    if (first === null) throw new Error("Expected first publication claim");
    store.beginPublication({
      lease: first,
      runId: first.runId,
      key: `${first.runId}:github-review`,
      bodyDigest: "digest-a",
      createdAtMs: 1_050,
    });
    const second = store.claimNextWork({
      workerId: workerId("publisher-b"),
      nowMs: 1_101,
      leaseDurationMs: 100,
    });
    if (second === null) throw new Error("Expected replacement claim");
    store.beginPublication({
      lease: second,
      runId: second.runId,
      key: `${second.runId}:github-review`,
      bodyDigest: "digest-a",
      createdAtMs: 1_110,
    });

    expect(() => {
      store.recordPublicationSubmitted({
        lease: first,
        runId: first.runId,
        reviewId: 41,
        submittedAtMs: 1_120,
      });
    }).toThrow("Publication receipt conflict");
    store.recordPublicationSubmitted({
      lease: second,
      runId: second.runId,
      reviewId: 42,
      submittedAtMs: 1_121,
    });
    expect(store.getPublication(second.runId)?.reviewId).toBe(42);
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

  it("atomically enqueues and advances durable phase work", () => {
    store.acceptRun(request());
    const first = store.claimNextWork({
      workerId: workerId("worker-a"),
      nowMs: 1_000,
      leaseDurationMs: 100,
    });
    expect(first).toMatchObject({
      workKey: "run-aaaaaaa:snapshot",
      runId: runId("run-aaaaaaa"),
      kind: "snapshot",
      attempt: 1,
    });
    if (first === null) throw new Error("Expected snapshot work");
    store.completeWork({
      lease: first,
      nowMs: 1_010,
      nextState: "planning",
      nextWork: { kind: "plan", key: "run-aaaaaaa:plan" },
    });
    expect(store.getRunProgress(runId("run-aaaaaaa"))).toMatchObject({
      state: "planning",
      pendingWork: [{ key: "run-aaaaaaa:plan", kind: "plan", attempt: 0 }],
    });
    expect(() => {
      store.completeWork({
        lease: first,
        nowMs: 1_011,
        nextState: "planning",
        nextWork: { kind: "plan", key: "run-aaaaaaa:plan" },
      });
    }).toThrow("lease");
  });

  it("heartbeats work leases and recovers only after the extended deadline", () => {
    store.acceptRun(request());
    const first = store.claimNextWork({
      workerId: workerId("worker-a"),
      nowMs: 1_000,
      leaseDurationMs: 100,
    });
    if (first === null) throw new Error("Expected snapshot work");
    store.heartbeatWork({
      lease: first,
      nowMs: 1_050,
      leaseDurationMs: 100,
    });
    expect(
      store.claimNextWork({
        workerId: workerId("worker-b"),
        nowMs: 1_101,
        leaseDurationMs: 100,
      }),
    ).toBeNull();
    expect(
      store.claimNextWork({
        workerId: workerId("worker-b"),
        nowMs: 1_151,
        leaseDurationMs: 100,
      }),
    ).toMatchObject({ workerId: workerId("worker-b"), attempt: 2 });
    expect(() => {
      store.assertWorkLease({ lease: first, nowMs: 1_151 });
    }).toThrow("stale or expired");
  });

  it("retries bounded work and dead-letters into cleanup after exhaustion", () => {
    store.acceptRun(request());
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = store.claimNextWork({
        workerId: workerId("worker-a"),
        nowMs: attempt * 1_000,
        leaseDurationMs: 100,
      });
      if (lease === null) throw new Error("Expected retryable work");
      expect(lease.attempt).toBe(attempt);
      expect(
        store.retryWork({
          lease,
          nowMs: attempt * 1_000 + 1,
          retryAtMs: attempt * 1_000 + 10,
          reason: "provider unavailable",
        }),
      ).toBe(attempt < 3 ? "retry_scheduled" : "dead_lettered");
    }
    expect(store.getRunProgress(runId("run-aaaaaaa"))).toMatchObject({
      state: "cleaning_up",
      terminalFailureReason: "provider unavailable",
      pendingWork: [
        { key: "run-aaaaaaa:cleanup", kind: "cleanup", attempt: 0 },
      ],
    });
  });

  it("redirects a cancelled run to cleanup at the next durable checkpoint", () => {
    store.acceptRun(request());
    const lease = store.claimNextWork({
      workerId: workerId("worker-a"),
      nowMs: 1_000,
      leaseDurationMs: 100,
    });
    if (lease === null) throw new Error("Expected snapshot work");
    expect(
      store.requestCancellation({
        runId: runId("run-aaaaaaa"),
        reason: "operator stopped the run",
        requestedAtMs: 1_001,
      }),
    ).toBe("requested");
    store.completeWork({
      lease,
      nowMs: 1_002,
      nextState: "planning",
      nextWork: { kind: "plan", key: "run-aaaaaaa:plan" },
    });
    expect(store.getRunProgress(runId("run-aaaaaaa"))).toMatchObject({
      state: "cleaning_up",
      terminalFailureReason: "cancelled: operator stopped the run",
      pendingWork: [
        { key: "run-aaaaaaa:cleanup", kind: "cleanup", attempt: 0 },
      ],
    });
  });

  it("persists reviewer and challenge checkpoints idempotently and rejects conflicts", () => {
    store.acceptRun(request());
    const finding = {
      id: findingId("finding-1"),
      reviewer: reviewerId("security"),
      location: { path: "src/index.ts", line: 1 },
      severity: "high" as const,
      confidence: 0.95,
      title: "Unsafe execution",
      trigger: "Pass attacker-controlled input.",
      evidence: "The changed line executes the value.",
      proposedAction: "Use an argument vector.",
      stableIdentity: "unsafe-execution",
    };
    const report: ReviewerReport = {
      reviewer: reviewerId("security"),
      readiness: 2,
      rationale: "One reachable issue remains.",
      examinedAreas: ["execution path"],
      findings: [finding],
    };
    expect(
      store.putReviewerReportOnce({
        runId: runId("run-aaaaaaa"),
        report,
        cost: usdMicros(100),
        createdAtMs: 1_000,
      }),
    ).toEqual(report);
    expect(
      store.putReviewerReportOnce({
        runId: runId("run-aaaaaaa"),
        report,
        cost: usdMicros(100),
        createdAtMs: 1_001,
      }),
    ).toEqual(report);
    expect(() =>
      store.putReviewerReportOnce({
        runId: runId("run-aaaaaaa"),
        report: { ...report, readiness: 3 },
        cost: usdMicros(100),
        createdAtMs: 1_002,
      }),
    ).toThrow("Reviewer report conflict");

    const verdict: ChallengeVerdict = {
      kind: "confirmed",
      findingId: finding.id,
      reason: "The execution path is reachable.",
    };
    expect(
      store.putChallengeOnce({
        runId: runId("run-aaaaaaa"),
        verdict,
        cost: usdMicros(50),
        createdAtMs: 2_000,
      }),
    ).toEqual(verdict);
    expect(store.getReviewerReports(runId("run-aaaaaaa"))).toEqual([report]);
    expect(store.getChallenges(runId("run-aaaaaaa"))).toEqual([verdict]);

    store.acceptRun(request("b".repeat(40), "delivery-2"));
    expect(
      store.putReviewerReportOnce({
        runId: runId("run-bbbbbbb"),
        report,
        cost: usdMicros(100),
        createdAtMs: 3_000,
      }),
    ).toEqual(report);
    expect(
      store.putChallengeOnce({
        runId: runId("run-bbbbbbb"),
        verdict,
        cost: usdMicros(50),
        createdAtMs: 3_001,
      }),
    ).toEqual(verdict);
  });

  it("deduplicates semantic findings before the atomic report checkpoint", () => {
    store.acceptRun(request());
    const first = {
      id: findingId("finding-low"),
      reviewer: reviewerId("performance"),
      location: { path: "src/index.ts", line: 1 },
      severity: "low" as const,
      confidence: 0.7,
      title: "Repeated work",
      trigger: "Call the changed path.",
      evidence: "The same work is repeated.",
      proposedAction: "Reuse the result.",
      stableIdentity: "repeated-work",
    };
    const stronger = {
      ...first,
      id: findingId("finding-high"),
      severity: "high" as const,
      confidence: 0.9,
      evidence:
        "The changed loop repeats the same expensive work for every item.",
    };
    const stored = store.putReviewerReportOnce({
      runId: runId("run-aaaaaaa"),
      report: {
        reviewer: reviewerId("performance"),
        readiness: 2,
        rationale: "One performance defect remains.",
        examinedAreas: ["changed loop"],
        findings: [first, stronger],
      },
      cost: usdMicros(100),
      createdAtMs: 1_000,
    });

    expect(stored.findings).toEqual([stronger]);
    expect(store.getReviewerReports(runId("run-aaaaaaa"))[0]?.findings).toEqual(
      [stronger],
    );
  });
});
