import { z } from "zod";
import { idSchemas } from "./ids.js";

export const findingSchema = z
  .object({
    id: idSchemas.findingId,
    reviewer: idSchemas.reviewerId,
    location: z
      .object({
        path: z.string().min(1).max(1024),
        line: z.number().int().positive(),
      })
      .strict(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    confidence: z.number().min(0).max(1),
    title: z.string().trim().min(1).max(160),
    trigger: z.string().trim().min(1).max(2_000),
    evidence: z.string().trim().min(1).max(4_000),
    proposedAction: z.string().trim().min(1).max(2_000),
    stableIdentity: z.string().trim().min(1).max(512),
  })
  .strict();

export const reviewerReportSchema = z
  .object({
    reviewer: idSchemas.reviewerId,
    readiness: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    rationale: z.string().trim().min(1).max(1_000),
    examinedAreas: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    findings: z.array(findingSchema).max(3),
  })
  .strict()
  .superRefine((report, context) => {
    const findingIds = new Set<string>();
    for (const [index, finding] of report.findings.entries()) {
      if (finding.reviewer !== report.reviewer) {
        context.addIssue({
          code: "custom",
          message: "Finding reviewer must match report reviewer",
          path: ["findings", index, "reviewer"],
        });
      }
      if (findingIds.has(finding.id)) {
        context.addIssue({
          code: "custom",
          message: "Finding IDs must be unique within a report",
          path: ["findings", index, "id"],
        });
      }
      findingIds.add(finding.id);
    }
  });

export const challengeVerdictSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirmed"),
      findingId: idSchemas.findingId,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      findingId: idSchemas.findingId,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inconclusive"),
      findingId: idSchemas.findingId,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      findingId: idSchemas.findingId,
      reason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const reviewSummarySchema = z
  .object({
    headline: z.string().trim().min(1).max(160),
    overview: z.string().trim().min(1).max(600),
    topRisk: z.string().trim().min(1).max(300),
    nextAction: z.string().trim().min(1).max(300),
  })
  .strict();
