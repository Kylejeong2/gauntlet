import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DurableReviewEngine,
  type DurableReviewEnginePorts,
} from "../src/application/durable-review-engine.js";
import { estimateWorstCaseRunCost } from "../src/application/review-contracts.js";
import {
  commitSha,
  deliveryId,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  usdMicros,
  workerId,
} from "../src/domain/ids.js";
import { CORE_REVIEWERS } from "../src/domain/reviewers.js";
import type { ReviewerReport } from "../src/domain/types.js";
import { migrate } from "../src/storage/migrations.js";
import { SqliteRunStore } from "../src/storage/run-store.js";

describe("durable review engine", () => {
  let database: Database.Database;
  let store: SqliteRunStore;
  const targetRunId = runId("run-durable");

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    store = new SqliteRunStore(database);
    store.acceptRun({
      deliveryId: deliveryId("delivery-durable"),
      runId: targetRunId,
      installationId: installationId(1),
      repositoryId: repositoryId(2),
      pullNumber: pullNumber(3),
      owner: "Kylejeong2",
      repository: "gauntlet",
      baseSha: commitSha("a".repeat(40)),
      headSha: commitSha("b".repeat(40)),
      receivedAtMs: 100,
    });
  });

  afterEach(() => database.close());

  it("reserves the full bounded retry envelope below the hard ceiling", () => {
    expect(estimateWorstCaseRunCost(10)).toBe(usdMicros(171_000));
    expect(() => estimateWorstCaseRunCost(11)).toThrow("between one and ten");
  });

  const makePorts = (
    reviewed: string[],
    failOnceAfter?: string,
  ): DurableReviewEnginePorts => {
    let failed = false;
    return {
      github: {
        snapshot: () =>
          Promise.resolve({
            formatVersion: 1,
            mergeBaseSha: commitSha("c".repeat(40)),
            files: [
              {
                ordinal: 0,
                kind: "reviewable",
                path: "src/index.ts",
                status: "modified",
                patch: "@@ -1 +1 @@\n-old\n+new",
                changedLines: [1],
              },
            ],
            coverageOmissions: [],
          }),
        priorStableIdentities: () => Promise.resolve([]),
        findExisting: () => Promise.resolve(null),
        publish: () => Promise.resolve({ reviewId: 42 }),
      },
      sandbox: {
        prepare: () =>
          Promise.resolve({ id: "box-1", estimatedCost: usdMicros(10_000) }),
        resume: (_input, handle) => Promise.resolve(handle),
        find: () => Promise.resolve(null),
        evidence: () => Promise.resolve(["checks passed"]),
        terminate: () => Promise.resolve(),
      },
      model: {
        review: ({ reviewer }) => {
          if (
            !failed &&
            failOnceAfter !== undefined &&
            reviewer === failOnceAfter
          ) {
            failed = true;
            return Promise.reject(new Error("simulated process crash"));
          }
          reviewed.push(reviewer);
          const report: ReviewerReport = {
            reviewer,
            readiness: 5,
            rationale: "No actionable issue remains.",
            examinedAreas: ["changed line"],
            findings: [],
          };
          return Promise.resolve({ report, cost: usdMicros(100) });
        },
        challenge: () => Promise.reject(new Error("no findings to challenge")),
        summarize: () =>
          Promise.resolve({
            summary: {
              headline: "Ready to merge",
              overview: "All selected reviewers found the change ready.",
              topRisk: "No verified risk remains.",
              nextAction: "Merge when CI passes.",
            },
            cost: usdMicros(75),
          }),
      },
    };
  };

  const claim = () =>
    store.claimNextWork({
      workerId: workerId("worker-a"),
      nowMs: 10_000,
      leaseDurationMs: 60_000,
    });

  it("advances persisted phase work to one reconciled publication", async () => {
    const reviewed: string[] = [];
    const engine = new DurableReviewEngine({
      store,
      ports: makePorts(reviewed),
      clock: () => 2_000,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) break;
      await engine.advance(lease);
    }
    expect(store.getRunProgress(targetRunId).state).toBe("completed");
    expect(store.getReviewerReports(targetRunId)).toHaveLength(
      CORE_REVIEWERS.length,
    );
    expect(reviewed).toEqual(CORE_REVIEWERS.map((reviewer) => reviewer.id));
  });

  it("resumes after a reviewer crash without repeating durable checkpoints", async () => {
    const reviewed: string[] = [];
    const firstEngine = new DurableReviewEngine({
      store,
      ports: makePorts(reviewed, "performance"),
      clock: () => 2_000,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) throw new Error("Expected work before completion");
      try {
        await firstEngine.advance(lease);
      } catch (error: unknown) {
        expect(error).toEqual(new Error("simulated process crash"));
        expect(
          store.retryWork({
            lease,
            nowMs: 2_000,
            retryAtMs: 2_000,
            reason: "simulated process crash",
          }),
        ).toBe("retry_scheduled");
        break;
      }
    }
    expect(reviewed).toEqual(["security"]);
    expect(store.getReviewerReports(targetRunId)).toHaveLength(1);

    const restartedEngine = new DurableReviewEngine({
      store,
      ports: makePorts(reviewed),
      clock: () => 3_000,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) break;
      await restartedEngine.advance(lease);
    }
    expect(store.getRunProgress(targetRunId).state).toBe("completed");
    expect(reviewed.filter((reviewer) => reviewer === "security")).toHaveLength(
      1,
    );
    expect(reviewed).toHaveLength(CORE_REVIEWERS.length);
  });

  it("reconciles an externally created Sailbox from its persisted intent", async () => {
    const reviewed: string[] = [];
    const base = makePorts(reviewed);
    let prepareCalls = 0;
    let findCalls = 0;
    const ports: DurableReviewEnginePorts = {
      ...base,
      sandbox: {
        ...base.sandbox,
        prepare: (input) => {
          prepareCalls += 1;
          return base.sandbox.prepare(input);
        },
        find: () => {
          findCalls += 1;
          return Promise.resolve({
            id: "reconciled-box",
            estimatedCost: usdMicros(10_000),
          });
        },
      },
    };
    const engine = new DurableReviewEngine({
      store,
      ports,
      clock: () => 2_000,
    });
    const snapshot = claim();
    if (snapshot === null) throw new Error("Expected snapshot work");
    await engine.advance(snapshot);
    const plan = claim();
    if (plan === null) throw new Error("Expected plan work");
    await engine.advance(plan);
    store.beginSailbox({
      runId: targetRunId,
      name: "gauntlet-run-durable",
      createdAtMs: 1_999,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) break;
      await engine.advance(lease);
    }
    expect(findCalls).toBe(1);
    expect(prepareCalls).toBe(0);
    expect(store.getRunProgress(targetRunId).state).toBe("completed");
  });

  it("reconciles a published GitHub review after a lost local receipt", async () => {
    const reviewed: string[] = [];
    const base = makePorts(reviewed);
    let remoteReviewId: number | null = null;
    let publishCalls = 0;
    const crashingPorts: DurableReviewEnginePorts = {
      ...base,
      github: {
        ...base.github,
        findExisting: () =>
          Promise.resolve(
            remoteReviewId === null ? null : { reviewId: remoteReviewId },
          ),
        publish: () => {
          publishCalls += 1;
          remoteReviewId = 99;
          return Promise.reject(
            new Error("crash after GitHub accepted review"),
          );
        },
      },
    };
    const engine = new DurableReviewEngine({
      store,
      ports: crashingPorts,
      clock: () => 2_000,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) throw new Error("Expected work before publication");
      try {
        await engine.advance(lease);
      } catch (error: unknown) {
        expect(error).toEqual(new Error("crash after GitHub accepted review"));
        store.retryWork({
          lease,
          nowMs: 2_000,
          retryAtMs: 2_000,
          reason: "crash after GitHub accepted review",
        });
        break;
      }
    }
    const reconciledPorts: DurableReviewEnginePorts = {
      ...crashingPorts,
      github: {
        ...crashingPorts.github,
        publish: () => Promise.reject(new Error("must not republish")),
      },
    };
    const restarted = new DurableReviewEngine({
      store,
      ports: reconciledPorts,
      clock: () => 3_000,
    });
    for (;;) {
      const lease = claim();
      if (lease === null) break;
      await restarted.advance(lease);
    }
    expect(publishCalls).toBe(1);
    expect(store.getPublication(targetRunId)?.reviewId).toBe(99);
    expect(store.getRunProgress(targetRunId).state).toBe("completed");
  });
});
