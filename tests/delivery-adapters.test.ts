import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubReviewClient,
  upsertPullRequestSummary,
  verifyWebhookSignature,
  type PullRequestApi,
} from "../src/adapters/github.js";
import { commitSha, findingId, reviewerId, runId } from "../src/domain/ids.js";

describe("webhook authentication", () => {
  it("accepts only a matching sha256 signature", () => {
    const body = Buffer.from('{"action":"opened"}');
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, body, "sha256=deadbeef")).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
  });
});

describe("GitHub review delivery", () => {
  it("appends and replaces one marked PR-description summary", () => {
    const first = upsertPullRequestSummary(
      "## Summary\n\nAuthor-written description.",
      "One verified blocker remains.",
    );
    expect(first).toContain("Author-written description.");
    expect(first).toContain("> **Gauntlet:** One verified blocker remains.");
    const updated = upsertPullRequestSummary(
      first,
      "No verified blockers remain.",
    );
    expect(updated).toContain("Author-written description.");
    expect(updated).toContain("> **Gauntlet:** No verified blockers remain.");
    expect(updated).not.toContain("One verified blocker remains.");
    expect(updated.match(/gauntlet-pr-summary:start/g)).toHaveLength(1);
  });

  it("builds an immutable snapshot, separates reviewer comments, and submits one finding review", async () => {
    const createReview = vi
      .fn<PullRequestApi["createReview"]>()
      .mockResolvedValueOnce({
        data: { id: 91 },
      })
      .mockResolvedValueOnce({
        data: { id: 92 },
      })
      .mockResolvedValue({
        data: { id: 99 },
      });
    const compareCommits = vi
      .fn<PullRequestApi["compareCommits"]>()
      .mockResolvedValue({
        data: {
          base_commit: { sha: "a".repeat(40) },
          merge_base_commit: { sha: "c".repeat(40) },
          files: [
            {
              filename: "src/index.ts",
              status: "modified",
              patch: "@@ -1 +1,2 @@\n old\n+new",
            },
          ],
        },
      });
    const updatePull = vi
      .fn<PullRequestApi["updatePull"]>()
      .mockResolvedValue({ data: {} });
    const api: PullRequestApi = {
      getPull: () =>
        Promise.resolve({
          data: {
            head: { sha: "b".repeat(40) },
            body: "## Summary\n\nOriginal author text.",
            repository: { id: 2, private: false },
          },
        }),
      updatePull,
      compareCommits,
      listReviewComments: () =>
        Promise.resolve({
          data: [{ body: "<!-- gauntlet:already-seen -->" }],
        }),
      listReviews: () => Promise.resolve({ data: [] }),
      createReview,
    };
    const client = new GitHubReviewClient(api, {
      owner: "Kylejeong2",
      repository: "gauntlet",
      pullNumber: 1,
    });
    const snapshot = await client.snapshot({
      installationId: 1,
      repositoryId: 2,
      runId: runId("run-snapshot"),
      baseSha: commitSha("a".repeat(40)),
      headSha: commitSha("b".repeat(40)),
    });
    expect(snapshot.mergeBaseSha).toBe(commitSha("c".repeat(40)));
    expect(snapshot.files).toEqual([
      {
        ordinal: 0,
        kind: "reviewable",
        path: "src/index.ts",
        status: "modified",
        patch: "@@ -1 +1,2 @@\n old\n+new",
        changedLines: [2],
      },
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: "Kylejeong2",
      repo: "gauntlet",
      basehead: `${"a".repeat(40)}...${"b".repeat(40)}`,
    });
    expect(await client.priorStableIdentities()).toEqual(["already-seen"]);

    const publication = await client.publish({
      kind: "publish",
      runId: runId("run-publish"),
      headSha: commitSha("b".repeat(40)),
      body: "## Gauntlet summary",
      pullRequestSummary: "One verified blocker remains.",
      reviewerComments: [
        {
          reviewer: reviewerId("security"),
          body: "## Security reviewer: 1/5\n\nConfirmed injection.\n\n<!-- gauntlet-reviewer:run-publish:security -->",
        },
        {
          reviewer: reviewerId("performance"),
          body: "## Performance reviewer: 5/5\n\nNo performance defect.\n\n<!-- gauntlet-reviewer:run-publish:performance -->",
        },
      ],
      comments: [
        {
          finding: {
            id: findingId("finding-1"),
            reviewer: reviewerId("security"),
            location: { path: "src/index.ts", line: 2 },
            severity: "high",
            confidence: 0.9,
            title: "Injection",
            trigger: "Untrusted input reaches a shell.",
            evidence: "The changed line is reachable.",
            proposedAction: "Use an argument vector.",
            stableIdentity: "shell-injection:name",
          },
          body: "Verified finding",
        },
      ],
    });
    expect(publication).toEqual({ reviewId: 99 });
    expect(updatePull).toHaveBeenCalledTimes(1);
    const updateInput = updatePull.mock.calls[0]?.[0];
    expect(updateInput).toMatchObject({
      owner: "Kylejeong2",
      repo: "gauntlet",
      pull_number: 1,
    });
    expect(updateInput?.body).toContain(
      "> **Gauntlet:** One verified blocker remains.",
    );
    expect(createReview).toHaveBeenCalledTimes(3);
    expect(createReview).toHaveBeenNthCalledWith(1, {
      owner: "Kylejeong2",
      repo: "gauntlet",
      pull_number: 1,
      commit_id: "b".repeat(40),
      event: "COMMENT",
      body: "## Security reviewer: 1/5\n\nConfirmed injection.\n\n<!-- gauntlet-reviewer:run-publish:security -->",
      comments: [],
    });
    expect(createReview).toHaveBeenNthCalledWith(2, {
      owner: "Kylejeong2",
      repo: "gauntlet",
      pull_number: 1,
      commit_id: "b".repeat(40),
      event: "COMMENT",
      body: "## Performance reviewer: 5/5\n\nNo performance defect.\n\n<!-- gauntlet-reviewer:run-publish:performance -->",
      comments: [],
    });
    expect(createReview).toHaveBeenNthCalledWith(3, {
      owner: "Kylejeong2",
      repo: "gauntlet",
      pull_number: 1,
      commit_id: "b".repeat(40),
      event: "COMMENT",
      body: "## Gauntlet summary",
      comments: [
        {
          path: "src/index.ts",
          line: 2,
          side: "RIGHT",
          body: "Verified finding",
        },
      ],
    });
  });

  it("reconciles a previously submitted run after a crash", async () => {
    const api: PullRequestApi = {
      getPull: () => Promise.reject(new Error("must not capture")),
      updatePull: () => Promise.reject(new Error("must not update")),
      compareCommits: () => Promise.reject(new Error("must not capture")),
      listReviewComments: () => Promise.resolve({ data: [] }),
      listReviews: () =>
        Promise.resolve({
          data: [
            {
              id: 77,
              body: "## Gauntlet review\n\n<!-- gauntlet-run:run-1 -->",
            },
          ],
        }),
      createReview: () => Promise.reject(new Error("must not publish")),
    };
    const client = new GitHubReviewClient(api, {
      owner: "Kylejeong2",
      repository: "gauntlet",
      pullNumber: 1,
    });
    expect(await client.findExisting(runId("run-1"))).toEqual({ reviewId: 77 });
  });
});
