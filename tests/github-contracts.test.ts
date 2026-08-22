import { describe, expect, it } from "vitest";
import {
  isReviewablePullRequest,
  parseChangedRightLines,
} from "../src/adapters/github.js";

describe("GitHub contracts", () => {
  it("extracts only added right-side lines from a unified patch", () => {
    expect(
      parseChangedRightLines(
        "@@ -1,3 +1,4 @@\n unchanged\n-old\n+new\n+added\n unchanged",
      ),
    ).toEqual([2, 3]);
  });

  it("accepts supported public non-draft pull request actions", () => {
    expect(
      isReviewablePullRequest({
        action: "synchronize",
        repository: { private: false },
        pull_request: { draft: false },
      }),
    ).toBe(true);
    expect(
      isReviewablePullRequest({
        action: "opened",
        repository: { private: true },
        pull_request: { draft: false },
      }),
    ).toBe(false);
    expect(
      isReviewablePullRequest({
        action: "closed",
        repository: { private: false },
        pull_request: { draft: false },
      }),
    ).toBe(false);
  });
});
