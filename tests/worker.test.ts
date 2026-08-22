import { describe, expect, it } from "vitest";
import { DurableReviewWorker } from "../src/application/worker.js";
import {
  commitSha,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  workerId,
} from "../src/domain/ids.js";
import type { Lease, QueuedRun } from "../src/storage/run-store.js";

const queuedRun: QueuedRun = {
  runId: runId("run-1"),
  installationId: installationId(1),
  repositoryId: repositoryId(2),
  pullNumber: pullNumber(3),
  owner: "Kylejeong2",
  repository: "gauntlet",
  baseSha: commitSha("a".repeat(40)),
  headSha: commitSha("b".repeat(40)),
};

const lease: Lease = {
  runId: queuedRun.runId,
  workerId: workerId("worker-1"),
  expiresAtMs: 61_000,
  attempt: 1,
};

describe("durable review worker", () => {
  it("claims, executes, and completes persisted work", async () => {
    const events: string[] = [];
    let claimed = false;
    const worker = new DurableReviewWorker({
      workerId: lease.workerId,
      leaseDurationMs: 60_000,
      clock: () => 1_000,
      store: {
        claimNext: () => {
          if (claimed) return null;
          claimed = true;
          return lease;
        },
        getRun: () => queuedRun,
        completeLease: () => {
          events.push("completed");
        },
        failLease: () => {
          events.push("failed");
        },
      },
      execute: (run) => {
        events.push(`executed:${run.runId}`);
        return Promise.resolve();
      },
    });
    expect(await worker.drain()).toBe(1);
    expect(events).toEqual(["executed:run-1", "completed"]);
  });

  it("records a failed terminal state without losing the lease error", async () => {
    let claimed = false;
    const failures: string[] = [];
    const worker = new DurableReviewWorker({
      workerId: lease.workerId,
      leaseDurationMs: 60_000,
      clock: () => 1_000,
      store: {
        claimNext: () => {
          if (claimed) return null;
          claimed = true;
          return lease;
        },
        getRun: () => queuedRun,
        completeLease: () => {
          throw new Error("must not complete");
        },
        failLease: (request) => {
          failures.push(request.reason);
        },
      },
      execute: () => Promise.reject(new Error("provider unavailable")),
    });
    expect(await worker.drain()).toBe(1);
    expect(failures).toEqual(["provider unavailable"]);
  });
});
