import { describe, expect, it } from "vitest";
import { DurableReviewWorker } from "../src/application/worker.js";
import { runId, workerId } from "../src/domain/ids.js";
import type { WorkLease } from "../src/storage/run-store.js";

const lease: WorkLease = {
  workKey: "run-1:snapshot",
  runId: runId("run-1"),
  kind: "snapshot",
  workerId: workerId("worker-1"),
  expiresAtMs: 61_000,
  attempt: 1,
  maxAttempts: 3,
};

describe("durable review worker", () => {
  it("claims and executes one persisted phase at a time", async () => {
    const events: string[] = [];
    let claimed = false;
    const worker = new DurableReviewWorker({
      workerId: lease.workerId,
      leaseDurationMs: 60_000,
      clock: () => 1_000,
      store: {
        claimNextWork: () => {
          if (claimed) return null;
          claimed = true;
          return lease;
        },
        heartbeatWork: () => lease,
        retryWork: () => "retry_scheduled",
      },
      execute: (work) => {
        events.push(`executed:${work.workKey}`);
        return Promise.resolve();
      },
    });
    expect(await worker.drain()).toBe(1);
    expect(events).toEqual(["executed:run-1:snapshot"]);
  });

  it("schedules a bounded retry without losing the phase error", async () => {
    let claimed = false;
    const failures: string[] = [];
    const worker = new DurableReviewWorker({
      workerId: lease.workerId,
      leaseDurationMs: 60_000,
      clock: () => 1_000,
      store: {
        claimNextWork: () => {
          if (claimed) return null;
          claimed = true;
          return lease;
        },
        heartbeatWork: () => lease,
        retryWork: (request) => {
          failures.push(request.reason);
          return "retry_scheduled";
        },
      },
      execute: () => Promise.reject(new Error("provider unavailable")),
    });
    expect(await worker.drain()).toBe(1);
    expect(failures).toEqual(["provider unavailable"]);
  });
});
