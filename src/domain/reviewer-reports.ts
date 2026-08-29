import type { CandidateFinding, ReviewerReport } from "./types.js";

const severityRank: Readonly<Record<CandidateFinding["severity"], number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const strongerFinding = (
  left: CandidateFinding,
  right: CandidateFinding,
): CandidateFinding => {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity > 0 ? left : right;
  if (left.confidence !== right.confidence)
    return left.confidence > right.confidence ? left : right;
  if (left.evidence.length !== right.evidence.length)
    return left.evidence.length > right.evidence.length ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
};

export const deduplicateReportFindings = (
  report: ReviewerReport,
): ReviewerReport => {
  const byIdentity = new Map<string, CandidateFinding>();
  const identityOrder: string[] = [];
  for (const finding of report.findings) {
    const existing = byIdentity.get(finding.stableIdentity);
    if (existing === undefined) {
      identityOrder.push(finding.stableIdentity);
      byIdentity.set(finding.stableIdentity, finding);
      continue;
    }
    byIdentity.set(finding.stableIdentity, strongerFinding(existing, finding));
  }
  if (identityOrder.length === report.findings.length) return report;
  return {
    ...report,
    findings: identityOrder.map((identity) => {
      const finding = byIdentity.get(identity);
      if (finding === undefined)
        throw new Error("Missing deduplicated reviewer finding");
      return finding;
    }),
  };
};
