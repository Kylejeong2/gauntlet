import type {
  CandidateFinding,
  PublicationInput,
  ReviewerReport,
  Severity,
} from "./types.js";

type PublicationComment = Readonly<{ finding: CandidateFinding; body: string }>;
type ReviewerComment = Readonly<{
  reviewer: ReviewerReport["reviewer"];
  body: string;
}>;

export type PublicationPlan =
  | Readonly<{
      kind: "skip";
      reason: "missing_reviewer_reports";
      missing: readonly string[];
    }>
  | Readonly<{
      kind: "skip";
      reason: "duplicate_reviewer_reports";
      duplicates: readonly string[];
    }>
  | Readonly<{
      kind: "publish";
      runId: PublicationInput["runId"];
      headSha: PublicationInput["headSha"];
      body: string;
      pullRequestSummary: string;
      reviewerComments: readonly ReviewerComment[];
      comments: readonly PublicationComment[];
    }>;

const severityRank: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const strongerFirst = (
  left: CandidateFinding,
  right: CandidateFinding,
): number =>
  severityRank[right.severity] - severityRank[left.severity] ||
  right.confidence - left.confidence ||
  right.evidence.length - left.evidence.length ||
  left.id.localeCompare(right.id);

const reviewerTitle = (reviewer: string): string =>
  reviewer
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const formatDurationSeconds = (durationMs: number): string =>
  `${String(Math.round(durationMs / 100) / 10)}s`;

const averageReadiness = (scores: readonly number[]): string => {
  if (scores.length === 0) return "0.0";
  const total = scores.reduce((sum, score) => sum + score, 0);
  return (total / scores.length).toFixed(1);
};

const promptText = (value: string): string => value.replaceAll("`", "'");

const promptDropdown = (prompt: string): string =>
  `<details>\n<summary>Prompt to fix</summary>\n\n\`\`\`text\n${promptText(prompt)}\n\`\`\`\n</details>`;

const oneLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

export const reducePublication = (input: PublicationInput): PublicationPlan => {
  const reportCounts = new Map<string, number>();
  for (const report of input.reports) {
    reportCounts.set(
      report.reviewer,
      (reportCounts.get(report.reviewer) ?? 0) + 1,
    );
  }
  const duplicates = input.selectedReviewers.filter(
    (reviewer) => (reportCounts.get(reviewer) ?? 0) > 1,
  );
  if (duplicates.length > 0)
    return { kind: "skip", reason: "duplicate_reviewer_reports", duplicates };
  const reportIds = new Set(input.reports.map((report) => report.reviewer));
  const missing = input.selectedReviewers.filter(
    (reviewer) => !reportIds.has(reviewer),
  );
  if (missing.length > 0)
    return { kind: "skip", reason: "missing_reviewer_reports", missing };

  const selectedReports = input.selectedReviewers.flatMap((reviewer) => {
    const report = input.reports.find(
      (candidate) => candidate.reviewer === reviewer,
    );
    return report === undefined ? [] : [report];
  });

  const challengesByFinding = new Map<string, PublicationInput["challenges"]>();
  for (const challenge of input.challenges) {
    const existing = challengesByFinding.get(challenge.findingId) ?? [];
    challengesByFinding.set(challenge.findingId, [...existing, challenge]);
  }
  const confirmed = new Set(
    [...challengesByFinding.entries()]
      .filter(
        ([, verdicts]) =>
          verdicts.length === 1 && verdicts[0]?.kind === "confirmed",
      )
      .map(([candidateFindingId]) => candidateFindingId),
  );
  const allowedLines = new Map(
    input.changedLines.map((file) => [file.path, new Set(file.lines)]),
  );
  const prior = new Set(input.priorStableIdentities);
  const candidates = selectedReports
    .flatMap((report) => report.findings)
    .filter((candidate) => input.selectedReviewers.includes(candidate.reviewer))
    .filter((candidate) => confirmed.has(candidate.id))
    .filter(
      (candidate) =>
        allowedLines
          .get(candidate.location.path)
          ?.has(candidate.location.line) === true,
    )
    .filter((candidate) => !prior.has(candidate.stableIdentity))
    .sort(strongerFirst);
  const byLocation = new Map<string, CandidateFinding[]>();
  for (const candidate of candidates) {
    const key = `${candidate.location.path}:${String(candidate.location.line)}`;
    const existing = byLocation.get(key) ?? [];
    byLocation.set(key, [...existing, candidate]);
  }
  const corroborated =
    input.selectedReviewers.length === 1
      ? candidates
      : [...byLocation.values()].flatMap((atLocation) => {
          const reviewers = new Set(
            atLocation.map((candidate) => candidate.reviewer),
          );
          const exceptional = atLocation.some(
            (candidate) =>
              candidate.severity === "critical" && candidate.confidence >= 0.9,
          );
          if (reviewers.size < 2 && !exceptional) return [];
          const strongest = [...atLocation].sort(strongerFirst)[0];
          return strongest === undefined ? [] : [strongest];
        });

  const unique = new Map<string, CandidateFinding>();
  for (const candidate of corroborated) {
    if (!unique.has(candidate.stableIdentity))
      unique.set(candidate.stableIdentity, candidate);
  }
  const selected = [...unique.values()].sort(strongerFirst).slice(0, 5);
  const comments = selected.map((candidate) => ({
    finding: candidate,
    body: `**${reviewerTitle(candidate.reviewer)} reviewer · ${candidate.severity.toUpperCase()}: ${candidate.title}**\n\nTrigger: ${candidate.trigger}\n\nEvidence: ${candidate.evidence}\n\nAction: ${candidate.proposedAction}\n\n${promptDropdown(`Fix the verified ${candidate.severity} finding from the ${reviewerTitle(candidate.reviewer)} reviewer in ${candidate.location.path} at changed line ${String(candidate.location.line)}.\n\nProblem: ${candidate.title}\nTrigger: ${candidate.trigger}\nEvidence: ${candidate.evidence}\nRequired action: ${candidate.proposedAction}\n\nMake the smallest safe change, preserve unrelated behavior, add or update a regression test that proves the defect is fixed, and run the relevant project checks. Summarize the code changed and the verification performed.`)}\n\n<!-- gauntlet:${candidate.stableIdentity} -->`,
  }));
  const publishableLocations = new Set(
    selected.map(
      (candidate) =>
        `${candidate.location.path}:${String(candidate.location.line)}`,
    ),
  );
  const actionableReviewers = new Set(
    candidates
      .filter((candidate) =>
        publishableLocations.has(
          `${candidate.location.path}:${String(candidate.location.line)}`,
        ),
      )
      .map((candidate) => candidate.reviewer),
  );
  const omissions =
    input.coverageOmissions.length === 0
      ? "None"
      : input.coverageOmissions.join("; ");
  const effectiveReports = selectedReports.map((report) => ({
    report,
    readiness: actionableReviewers.has(report.reviewer) ? report.readiness : 5,
  }));
  const reviewerComments = effectiveReports.map(({ report, readiness }) => {
    const fixPrompt =
      readiness < 5
        ? `\n\n${promptDropdown(`Act as the implementer responding to the ${reviewerTitle(report.reviewer)} review of this pull request.\n\nReadiness: ${String(readiness)}/5\nAssessment: ${report.rationale}\nExamined areas: ${report.examinedAreas.join(", ")}\n\nAddress every concrete concern supported by the changed code. Preserve behavior the reviewer found correct, avoid speculative refactors, add or update focused tests for each fix, and run the relevant project checks. Summarize what changed and what remains, if anything.`)}`
        : "";
    return {
      reviewer: report.reviewer,
      body: `## ${reviewerTitle(report.reviewer)} reviewer: ${String(readiness)}/5\n\n${report.rationale}\n\nExamined: ${report.examinedAreas.join(", ")}${fixPrompt}\n\n<!-- gauntlet-reviewer:${input.runId}:${report.reviewer} -->`,
    };
  });
  const summary = input.reviewSummary;
  const overallReadiness = averageReadiness(
    effectiveReports.map((report) => report.readiness),
  );
  const body = `## Gauntlet summary\n\n**${summary.headline}**\n\n${summary.overview}\n\n**Readiness:** ${overallReadiness}/5 · **Verified findings:** ${String(comments.length)} · **Cost:** $${(input.estimatedCost / 1_000_000).toFixed(6)} · **Duration:** ${formatDurationSeconds(input.durationMs)}\n\n**Top risk:** ${summary.topRisk}\n\n**Next step:** ${summary.nextAction}\n\nCoverage omissions: ${omissions}\n\n<!-- gauntlet-run:${input.runId} -->`;
  return {
    kind: "publish",
    runId: input.runId,
    headSha: input.headSha,
    body,
    pullRequestSummary: oneLine(summary.headline),
    reviewerComments,
    comments,
  };
};
