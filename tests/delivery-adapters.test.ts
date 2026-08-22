import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubReviewClient,
  verifyWebhookSignature,
  type PullRequestApi,
} from "../src/adapters/github.js";
import { commitSha, findingId, reviewerId } from "../src/domain/ids.js";

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
  it("builds an immutable snapshot and submits one COMMENT review", async () => {
    const createReview = vi
      .fn<PullRequestApi["createReview"]>()
      .mockResolvedValue({
        data: { id: 99 },
      });
    const api: PullRequestApi = {
      listFiles: () =>
        Promise.resolve({
          data: [
            {
              filename: "src/index.ts",
              status: "modified",
              patch: "@@ -1 +1,2 @@\n old\n+new",
            },
          ],
        }),
      listReviewComments: () =>
        Promise.resolve({
          data: [{ body: "<!-- gauntlet:already-seen -->" }],
        }),
      createReview,
    };
    const client = new GitHubReviewClient(api, {
      owner: "Kylejeong2",
      repository: "gauntlet",
      pullNumber: 1,
    });
    const snapshot = await client.snapshot({
      baseSha: commitSha("a".repeat(40)),
      headSha: commitSha("b".repeat(40)),
    });
    expect(snapshot.changedLines).toEqual([
      { path: "src/index.ts", lines: [2] },
    ]);
    expect(snapshot.priorStableIdentities).toEqual(["already-seen"]);

    const publication = await client.publish({
      kind: "publish",
      headSha: commitSha("b".repeat(40)),
      body: "## Gauntlet review",
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
    expect(createReview).toHaveBeenCalledWith({
      owner: "Kylejeong2",
      repo: "gauntlet",
      pull_number: 1,
      commit_id: "b".repeat(40),
      event: "COMMENT",
      body: "## Gauntlet review",
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
});
