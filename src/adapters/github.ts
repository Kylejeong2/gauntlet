import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  commitSha,
  installationId,
  pullNumber,
  repositoryId,
  type CommitSha,
  type InstallationId,
  type PullNumber,
  type RepositoryId,
  type RunId,
} from "../domain/ids.js";
import type { PublicationPlan } from "../domain/publication.js";
import {
  capturedPullRequestSnapshotSchema,
  type CapturedPullRequestSnapshot,
} from "../domain/snapshot.js";

const supportedActions = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

const pullRequestEventSchema = z.looseObject({
  action: z.string(),
  installation: z.looseObject({ id: z.number().int().positive() }),
  repository: z.looseObject({
    id: z.number().int().positive(),
    private: z.boolean(),
    name: z.string().trim().min(1),
    owner: z.looseObject({ login: z.string().trim().min(1) }),
  }),
  pull_request: z.looseObject({
    number: z.number().int().positive(),
    draft: z.boolean(),
    base: z.looseObject({ sha: z.string() }),
    head: z.looseObject({ sha: z.string() }),
    user: z.looseObject({
      login: z.string().trim().min(1),
      type: z.string().trim().min(1),
    }),
  }),
});

const reviewRequestCommentSchema = z.looseObject({
  action: z.literal("created"),
  installation: z.looseObject({ id: z.number().int().positive() }),
  repository: z.looseObject({
    id: z.number().int().positive(),
    private: z.boolean(),
    name: z.string().trim().min(1),
    owner: z.looseObject({ login: z.string().trim().min(1) }),
  }),
  issue: z.looseObject({
    number: z.number().int().positive(),
    pull_request: z.looseObject({}).optional(),
  }),
  comment: z.looseObject({ body: z.string() }),
  sender: z.looseObject({
    login: z.string().trim().min(1),
    type: z.string().trim().min(1),
  }),
});

export type ReviewRequestCommentIneligibleReason =
  | "unsupported_action"
  | "private_repository"
  | "bot_authored_comment"
  | "not_pull_request_comment"
  | "missing_review_trigger"
  | "malformed_payload";

export type ReviewRequestCommentEligibility =
  | Readonly<{
      kind: "eligible";
      target: Readonly<{
        installationId: InstallationId;
        repositoryId: RepositoryId;
        pullNumber: PullNumber;
        owner: string;
        repository: string;
      }>;
    }>
  | Readonly<{
      kind: "ineligible";
      reason: ReviewRequestCommentIneligibleReason;
    }>;

export const classifyReviewRequestComment = (
  payload: unknown,
): ReviewRequestCommentEligibility => {
  const parsed = reviewRequestCommentSchema.safeParse(payload);
  if (!parsed.success)
    return { kind: "ineligible", reason: "malformed_payload" };
  const event = parsed.data;
  if (event.repository.private)
    return { kind: "ineligible", reason: "private_repository" };
  if (
    event.sender.type.toLowerCase() === "bot" ||
    event.sender.login.toLowerCase().endsWith("[bot]")
  )
    return { kind: "ineligible", reason: "bot_authored_comment" };
  if (event.issue.pull_request === undefined)
    return { kind: "ineligible", reason: "not_pull_request_comment" };
  if (!/(?:^|\s)@gauntlet(?=$|\s|[.,!?;:])/i.test(event.comment.body))
    return { kind: "ineligible", reason: "missing_review_trigger" };
  try {
    return {
      kind: "eligible",
      target: {
        installationId: installationId(event.installation.id),
        repositoryId: repositoryId(event.repository.id),
        pullNumber: pullNumber(event.issue.number),
        owner: event.repository.owner.login,
        repository: event.repository.name,
      },
    };
  } catch {
    return { kind: "ineligible", reason: "malformed_payload" };
  }
};

export type PullRequestIneligibleReason =
  | "unsupported_action"
  | "private_repository"
  | "draft_pull_request"
  | "bot_authored_pull_request"
  | "malformed_payload";

export type PullRequestEligibility =
  | Readonly<{
      kind: "eligible";
      target: Readonly<{
        installationId: InstallationId;
        repositoryId: RepositoryId;
        pullNumber: PullNumber;
        owner: string;
        repository: string;
        baseSha: CommitSha;
        headSha: CommitSha;
      }>;
    }>
  | Readonly<{ kind: "ineligible"; reason: PullRequestIneligibleReason }>;

export const classifyPullRequest = (
  payload: unknown,
): PullRequestEligibility => {
  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success)
    return { kind: "ineligible", reason: "malformed_payload" };
  const event = parsed.data;
  if (!supportedActions.has(event.action))
    return { kind: "ineligible", reason: "unsupported_action" };
  if (event.repository.private)
    return { kind: "ineligible", reason: "private_repository" };
  if (event.pull_request.draft)
    return { kind: "ineligible", reason: "draft_pull_request" };
  if (
    event.pull_request.user.type.toLowerCase() === "bot" ||
    event.pull_request.user.login.toLowerCase().endsWith("[bot]")
  )
    return { kind: "ineligible", reason: "bot_authored_pull_request" };
  try {
    return {
      kind: "eligible",
      target: {
        installationId: installationId(event.installation.id),
        repositoryId: repositoryId(event.repository.id),
        pullNumber: pullNumber(event.pull_request.number),
        owner: event.repository.owner.login,
        repository: event.repository.name,
        baseSha: commitSha(event.pull_request.base.sha),
        headSha: commitSha(event.pull_request.head.sha),
      },
    };
  } catch {
    return { kind: "ineligible", reason: "malformed_payload" };
  }
};

export const parseChangedRightLines = (
  patch: string | undefined,
): readonly number[] => {
  if (patch === undefined) return [];
  const changed: number[] = [];
  let rightLine = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      rightLine = Number(header[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.push(rightLine);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (!line.startsWith("\\")) rightLine += 1;
  }
  return changed;
};

export const verifyWebhookSignature = (
  secret: string,
  body: Buffer,
  signature: string | undefined,
): boolean => {
  if (secret.length === 0 || signature === undefined) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
};

type PullFile = Readonly<{
  filename: string;
  status: string;
  patch?: string;
}>;

type ReviewComment = Readonly<{ body?: string | null }>;
type PullReview = Readonly<{ id: number; body?: string | null }>;

type PullDetails = Readonly<{
  head: Readonly<{ sha: string }>;
  body: string | null;
  repository: Readonly<{ id: number; private: boolean }>;
}>;

type CompareDetails = Readonly<{
  base_commit: Readonly<{ sha: string }>;
  merge_base_commit: Readonly<{ sha: string }>;
  files?: readonly PullFile[];
}>;

export type PullRequestApi = Readonly<{
  getPull: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
    }>,
  ) => Promise<Readonly<{ data: PullDetails }>>;
  updatePull: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
    }>,
  ) => Promise<Readonly<{ data: Readonly<Record<string, never>> }>>;
  compareCommits: (
    input: Readonly<{
      owner: string;
      repo: string;
      basehead: string;
    }>,
  ) => Promise<Readonly<{ data: CompareDetails }>>;
  listReviewComments: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }>,
  ) => Promise<Readonly<{ data: readonly ReviewComment[] }>>;
  listReviews: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }>,
  ) => Promise<Readonly<{ data: readonly PullReview[] }>>;
  createReview: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      event: "COMMENT";
      body: string;
      comments: readonly Readonly<{
        path: string;
        line: number;
        side: "RIGHT";
        body: string;
      }>[];
    }>,
  ) => Promise<Readonly<{ data: Readonly<{ id: number }> }>>;
}>;

type PullRequestTarget = Readonly<{
  owner: string;
  repository: string;
  pullNumber: number;
}>;

const pullRequestSummaryStart = "<!-- gauntlet-pr-summary:start -->";
const pullRequestSummaryEnd = "<!-- gauntlet-pr-summary:end -->";
const pullRequestSummaryPattern =
  /<!-- gauntlet-pr-summary:start -->[\s\S]*?<!-- gauntlet-pr-summary:end -->/;

export const upsertPullRequestSummary = (
  body: string | null,
  summary: string,
): string => {
  const block = `${pullRequestSummaryStart}\n> [!NOTE]\n> **Gauntlet:** ${summary.replaceAll(/\s+/g, " ").trim()}\n${pullRequestSummaryEnd}`;
  const current = body?.trimEnd() ?? "";
  if (pullRequestSummaryPattern.test(current))
    return current.replace(pullRequestSummaryPattern, block);
  return current.length === 0 ? block : `${current}\n\n${block}`;
};

export class GitHubReviewClient {
  readonly #api: PullRequestApi;
  readonly #target: PullRequestTarget;

  public constructor(api: PullRequestApi, target: PullRequestTarget) {
    this.#api = api;
    this.#target = target;
  }

  public async snapshot(
    input: Readonly<{
      installationId: number;
      repositoryId: number;
      runId: RunId;
      baseSha: CommitSha;
      headSha: CommitSha;
    }>,
  ): Promise<CapturedPullRequestSnapshot> {
    const pull = await this.#api.getPull(this.#params());
    if (pull.data.repository.private)
      throw new Error("Pull request repository is not public");
    if (pull.data.repository.id !== input.repositoryId)
      throw new Error("Pull request repository identity changed");
    if (commitSha(pull.data.head.sha) !== input.headSha)
      throw new Error("Pull request head changed before snapshot");
    const comparison = await this.#api.compareCommits({
      owner: this.#target.owner,
      repo: this.#target.repository,
      basehead: `${input.baseSha}...${input.headSha}`,
    });
    if (commitSha(comparison.data.base_commit.sha) !== input.baseSha)
      throw new Error("GitHub comparison returned a different base");
    const sourceFiles = comparison.data.files ?? [];
    const files = sourceFiles.map((file, ordinal) =>
      file.patch === undefined
        ? ({
            ordinal,
            kind: "omitted",
            path: file.filename,
            status: file.status,
            reason: "patch_unavailable",
          } as const)
        : ({
            ordinal,
            kind: "reviewable",
            path: file.filename,
            status: file.status,
            patch: file.patch,
            changedLines: parseChangedRightLines(file.patch),
          } as const),
    );
    const omissions = files
      .filter((file) => file.kind === "omitted")
      .map((file) => `${file.path}: GitHub did not provide a patch`);
    if (sourceFiles.length === 300)
      omissions.push(
        "GitHub comparison reached the 300-file limit; additional files may be omitted",
      );
    return capturedPullRequestSnapshotSchema.parse({
      formatVersion: 1,
      mergeBaseSha: comparison.data.merge_base_commit.sha,
      files,
      coverageOmissions: omissions,
    });
  }

  public async priorStableIdentities(): Promise<readonly string[]> {
    const comments = await paginate((page) =>
      this.#api.listReviewComments({ ...this.#params(), per_page: 100, page }),
    );
    const identityPattern = /<!-- gauntlet:([^>]+) -->/g;
    const identities = new Set<string>();
    for (const comment of comments) {
      if (comment.body === null || comment.body === undefined) continue;
      for (const match of comment.body.matchAll(identityPattern)) {
        const identity = match[1];
        if (identity !== undefined) identities.add(identity.trim());
      }
    }
    return [...identities].sort();
  }

  public async publish(
    plan: Extract<PublicationPlan, { kind: "publish" }>,
  ): Promise<Readonly<{ reviewId: number }>> {
    const pull = await this.#api.getPull(this.#params());
    if (pull.data.repository.private)
      throw new Error("Pull request repository is not public");
    if (commitSha(pull.data.head.sha) !== plan.headSha)
      throw new Error("Pull request head changed before publication");
    const pullRequestBody = upsertPullRequestSummary(
      pull.data.body,
      plan.pullRequestSummary,
    );
    if (pullRequestBody !== pull.data.body)
      await this.#api.updatePull({ ...this.#params(), body: pullRequestBody });
    const reviews = await paginate((page) =>
      this.#api.listReviews({ ...this.#params(), per_page: 100, page }),
    );
    for (const reviewerComment of plan.reviewerComments) {
      const marker = `<!-- gauntlet-reviewer:${plan.runId}:${reviewerComment.reviewer} -->`;
      if (reviews.some((review) => review.body?.includes(marker))) continue;
      await this.#api.createReview({
        ...this.#params(),
        commit_id: plan.headSha,
        event: "COMMENT",
        body: reviewerComment.body,
        comments: [],
      });
    }
    const result = await this.#api.createReview({
      ...this.#params(),
      commit_id: plan.headSha,
      event: "COMMENT",
      body: plan.body,
      comments: plan.comments.map((comment) => ({
        path: comment.finding.location.path,
        line: comment.finding.location.line,
        side: "RIGHT",
        body: comment.body,
      })),
    });
    return { reviewId: result.data.id };
  }

  public async findExisting(
    targetRunId: RunId,
  ): Promise<Readonly<{ reviewId: number }> | null> {
    const reviews = await paginate((page) =>
      this.#api.listReviews({ ...this.#params(), per_page: 100, page }),
    );
    const marker = `<!-- gauntlet-run:${targetRunId} -->`;
    const existing = reviews.find((review) => review.body?.includes(marker));
    return existing === undefined ? null : { reviewId: existing.id };
  }

  #params(): Readonly<{ owner: string; repo: string; pull_number: number }> {
    return {
      owner: this.#target.owner,
      repo: this.#target.repository,
      pull_number: this.#target.pullNumber,
    };
  }
}

const paginate = async <T>(
  pageRequest: (page: number) => Promise<Readonly<{ data: readonly T[] }>>,
): Promise<readonly T[]> => {
  const all: T[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await pageRequest(page);
    all.push(...response.data);
    if (response.data.length < 100) return all;
  }
  throw new Error("GitHub pagination exceeded 3000 records");
};
