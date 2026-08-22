import { describe, expect, it } from "vitest";
import {
  commitSha,
  findingId,
  reviewerId,
  runId,
  usdMicros,
} from "../src/domain/ids.js";
import { reducePublication } from "../src/domain/publication.js";
import type { CandidateFinding, ReviewerReport } from "../src/domain/types.js";

const commandInjection: CandidateFinding = {
  id: findingId("eval-command-injection"),
  reviewer: reviewerId("security"),
  location: { path: "src/run.ts", line: 17 },
  severity: "critical",
  confidence: 0.98,
  title: "Request data reaches a shell",
  trigger: "Send name=$(touch /tmp/pwned) to the changed endpoint.",
  evidence: "A Sailbox reproduction creates the marker file.",
  proposedAction: "Pass an argument vector to the child process API.",
  stableIdentity: "command-injection:run:name",
};

const report = (finding: CandidateFinding): ReviewerReport => ({
  reviewer: finding.reviewer,
  readiness: 1,
  rationale: "A reachable blocking defect remains.",
  examinedAreas: ["request to process boundary"],
  findings: [finding],
});

const baseInput = {
  runId: runId("eval-run"),
  headSha: commitSha("b".repeat(40)),
  selectedReviewers: [reviewerId("security")],
  reports: [report(commandInjection)],
  changedLines: [{ path: "src/run.ts", lines: [17] }],
  priorStableIdentities: [],
  coverageOmissions: [],
  estimatedCost: usdMicros(20_000),
  durationMs: 2_000,
};

describe("ProductSpec fixture evaluations", () => {
  it("EVAL-1 publishes a reproduced command injection after confirmation", () => {
    const result = reducePublication({
      ...baseInput,
      challenges: [
        {
          kind: "confirmed",
          findingId: commandInjection.id,
          reason: "The reproduction proves reachability and impact.",
        },
      ],
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish")
      expect(result.comments.map((comment) => comment.finding.id)).toEqual([
        commandInjection.id,
      ]);
  });

  it("EVAL-2 suppresses a plausible claim that the challenger disproves", () => {
    const result = reducePublication({
      ...baseInput,
      challenges: [
        {
          kind: "rejected",
          findingId: commandInjection.id,
          reason: "The value reaches an argument-vector API, not a shell.",
        },
      ],
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") expect(result.comments).toEqual([]);
  });

  it("EVAL-3 publishes separate reviewer scores without positive inline comments", () => {
    const result = reducePublication({
      ...baseInput,
      reports: [
        {
          reviewer: reviewerId("security"),
          readiness: 5,
          rationale:
            "No security defect found in the documentation-only change.",
          examinedAreas: ["changed documentation"],
          findings: [],
        },
      ],
      challenges: [],
      changedLines: [{ path: "README.md", lines: [5] }],
    });
    expect(result.kind).toBe("publish");
    if (result.kind === "publish") {
      expect(result.comments).toEqual([]);
      expect(result.reviewerComments).toHaveLength(1);
      expect(result.reviewerComments[0]?.body).toContain(
        "Security reviewer: 5/5",
      );
    }
  });
});
