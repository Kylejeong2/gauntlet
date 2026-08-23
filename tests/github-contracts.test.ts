import { describe, expect, it } from "vitest";
import {
  classifyReviewRequestComment,
  classifyPullRequest,
  parseChangedRightLines,
} from "../src/adapters/github.js";

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  installation: { id: 1 },
  repository: {
    id: 2,
    private: false,
    name: "gauntlet",
    owner: { login: "Kylejeong2" },
  },
  pull_request: {
    number: 3,
    draft: false,
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    user: { login: "contributor", type: "User" },
  },
  ...overrides,
});

describe("GitHub contracts", () => {
  it("accepts only human @gauntlet requests on public pull requests", () => {
    const commentPayload = {
      action: "created",
      installation: { id: 1 },
      repository: {
        id: 2,
        private: false,
        name: "gauntlet",
        owner: { login: "Kylejeong2" },
      },
      issue: { number: 4, pull_request: { url: "https://api.github.test/4" } },
      comment: { body: "@gauntlet review" },
      sender: { login: "contributor", type: "User" },
    };

    expect(classifyReviewRequestComment(commentPayload)).toEqual({
      kind: "eligible",
      target: {
        installationId: 1,
        repositoryId: 2,
        pullNumber: 4,
        owner: "Kylejeong2",
        repository: "gauntlet",
      },
    });
    expect(
      classifyReviewRequestComment({
        ...commentPayload,
        comment: { body: "please review" },
      }),
    ).toEqual({ kind: "ineligible", reason: "missing_review_trigger" });
    expect(
      classifyReviewRequestComment({
        ...commentPayload,
        issue: { number: 4 },
      }),
    ).toEqual({ kind: "ineligible", reason: "not_pull_request_comment" });
    expect(
      classifyReviewRequestComment({
        ...commentPayload,
        sender: { login: "automation[bot]", type: "Bot" },
      }),
    ).toEqual({ kind: "ineligible", reason: "bot_authored_comment" });
  });

  it("extracts only added right-side lines from a unified patch", () => {
    expect(
      parseChangedRightLines(
        "@@ -1,3 +1,4 @@\n unchanged\n-old\n+new\n+added\n unchanged",
      ),
    ).toEqual([2, 3]);
  });

  it("returns one validated public target or an enum-only rejection reason", () => {
    expect(classifyPullRequest(payload())).toEqual({
      kind: "eligible",
      target: {
        installationId: 1,
        repositoryId: 2,
        pullNumber: 3,
        owner: "Kylejeong2",
        repository: "gauntlet",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    });
    expect(classifyPullRequest(payload({ action: "closed" }))).toEqual({
      kind: "ineligible",
      reason: "unsupported_action",
    });
    expect(
      classifyPullRequest(
        payload({
          repository: {
            id: 2,
            private: true,
            name: "gauntlet",
            owner: { login: "Kylejeong2" },
          },
        }),
      ),
    ).toEqual({ kind: "ineligible", reason: "private_repository" });
    expect(
      classifyPullRequest(
        payload({
          pull_request: {
            number: 3,
            draft: true,
            base: { sha: "a".repeat(40) },
            head: { sha: "b".repeat(40) },
            user: { login: "contributor", type: "User" },
          },
        }),
      ),
    ).toEqual({ kind: "ineligible", reason: "draft_pull_request" });
    expect(
      classifyPullRequest(
        payload({
          pull_request: {
            number: 3,
            draft: false,
            base: { sha: "a".repeat(40) },
            head: { sha: "b".repeat(40) },
            user: { login: "dependabot[bot]", type: "Bot" },
          },
        }),
      ),
    ).toEqual({ kind: "ineligible", reason: "bot_authored_pull_request" });
    expect(classifyPullRequest({ action: "opened" })).toEqual({
      kind: "ineligible",
      reason: "malformed_payload",
    });
  });
});
