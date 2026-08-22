import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Probot } from "probot";
import {
  GitHubReviewClient,
  isReviewablePullRequest,
  type PullRequestApi,
} from "./adapters/github.js";
import { SailModelClient } from "./adapters/sail-model.js";
import { SailboxReviewEnvironment } from "./adapters/sailbox.js";
import {
  estimateWorstCaseRunCost,
  runReview,
} from "./application/review-runner.js";
import { loadRuntimeConfig } from "./config.js";
import {
  commitSha,
  deliveryId,
  installationId,
  pullNumber,
  repositoryId,
  runId,
} from "./domain/ids.js";
import { selectReviewers } from "./domain/reviewers.js";
import { migrate } from "./storage/migrations.js";
import { SqliteRunStore } from "./storage/run-store.js";

export default (app: Probot): void => {
  const config = loadRuntimeConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = new Database(config.databasePath);
  migrate(database);
  const store = new SqliteRunStore(database);

  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    async (context) => {
      if (!isReviewablePullRequest(context.payload)) {
        context.log.info({ event: context.name }, "pull request not eligible");
        return;
      }
      const payload = context.payload;
      const targetRunId = runId(randomUUID());
      const accepted = store.acceptRun({
        deliveryId: deliveryId(context.id),
        runId: targetRunId,
        installationId: installationId(payload.installation?.id),
        repositoryId: repositoryId(payload.repository.id),
        pullNumber: pullNumber(payload.pull_request.number),
        headSha: commitSha(payload.pull_request.head.sha),
        receivedAtMs: Date.now(),
      });
      if (accepted.kind !== "created") {
        context.log.info(
          { runId: accepted.runId, disposition: accepted.kind },
          "duplicate review delivery suppressed",
        );
        return;
      }

      const owner = payload.repository.owner.login;
      const repository = payload.repository.name;
      const pull = payload.pull_request.number;
      const pulls = context.octokit.rest.pulls;
      const api: PullRequestApi = {
        listFiles: async (input) => {
          const response = await pulls.listFiles(input);
          return {
            data: response.data.map((file) => ({
              filename: file.filename,
              status: file.status,
              ...(file.patch === undefined ? {} : { patch: file.patch }),
            })),
          };
        },
        listReviewComments: async (input) => {
          const response = await pulls.listReviewComments(input);
          return {
            data: response.data.map((comment) => ({ body: comment.body })),
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
      const github = new GitHubReviewClient(api, {
        owner,
        repository,
        pullNumber: pull,
      });
      context.log.info(
        { runId: targetRunId, owner, repository, pullNumber: pull },
        "review accepted",
      );
      try {
        const snapshot = await github.snapshot({
          baseSha: commitSha(payload.pull_request.base.sha),
          headSha: commitSha(payload.pull_request.head.sha),
        });
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
          runId: targetRunId,
          key: "worst-case-run",
          amount: estimateWorstCaseRunCost(reviewers.length),
          createdAtMs: Date.now(),
        });
        if (reservation.kind === "denied")
          throw new Error("Run budget reservation denied");
        const result = await runReview(
          {
            runId: targetRunId,
            owner,
            repository,
            pullNumber: pull,
            baseSha: commitSha(payload.pull_request.base.sha),
            headSha: commitSha(payload.pull_request.head.sha),
            snapshotText: snapshot.text,
            changedLines: snapshot.changedLines,
            priorStableIdentities: snapshot.priorStableIdentities,
            coverageOmissions: snapshot.coverageOmissions,
            reviewers,
          },
          {
            sandbox: new SailboxReviewEnvironment(),
            model: new SailModelClient({ apiKey: config.sailApiKey }),
            github,
          },
        );
        context.log.info(
          {
            runId: targetRunId,
            reviewId: result.reviewId,
            reviewerCount: result.reports.length,
            challengeCount: result.challenges.length,
            estimatedTotalUsdMicros: result.cost,
          },
          "review completed",
        );
      } catch (error: unknown) {
        context.log.error(
          {
            runId: targetRunId,
            error: error instanceof Error ? error.message : "unknown error",
          },
          "review failed",
        );
        throw error;
      }
    },
  );
};
