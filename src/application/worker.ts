import type { RunId, WorkerId } from "../domain/ids.js";
import type { Lease, QueuedRun, SqliteRunStore } from "../storage/run-store.js";

type WorkerStore = Pick<
  SqliteRunStore,
  "claimNext" | "getRun" | "completeLease" | "failLease"
>;

export class DurableReviewWorker {
  readonly #workerId: WorkerId;
  readonly #leaseDurationMs: number;
  readonly #clock: () => number;
  readonly #store: WorkerStore;
  readonly #execute: (run: QueuedRun) => Promise<void>;
  #activeDrain: Promise<number> | undefined;

  public constructor(
    options: Readonly<{
      workerId: WorkerId;
      leaseDurationMs: number;
      clock?: () => number;
      store: WorkerStore;
      execute: (run: QueuedRun) => Promise<void>;
    }>,
  ) {
    this.#workerId = options.workerId;
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#clock = options.clock ?? Date.now;
    this.#store = options.store;
    this.#execute = options.execute;
  }

  public drain(maxRuns = 10): Promise<number> {
    if (this.#activeDrain !== undefined) return this.#activeDrain;
    const drain = this.#drain(maxRuns).finally(() => {
      if (this.#activeDrain === drain) this.#activeDrain = undefined;
    });
    this.#activeDrain = drain;
    return drain;
  }

  async #drain(maxRuns: number): Promise<number> {
    if (!Number.isInteger(maxRuns) || maxRuns < 1)
      throw new Error("maxRuns must be a positive integer");
    let processed = 0;
    while (processed < maxRuns) {
      const lease = this.#store.claimNext({
        workerId: this.#workerId,
        nowMs: this.#clock(),
        leaseDurationMs: this.#leaseDurationMs,
      });
      if (lease === null) return processed;
      await this.#processLease(lease);
      processed += 1;
    }
    return processed;
  }

  async #processLease(lease: Lease): Promise<void> {
    try {
      const run = this.#store.getRun(lease.runId);
      await this.#execute(run);
      this.#store.completeLease({
        runId: lease.runId,
        workerId: this.#workerId,
        nowMs: this.#clock(),
      });
    } catch (error: unknown) {
      this.#store.failLease({
        runId: lease.runId,
        workerId: this.#workerId,
        nowMs: this.#clock(),
        reason: errorMessage(error, lease.runId),
      });
    }
  }
}

const errorMessage = (error: unknown, targetRunId: RunId): string =>
  error instanceof Error
    ? error.message
    : `Unknown failure while processing ${targetRunId}`;
