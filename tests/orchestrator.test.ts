import { describe, expect, it } from "vitest";
import {
  estimateWorstCaseRunCost,
  runReview,
  type ReviewPorts,
} from "../src/application/review-runner.js";
import {
  commitSha,
  findingId,
  reviewerId,
  runId,
  usdMicros,
} from "../src/domain/ids.js";
import { CORE_REVIEWERS } from "../src/domain/reviewers.js";
import type {
  CandidateFinding,
  ChallengeVerdict,
  ReviewerReport,
} from "../src/domain/types.js";

const candidate: CandidateFinding = {
  id: findingId("security-1"),
  reviewer: reviewerId("security"),
  location: { path: "src/index.ts", line: 2 },
  severity: "high",
  confidence: 0.95,
  title: "Shell injection",
  trigger: "Set name to a command substitution.",
  evidence: "The changed line forwards name to a shell.",
  proposedAction: "Use an argument-vector API.",
  stableIdentity: "shell-injection:name",
};

describe("review orchestration", () => {
  it("admits the maximum reviewer and finding plan below the hard ceiling", () => {
    expect(estimateWorstCaseRunCost(10)).toBe(usdMicros(130_000));
    expect(() => estimateWorstCaseRunCost(11)).toThrow("between one and ten");
  });

  it("runs every selected specialist, challenges every finding, and publishes once", async () => {
    const reviewed: string[] = [];
    const challenged: string[] = [];
    const publications: unknown[] = [];
    let terminated = false;
    let activeModelRequests = 0;
    let maximumActiveModelRequests = 0;
    const auditEvents: string[] = [];
    const ports: ReviewPorts = {
      audit: (event) => {
        auditEvents.push(event.kind);
      },
      sandbox: {
        prepare: () => Promise.resolve({ id: "box-1" }),
        terminate: () => {
          terminated = true;
          return Promise.resolve();
        },
      },
      model: {
        review: async ({ reviewer }) => {
          activeModelRequests += 1;
          maximumActiveModelRequests = Math.max(
            maximumActiveModelRequests,
            activeModelRequests,
          );
          await Promise.resolve();
          activeModelRequests -= 1;
          reviewed.push(reviewer);
          const report: ReviewerReport = {
            reviewer,
            readiness: reviewer === "security" ? 2 : 5,
            rationale: "Scoped review complete.",
            examinedAreas: ["changed lines"],
            findings: reviewer === "security" ? [candidate] : [],
          };
          return { report, cost: usdMicros(100) };
        },
        challenge: ({ finding }) => {
          challenged.push(finding.id);
          const verdict: ChallengeVerdict = {
            kind: "confirmed",
            findingId: finding.id,
            reason: "The changed line is reachable.",
          };
          return Promise.resolve({ verdict, cost: usdMicros(50) });
        },
      },
      github: {
        publish: (plan) => {
          publications.push(plan);
          return Promise.resolve({ reviewId: 42 });
        },
      },
    };

    const result = await runReview(
      {
        runId: runId("run-1"),
        owner: "Kylejeong2",
        repository: "gauntlet",
        pullNumber: 1,
        baseSha: commitSha("a".repeat(40)),
        headSha: commitSha("b".repeat(40)),
        snapshotText: "src/index.ts line 2 changed",
        changedLines: [{ path: "src/index.ts", lines: [2] }],
        priorStableIdentities: [],
        coverageOmissions: [],
        reviewers: CORE_REVIEWERS,
      },
      ports,
    );

    expect(reviewed).toEqual(CORE_REVIEWERS.map((reviewer) => reviewer.id));
    expect(challenged).toEqual([candidate.id]);
    expect(publications).toHaveLength(1);
    expect(maximumActiveModelRequests).toBe(1);
    expect(result.reviewId).toBe(42);
    expect(result.cost).toBe(usdMicros(850));
    expect(terminated).toBe(true);
    expect(auditEvents).toContain("reviewer_completed");
    expect(auditEvents).toContain("challenge_completed");
    expect(auditEvents).toContain("publication_submitted");
    expect(auditEvents.at(-1)).toBe("sandbox_terminated");
  });

  it("terminates the sandbox and publishes nothing when a reviewer fails", async () => {
    let terminated = false;
    const ports: ReviewPorts = {
      sandbox: {
        prepare: () => Promise.resolve({ id: "box-1" }),
        terminate: () => {
          terminated = true;
          return Promise.resolve();
        },
      },
      model: {
        review: () => Promise.reject(new Error("provider unavailable")),
        challenge: () => Promise.reject(new Error("unreachable")),
      },
      github: {
        publish: () => Promise.reject(new Error("must not publish")),
      },
    };
    await expect(
      runReview(
        {
          runId: runId("run-1"),
          owner: "Kylejeong2",
          repository: "gauntlet",
          pullNumber: 1,
          baseSha: commitSha("a".repeat(40)),
          headSha: commitSha("b".repeat(40)),
          snapshotText: "diff",
          changedLines: [],
          priorStableIdentities: [],
          coverageOmissions: [],
          reviewers: CORE_REVIEWERS,
        },
        ports,
      ),
    ).rejects.toThrow("provider unavailable");
    expect(terminated).toBe(true);
  });
});
