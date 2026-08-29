import type { WorkerId } from "../domain/ids.js";
import type { SqliteRunStore, WorkLease } from "../storage/run-store.js";

type WorkerStore = Pick<
  SqliteRunStore,
  "claimNextWork" | "heartbeatWork" | "retryWork"
>;

export class DurableReviewWorker {
  readonly #workerId: WorkerId;
  readonly #leaseDurationMs: number;
  readonly #clock: () => number;
  readonly #store: WorkerStore;
  readonly #execute: (lease: WorkLease) => Promise<void>;
  #activeDrain: Promise<number> | undefined;

  public constructor(
    options: Readonly<{
      workerId: WorkerId;
      leaseDurationMs: number;
      clock?: () => number;
      store: WorkerStore;
      execute: (lease: WorkLease) => Promise<void>;
    }>,
  ) {
    this.#workerId = options.workerId;
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#clock = options.clock ?? Date.now;
    this.#store = options.store;
    this.#execute = options.execute;
  }

  public drain(maxWorkItems = 50): Promise<number> {
    if (this.#activeDrain !== undefined) return this.#activeDrain;
    const drain = this.#drain(maxWorkItems).finally(() => {
      if (this.#activeDrain === drain) this.#activeDrain = undefined;
    });
    this.#activeDrain = drain;
    return drain;
  }

  async #drain(maxWorkItems: number): Promise<number> {
    if (!Number.isInteger(maxWorkItems) || maxWorkItems < 1)
      throw new Error("maxWorkItems must be a positive integer");
    let processed = 0;
    while (processed < maxWorkItems) {
      const lease = this.#store.claimNextWork({
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

  async #processLease(lease: WorkLease): Promise<void> {
    let heartbeatError: unknown;
    const heartbeat = setInterval(
      () => {
        try {
          this.#store.heartbeatWork({
            lease,
            nowMs: this.#clock(),
            leaseDurationMs: this.#leaseDurationMs,
          });
        } catch (error: unknown) {
          heartbeatError = error;
        }
      },
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
    );
    heartbeat.unref();
    try {
      await this.#execute(lease);
      if (heartbeatError !== undefined) throw asError(heartbeatError);
    } catch (error: unknown) {
      this.#store.retryWork({
        lease,
        nowMs: this.#clock(),
        retryAtMs: this.#clock() + retryDelayMs(lease.attempt),
        reason: errorMessage(error),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

const retryDelayMs = (attempt: number): number =>
  Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown durable work failure";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(errorMessage(error));
