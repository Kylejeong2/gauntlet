import { describe, expect, it } from "vitest";
import {
  commitSha,
  deliveryId,
  findingId,
  installationId,
  pullNumber,
  repositoryId,
  reviewerId,
  runId,
  usdMicros,
  workerId,
} from "../src/domain/ids.js";
import { selectReviewers } from "../src/domain/reviewers.js";
import { reviewerReportSchema } from "../src/domain/schemas.js";

describe("AC-4 reviewer selection", () => {
  it("selects the eight core reviewers and caps optional reviewers at ten", () => {
    const selected = selectReviewers([
      "test-quality",
      "concurrency",
      "security",
    ]);
    expect(selected).toHaveLength(10);
    expect(selected.map((reviewer) => reviewer.id)).toEqual([
      "security",
      "performance",
      "api-compatibility",
      "adversarial-testing",
      "documentation",
      "new-user-simulation",
      "dependency-history",
      "edge-cases",
      "test-quality",
      "concurrency",
    ]);
  });
});

describe("AC-5 and AC-6 reviewer reports", () => {
  const validFinding = {
    id: "finding-1",
    reviewer: "security",
    location: { path: "src/index.ts", line: 12 },
    severity: "high",
    confidence: 0.9,
    title: "Untrusted input reaches the shell",
    trigger: "Call the endpoint with command substitution in the name field.",
    evidence: "The changed line forwards name into exec.",
    proposedAction: "Use an argument-vector process API.",
    stableIdentity: "shell-injection:index:name",
  };

  it("accepts a strict score and at most three complete findings", () => {
    const result = reviewerReportSchema.safeParse({
      reviewer: "security",
      readiness: 2,
      rationale: "A reachable injection remains.",
      examinedAreas: ["request boundary", "process invocation"],
      findings: [validFinding],
    });
    expect(result.success).toBe(true);
  });

  it.each([0, 6, 2.5])("rejects readiness %s", (readiness) => {
    expect(
      reviewerReportSchema.safeParse({
        reviewer: "security",
        readiness,
        rationale: "Invalid score.",
        examinedAreas: ["diff"],
        findings: [],
      }).success,
    ).toBe(false);
  });

  it("rejects a fourth finding and unknown properties", () => {
    expect(
      reviewerReportSchema.safeParse({
        reviewer: "security",
        readiness: 2,
        rationale: "Too many findings.",
        examinedAreas: ["diff"],
        findings: [validFinding, validFinding, validFinding, validFinding],
        hiddenReasoning: "must never cross the boundary",
      }).success,
    ).toBe(false);
  });

  it("rejects a finding attributed to a different reviewer", () => {
    expect(
      reviewerReportSchema.safeParse({
        reviewer: "performance",
        readiness: 3,
        rationale: "The report attribution is inconsistent.",
        examinedAreas: ["diff"],
        findings: [validFinding],
      }).success,
    ).toBe(false);
  });
});

describe("AC-14 branded boundary constructors", () => {
  it("accepts valid identifiers", () => {
    expect(runId("run-1")).toBe("run-1");
    expect(deliveryId("delivery-1")).toBe("delivery-1");
    expect(installationId(1)).toBe(1);
    expect(repositoryId(2)).toBe(2);
    expect(pullNumber(3)).toBe(3);
    expect(commitSha("a".repeat(40))).toHaveLength(40);
    expect(reviewerId("security")).toBe("security");
    expect(findingId("finding-1")).toBe("finding-1");
    expect(workerId("worker-1")).toBe("worker-1");
    expect(usdMicros(250_000)).toBe(250_000);
  });

  it("rejects malformed identifiers and costs", () => {
    expect(() => pullNumber(0)).toThrow();
    expect(() => commitSha("main")).toThrow();
    expect(() => usdMicros(-1)).toThrow();
  });
});
