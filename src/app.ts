import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Probot } from "probot";
import {
  classifyPullRequest,
  classifyReviewRequestComment,
  GitHubReviewClient,
  type PullRequestApi,
} from "./adapters/github.js";
import { SailModelClient } from "./adapters/sail-model.js";
import {
  SailboxReviewEnvironment,
  SailSdkFactory,
} from "./adapters/sailbox.js";
import {
  DurableReviewEngine,
  type DurableReviewEnginePorts,
} from "./application/durable-review-engine.js";
import { DurableReviewWorker } from "./application/worker.js";
import { loadRuntimeConfig } from "./config.js";
import { deliveryId, runId, workerId, type RunId } from "./domain/ids.js";
import { migrate } from "./storage/migrations.js";
import { SqliteRunStore, type QueuedRun } from "./storage/run-store.js";

export default (app: Probot): void => {
  const config = loadRuntimeConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = new Database(config.databasePath);
  migrate(database);
  const store = new SqliteRunStore(database);
  const sandbox = new SailboxReviewEnvironment(
    new SailSdkFactory(),
    (event) => {
      app.log.info(event, "sailbox audit event");
    },
  );
  const engine = new DurableReviewEngine({
    store,
    ports: durablePorts(app, config.sailApiKey, sandbox),
  });
  const worker = new DurableReviewWorker({
    workerId: workerId(`worker-${randomUUID()}`),
    leaseDurationMs: 30 * 60 * 1_000,
    store,
    execute: async (lease) => {
      try {
        await engine.advance(lease);
      } catch (error: unknown) {
        app.log.error(
          {
            runId: lease.runId,
            workKey: lease.workKey,
            workKind: lease.kind,
            attempt: lease.attempt,
            error: error instanceof Error ? error.message : "unknown error",
          },
          "durable review phase failed",
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

  app.on("issue_comment.created", async (context) => {
    const request = classifyReviewRequestComment(context.payload);
    if (request.kind === "ineligible") {
      context.log.info(
        { reason: request.reason },
        "review request comment ignored",
      );
      return;
    }
    const target = request.target;
    const pull = await context.octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repository,
      pull_number: target.pullNumber,
    });
    const eligibility = classifyPullRequest({
      action: "opened",
      installation: { id: target.installationId },
      repository: {
        id: target.repositoryId,
        private: context.payload.repository.private,
        name: target.repository,
        owner: { login: target.owner },
      },
      pull_request: pull.data,
    });
    if (eligibility.kind === "ineligible") {
      context.log.info(
        { reason: eligibility.reason },
        "review request comment ignored",
      );
      return;
    }
    const reviewTarget = eligibility.target;
    const accepted = store.acceptRun({
      deliveryId: deliveryId(context.id),
      runId: runId(randomUUID()),
      ...reviewTarget,
      receivedAtMs: Date.now(),
    });
    context.log.info(
      {
        runId: accepted.runId,
        owner: reviewTarget.owner,
        repository: reviewTarget.repository,
        pullNumber: reviewTarget.pullNumber,
        disposition: accepted.kind,
      },
      accepted.kind === "created"
        ? "review accepted from @gauntlet request"
        : "duplicate @gauntlet review request suppressed",
    );
    if (accepted.kind === "created") wakeWorker();
  });
};

const durablePorts = (
  app: Probot,
  sailApiKey: string,
  sandbox: SailboxReviewEnvironment,
): DurableReviewEnginePorts => ({
  model: {
    review: ({ runId: targetRunId, ...request }) =>
      modelForRun(app, sailApiKey, targetRunId).review(request),
    challenge: ({ runId: targetRunId, ...request }) =>
      modelForRun(app, sailApiKey, targetRunId).challenge(request),
    summarize: ({ runId: targetRunId, ...request }) =>
      modelForRun(app, sailApiKey, targetRunId).summarize(request),
  },
  sandbox,
  audit: (event) => {
    app.log.info(event, "durable review checkpoint");
  },
  github: {
    snapshot: async (run) => {
      const github = await githubForRun(app, run);
      return github.snapshot({
        runId: run.runId,
        installationId: run.installationId,
        repositoryId: run.repositoryId,
        baseSha: run.baseSha,
        headSha: run.headSha,
      });
    },
    priorStableIdentities: async (run) =>
      (await githubForRun(app, run)).priorStableIdentities(),
    findExisting: async (run) =>
      (await githubForRun(app, run)).findExisting(run.runId),
    publish: async (run, plan) => (await githubForRun(app, run)).publish(plan),
  },
});

const modelForRun = (
  app: Probot,
  sailApiKey: string,
  targetRunId: RunId,
): SailModelClient =>
  new SailModelClient({
    apiKey: sailApiKey,
    audit: (event) => {
      app.log.info({ runId: targetRunId, ...event }, "model audit event");
    },
  });

const githubForRun = async (
  app: Probot,
  run: QueuedRun,
): Promise<GitHubReviewClient> => {
  const octokit = await app.auth(run.installationId);
  return new GitHubReviewClient(makePullRequestApi(octokit), {
    owner: run.owner,
    repository: run.repository,
    pullNumber: run.pullNumber,
  });
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
          body: response.data.body,
          repository: {
            id: response.data.base.repo.id,
            private: response.data.base.repo.private,
          },
        },
      };
    },
    updatePull: async (input) => {
      await pulls.update(input);
      return { data: {} };
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
