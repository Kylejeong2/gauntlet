import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Probot } from "probot";
import {
  classifyPullRequest,
  GitHubReviewClient,
  type PullRequestApi,
} from "./adapters/github.js";
import { SailModelClient } from "./adapters/sail-model.js";
import {
  SailboxReviewEnvironment,
  SailSdkFactory,
} from "./adapters/sailbox.js";
import {
  estimateWorstCaseRunCost,
  runReview,
} from "./application/review-runner.js";
import { DurableReviewWorker } from "./application/worker.js";
import { loadRuntimeConfig } from "./config.js";
import { deliveryId, runId, workerId } from "./domain/ids.js";
import { selectReviewers } from "./domain/reviewers.js";
import { projectSnapshot } from "./domain/snapshot.js";
import { migrate } from "./storage/migrations.js";
import { SqliteRunStore, type QueuedRun } from "./storage/run-store.js";

export default (app: Probot): void => {
  const config = loadRuntimeConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = new Database(config.databasePath);
  migrate(database);
  const store = new SqliteRunStore(database);
  const worker = new DurableReviewWorker({
    workerId: workerId(`worker-${randomUUID()}`),
    leaseDurationMs: 30 * 60 * 1_000,
    store,
    execute: async (run) => {
      try {
        await executeQueuedRun(app, store, config.sailApiKey, run);
      } catch (error: unknown) {
        app.log.error(
          {
            runId: run.runId,
            error: error instanceof Error ? error.message : "unknown error",
          },
          "review failed",
        );
        throw error;
      }
    },
  });
  const wakeWorker = (): void => {
    void worker.drain().catch((error: unknown) => {
      app.log.error(
        { error: error instanceof Error ? error.message : "unknown error" },
        "review worker drain failed",
      );
    });
  };
  const interval = setInterval(wakeWorker, 5_000);
  interval.unref();
  wakeWorker();

  app.on("pull_request", (context) => {
    const eligibility = classifyPullRequest(context.payload);
    if (eligibility.kind === "ineligible") {
      const recorded = store.recordIneligibleDelivery({
        deliveryId: deliveryId(context.id),
        reason: eligibility.reason,
        receivedAtMs: Date.now(),
      });
      context.log.info(
        { reason: recorded.reason, disposition: recorded.kind },
        "pull request delivery ignored",
      );
      return;
    }
    const target = eligibility.target;
    const targetRunId = runId(randomUUID());
    const accepted = store.acceptRun({
      deliveryId: deliveryId(context.id),
      runId: targetRunId,
      ...target,
      receivedAtMs: Date.now(),
    });
    context.log.info(
      {
        runId: accepted.runId,
        owner: target.owner,
        repository: target.repository,
        pullNumber: target.pullNumber,
        disposition: accepted.kind,
      },
      accepted.kind === "created"
        ? "review accepted"
        : "duplicate review delivery suppressed",
    );
    if (accepted.kind === "created") wakeWorker();
  });
};

const executeQueuedRun = async (
  app: Probot,
  store: SqliteRunStore,
  sailApiKey: string,
  run: QueuedRun,
): Promise<void> => {
  const model = new SailModelClient({
    apiKey: sailApiKey,
    audit: (event) => {
      app.log.info({ runId: run.runId, ...event }, "model audit event");
    },
  });
  const sandbox = new SailboxReviewEnvironment(
    new SailSdkFactory(),
    (event) => {
      app.log.info({ runId: run.runId, ...event }, "sailbox audit event");
    },
  );
  const octokit = await app.auth(run.installationId);
  const github = new GitHubReviewClient(makePullRequestApi(octokit), {
    owner: run.owner,
    repository: run.repository,
    pullNumber: run.pullNumber,
  });
  const existing = await github.findExisting(run.runId);
  if (existing !== null) {
    app.log.info(
      { runId: run.runId, reviewId: existing.reviewId },
      "published review reconciled",
    );
    return;
  }
  const captured =
    store.getSnapshot(run.runId) ??
    store.putSnapshotOnce({
      runId: run.runId,
      snapshot: await github.snapshot({
        runId: run.runId,
        installationId: run.installationId,
        repositoryId: run.repositoryId,
        baseSha: run.baseSha,
        headSha: run.headSha,
      }),
      capturedAtMs: Date.now(),
    });
  const snapshot = projectSnapshot(captured);
  const priorStableIdentities = await github.priorStableIdentities();
  const optional = [
    /(?:^|\/)tests?\//i.test(snapshot.text) ||
    /\.(?:test|spec)\./i.test(snapshot.text)
      ? "test-quality"
      : undefined,
    /\b(?:mutex|lock|atomic|concurr|parallel|worker|queue|transaction)\b/i.test(
      snapshot.text,
    )
      ? "concurrency"
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const reviewers = selectReviewers(optional);
  const reservation = store.reserveBudget({
    runId: run.runId,
    key: "worst-case-run",
    amount: estimateWorstCaseRunCost(reviewers.length),
    createdAtMs: Date.now(),
  });
  if (reservation.kind === "denied")
    throw new Error("Run budget reservation denied");
  const result = await runReview(
    {
      runId: run.runId,
      owner: run.owner,
      repository: run.repository,
      pullNumber: run.pullNumber,
      baseSha: run.baseSha,
      mergeBaseSha: captured.mergeBaseSha,
      headSha: run.headSha,
      snapshotText: snapshot.text,
      changedLines: snapshot.changedLines,
      priorStableIdentities,
      coverageOmissions: snapshot.coverageOmissions,
      reviewers,
    },
    {
      sandbox,
      model,
      github,
      audit: (event) => {
        app.log.info({ runId: run.runId, ...event }, "review audit event");
      },
    },
  );
  store.settleBudget({
    runId: run.runId,
    key: "worst-case-run",
    actualAmount: result.cost,
    settledAtMs: Date.now(),
  });
  app.log.info(
    {
      runId: run.runId,
      reviewId: result.reviewId,
      reviewerCount: result.reports.length,
      challengeCount: result.challenges.length,
      estimatedTotalUsdMicros: result.cost,
    },
    "review completed",
  );
};

type InstallationOctokit = Awaited<ReturnType<Probot["auth"]>>;

const makePullRequestApi = (octokit: InstallationOctokit): PullRequestApi => {
  const pulls = octokit.rest.pulls;
  const repos = octokit.rest.repos;
  return {
    getPull: async (input) => {
      const response = await pulls.get(input);
      return {
        data: {
          head: { sha: response.data.head.sha },
          repository: {
            id: response.data.base.repo.id,
            private: response.data.base.repo.private,
          },
        },
      };
    },
    compareCommits: async (input) => {
      const response = await repos.compareCommitsWithBasehead(input);
      return {
        data: {
          base_commit: { sha: response.data.base_commit.sha },
          merge_base_commit: { sha: response.data.merge_base_commit.sha },
          ...(response.data.files === undefined
            ? {}
            : {
                files: response.data.files.map((file) => ({
                  filename: file.filename,
                  status: file.status,
                  ...(file.patch === undefined ? {} : { patch: file.patch }),
                })),
              }),
        },
      };
    },
    listReviewComments: async (input) => {
      const response = await pulls.listReviewComments(input);
      return {
        data: response.data.map((comment) => ({ body: comment.body })),
      };
    },
    listReviews: async (input) => {
      const response = await pulls.listReviews(input);
      return {
        data: response.data.map((review) => ({
          id: review.id,
          body: review.body,
        })),
      };
    },
    createReview: async (input) => {
      const response = await pulls.createReview({
        ...input,
        comments: input.comments.map((comment) => ({ ...comment })),
      });
      return { data: { id: response.data.id } };
    },
  };
};
