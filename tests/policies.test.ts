import { describe, expect, it } from "vitest";
import {
  BUDGET_LIMIT,
  BudgetLedger,
  estimateModelRequest,
} from "../src/domain/budget.js";
import {
  commitSha,
  findingId,
  reviewerId,
  runId,
  usdMicros,
} from "../src/domain/ids.js";
import { reducePublication } from "../src/domain/publication.js";
import { redact } from "../src/domain/redaction.js";
import { deriveNextWork, type NextWork } from "../src/domain/scheduler.js";
import type {
  CandidateFinding,
  ChallengeVerdict,
  ReviewerReport,
  RunView,
} from "../src/domain/types.js";

describe("AC-13 budget policy", () => {
  it("estimates with integer microdollars and refuses reservations over $0.25", () => {
    expect(
      estimateModelRequest({
        inputTokens: 1_000,
        outputTokens: 200,
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.3,
      }),
    ).toBe(160);
    const ledger = new BudgetLedger(BUDGET_LIMIT);
    expect(
      ledger.reserve({ key: "mandatory", amount: usdMicros(249_999) }).kind,
    ).toBe("reserved");
    expect(ledger.reserve({ key: "overflow", amount: usdMicros(2) })).toEqual({
      kind: "denied",
      available: usdMicros(1),
    });
    expect(
      ledger.reserve({ key: "mandatory", amount: usdMicros(100) }).kind,
    ).toBe("already_reserved");
  });
});

const finding = (
  overrides: Partial<CandidateFinding> = {},
): CandidateFinding => ({
  id: findingId("finding-a"),
  reviewer: reviewerId("security"),
  location: { path: "src/index.ts", line: 12 },
  severity: "high",
  confidence: 0.9,
  title: "Injection",
  trigger: "Untrusted name reaches exec.",
  evidence: "A focused reproduction executed a substituted command.",
  proposedAction: "Use an argument vector.",
  stableIdentity: "injection:name",
  ...overrides,
});

const report = (candidate: CandidateFinding): ReviewerReport => ({
  reviewer: candidate.reviewer,
  readiness: 2,
  rationale: "A blocking defect remains.",
  examinedAreas: ["process boundary"],
  findings: [candidate],
});

const reviewSummary = {
  headline: "Review complete",
  overview: "The specialist review has been synthesized.",
  topRisk: "Review the verified findings.",
  nextAction: "Address confirmed defects.",
};

describe("AC-7, AC-8, and AC-10 publication reduction", () => {
  it("requires confirmed challenges and exact reviewed-head changed lines", () => {
    const a = finding();
    const outsideDiff = finding({
      id: findingId("finding-b"),
      location: { path: "src/index.ts", line: 99 },
    });
    const rejected = finding({
      id: findingId("finding-c"),
      location: { path: "src/index.ts", line: 13 },
    });
    const result = reducePublication({
      runId: runId("run-1"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [reviewerId("security")],
      reports: [{ ...report(a), findings: [a, outsideDiff, rejected] }],
      challenges: [
        {
          kind: "confirmed",
          findingId: a.id,
          reason: "Reproduction proves reachability.",
        },
        {
          kind: "confirmed",
          findingId: outsideDiff.id,
          reason: "Real but outside the diff.",
        },
        {
          kind: "rejected",
          findingId: rejected.id,
          reason: "Guard prevents it.",
        },
      ],
      changedLines: [{ path: "src/index.ts", lines: [12, 13] }],
      priorStableIdentities: [],
      coverageOmissions: [],
      estimatedCost: usdMicros(10_000),
      durationMs: 207_648,
      reviewSummary: {
        headline: "Unsafe shell execution blocks this change",
        overview:
          "The pull request introduces a reachable command injection in the changed process boundary. The independent verification supports blocking the change until shell interpolation is removed.",
        topRisk: "An attacker can execute arbitrary commands.",
        nextAction: "Replace exec with an argument-vector API.",
      },
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.comments.map((comment) => comment.finding.id)).toEqual([
        a.id,
      ]);
      expect(result.body).toContain("**Duration:** 207.6s");
      expect(result.body).not.toContain("207648ms");
      expect(result.body).toContain(
        "Unsafe shell execution blocks this change",
      );
      expect(result.body).toContain("**Readiness:** 2.0/5");
      expect(result.body).not.toContain("## What changed");
      expect(result.body).not.toContain("## Key risks");
      expect(result.body).not.toContain("## Recommended next steps");
      expect(result.body).not.toContain("<summary>Prompt to fix</summary>");
      expect(result.pullRequestSummary).toBe(
        "Unsafe shell execution blocks this change",
      );
      expect(result.reviewerComments[0]?.body).toContain(
        "<summary>Prompt to fix</summary>",
      );
      expect(result.comments[0]?.body).toContain(
        "<summary>Prompt to fix</summary>",
      );
    }
  });

  it("requires cross-specialist corroboration and collapses same-line duplicates", () => {
    const security = finding({ id: findingId("security-injection") });
    const adversarial = finding({
      id: findingId("adversarial-injection"),
      reviewer: reviewerId("adversarial-testing"),
      title: "Shell injection through name",
      stableIdentity: "shell-injection:name",
    });
    const speculative = finding({
      id: findingId("documentation-guess"),
      reviewer: reviewerId("documentation"),
      location: { path: "README.md", line: 4 },
      severity: "medium",
      title: "Missing example",
      stableIdentity: "readme-example",
    });
    const candidates = [security, adversarial, speculative];
    const result = reducePublication({
      runId: runId("run-consensus"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [
        reviewerId("security"),
        reviewerId("adversarial-testing"),
        reviewerId("documentation"),
      ],
      reports: [
        { ...report(security), readiness: 1 },
        { ...report(adversarial), readiness: 4 },
        {
          ...report(speculative),
          readiness: 5,
          rationale: "No documentation action is required.",
        },
      ],
      challenges: candidates.map((candidate) => ({
        kind: "confirmed" as const,
        findingId: candidate.id,
        reason: "Confirmed.",
      })),
      changedLines: [
        { path: "src/index.ts", lines: [12] },
        { path: "README.md", lines: [4] },
      ],
      priorStableIdentities: [],
      coverageOmissions: [],
      estimatedCost: usdMicros(10_000),
      durationMs: 1000,
      reviewSummary,
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.reviewerComments).toHaveLength(3);
      expect(result.reviewerComments[0]?.body).toContain(
        "Security reviewer: 1/5",
      );
      expect(result.reviewerComments[0]?.body).toContain(
        "<summary>Prompt to fix</summary>",
      );
      expect(result.reviewerComments[1]?.body).toContain(
        "<summary>Prompt to fix</summary>",
      );
      expect(result.reviewerComments[2]?.body).not.toContain(
        "<summary>Prompt to fix</summary>",
      );
      expect(result.body).toContain("**Readiness:** 3.3/5");
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.body).toContain(
        "**Adversarial Testing reviewer · HIGH: Shell injection through name**",
      );
      expect(result.comments[0]?.finding.location).toEqual({
        path: "src/index.ts",
        line: 12,
      });
    }
  });

  it("omits fix prompts when a specialist and the overall review score 5/5", () => {
    const result = reducePublication({
      runId: runId("run-ready"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [reviewerId("documentation")],
      reports: [
        {
          reviewer: reviewerId("documentation"),
          readiness: 5,
          rationale: "The documentation is complete and accurate.",
          examinedAreas: ["documentation"],
          findings: [],
        },
      ],
      challenges: [],
      changedLines: [{ path: "README.md", lines: [1] }],
      priorStableIdentities: [],
      coverageOmissions: [],
      estimatedCost: usdMicros(1_000),
      durationMs: 1000,
      reviewSummary: {
        headline: "Ready to merge",
        overview: "No actionable concerns remain.",
        topRisk: "No verified material risk.",
        nextAction: "No action required.",
      },
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.reviewerComments[0]?.body).not.toContain(
        "<summary>Prompt to fix</summary>",
      );
      expect(result.body).toContain("**Readiness:** 5.0/5");
      expect(result.body).not.toContain("<summary>Prompt to fix</summary>");
    }
  });

  it("does not depress readiness or offer fixes without an actionable finding", () => {
    const rejected = finding({
      reviewer: reviewerId("documentation"),
      location: { path: "README.md", line: 1 },
    });
    const result = reducePublication({
      runId: runId("run-no-actionable-finding"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [
        reviewerId("api-compatibility"),
        reviewerId("documentation"),
      ],
      reports: [
        {
          reviewer: reviewerId("api-compatibility"),
          readiness: 4,
          rationale: "No compatibility break was found.",
          examinedAreas: ["public API"],
          findings: [],
        },
        {
          ...report(rejected),
          readiness: 1,
        },
      ],
      challenges: [
        {
          kind: "rejected",
          findingId: rejected.id,
          reason: "The claimed defect is not present.",
        },
      ],
      changedLines: [{ path: "README.md", lines: [1] }],
      priorStableIdentities: [],
      coverageOmissions: [],
      estimatedCost: usdMicros(1_000),
      durationMs: 1_000,
      reviewSummary,
    });

    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.body).toContain("**Readiness:** 5.0/5");
      expect(result.comments).toHaveLength(0);
      expect(result.reviewerComments).toHaveLength(2);
      for (const comment of result.reviewerComments) {
        expect(comment.body).toContain("reviewer: 5/5");
        expect(comment.body).not.toContain("Prompt to fix");
      }
    }
  });

  it("deduplicates semantically, suppresses prior identities, ranks deterministically, and caps at five", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      finding({
        id: findingId(`finding-${String(index)}`),
        location: { path: "src/index.ts", line: index + 1 },
        severity: index === 7 ? "critical" : "medium",
        confidence: 0.5 + index / 100,
        stableIdentity: index < 2 ? "duplicate" : `identity-${String(index)}`,
      }),
    );
    const challenges: ChallengeVerdict[] = candidates.map((candidate) => ({
      kind: "confirmed",
      findingId: candidate.id,
      reason: "Confirmed.",
    }));
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined)
      throw new Error("Fixture must contain a candidate");
    const result = reducePublication({
      runId: runId("run-1"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [reviewerId("security")],
      reports: [{ ...report(firstCandidate), findings: candidates }],
      challenges,
      changedLines: [
        {
          path: "src/index.ts",
          lines: candidates.map((_, index) => index + 1),
        },
      ],
      priorStableIdentities: ["identity-6"],
      coverageOmissions: [],
      estimatedCost: usdMicros(10_000),
      durationMs: 1000,
      reviewSummary,
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.comments).toHaveLength(5);
      expect(result.comments[0]?.finding.id).toBe(findingId("finding-7"));
      expect(
        new Set(
          result.comments.map((comment) => comment.finding.stableIdentity),
        ).size,
      ).toBe(5);
      expect(
        result.comments.some(
          (comment) => comment.finding.stableIdentity === "identity-6",
        ),
      ).toBe(false);
    }
  });

  it("fails closed when a selected reviewer report is missing", () => {
    expect(
      reducePublication({
        runId: runId("run-1"),
        headSha: commitSha("a".repeat(40)),
        selectedReviewers: [reviewerId("security")],
        reports: [],
        challenges: [],
        changedLines: [],
        priorStableIdentities: [],
        coverageOmissions: [],
        estimatedCost: usdMicros(0),
        durationMs: 0,
        reviewSummary,
      }),
    ).toEqual({
      kind: "skip",
      reason: "missing_reviewer_reports",
      missing: [reviewerId("security")],
    });
  });

  it("fails closed on contradictory challenge records", () => {
    const candidate = finding();
    const result = reducePublication({
      runId: runId("run-1"),
      headSha: commitSha("a".repeat(40)),
      selectedReviewers: [reviewerId("security")],
      reports: [report(candidate)],
      challenges: [
        {
          kind: "confirmed",
          findingId: candidate.id,
          reason: "Confirmed.",
        },
        {
          kind: "rejected",
          findingId: candidate.id,
          reason: "Disproved.",
        },
      ],
      changedLines: [{ path: "src/index.ts", lines: [12] }],
      priorStableIdentities: [],
      coverageOmissions: [],
      estimatedCost: usdMicros(0),
      durationMs: 0,
      reviewSummary,
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") expect(result.comments).toEqual([]);
  });
});

describe("AC-15 redaction", () => {
  it("redacts sensitive keys, inline credentials, environment values, and long source-like strings", () => {
    const result = redact(
      {
        authorization: "Bearer super-secret-token",
        nested: {
          privateKey: "-----BEGIN PRIVATE KEY-----secret",
          message: "token=super-secret-token",
        },
        source: "x".repeat(600),
      },
      { environmentValues: ["super-secret-token"] },
    );
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("x".repeat(100));
    expect(result.redactionCount).toBeGreaterThanOrEqual(3);
  });
});

describe("pure scheduling", () => {
  it.each<[RunView["state"], NextWork["kind"]]>([
    [{ kind: "accepted" }, "snapshot"],
    [{ kind: "snapshotting" }, "snapshot"],
    [{ kind: "planning" }, "plan"],
    [{ kind: "preparing_sailbox" }, "prepare_sailbox"],
    [{ kind: "reviewing" }, "review"],
    [{ kind: "challenging" }, "challenge"],
    [{ kind: "reducing" }, "reduce"],
    [{ kind: "publishing" }, "publish"],
    [{ kind: "cleaning_up" }, "cleanup"],
  ])(
    "derives $state.kind as $expected deterministically",
    (state, expected) => {
      expect(
        deriveNextWork(
          { runId: runId("run-1"), state, pendingWorkKeys: [] },
          100,
        ).kind,
      ).toBe(expected);
    },
  );
});
