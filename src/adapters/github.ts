import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CommitSha } from "../domain/ids.js";
import type { PublicationPlan } from "../domain/publication.js";

const supportedActions = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

const pullRequestEventSchema = z.looseObject({
  action: z.string(),
  repository: z.looseObject({ private: z.boolean() }),
  pull_request: z.looseObject({ draft: z.boolean() }),
});

export const isReviewablePullRequest = (payload: unknown): boolean => {
  const parsed = pullRequestEventSchema.safeParse(payload);
  return (
    parsed.success &&
    supportedActions.has(parsed.data.action) &&
    !parsed.data.repository.private &&
    !parsed.data.pull_request.draft
  );
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

export type PullRequestApi = Readonly<{
  listFiles: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }>,
  ) => Promise<Readonly<{ data: readonly PullFile[] }>>;
  listReviewComments: (
    input: Readonly<{
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
      page: number;
    }>,
  ) => Promise<Readonly<{ data: readonly ReviewComment[] }>>;
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

export type PullSnapshot = Readonly<{
  text: string;
  changedLines: readonly Readonly<{ path: string; lines: readonly number[] }>[];
  priorStableIdentities: readonly string[];
  coverageOmissions: readonly string[];
}>;

type PullRequestTarget = Readonly<{
  owner: string;
  repository: string;
  pullNumber: number;
}>;

export class GitHubReviewClient {
  readonly #api: PullRequestApi;
  readonly #target: PullRequestTarget;

  public constructor(api: PullRequestApi, target: PullRequestTarget) {
    this.#api = api;
    this.#target = target;
  }

  public async snapshot(
    input: Readonly<{
      baseSha: CommitSha;
      headSha: CommitSha;
    }>,
  ): Promise<PullSnapshot> {
    const files = await paginate((page) =>
      this.#api.listFiles({ ...this.#params(), per_page: 100, page }),
    );
    const comments = await paginate((page) =>
      this.#api.listReviewComments({ ...this.#params(), per_page: 100, page }),
    );
    const changedLines = files.map((file) => ({
      path: file.filename,
      lines: parseChangedRightLines(file.patch),
    }));
    const omissions = files
      .filter((file) => file.patch === undefined)
      .map((file) => `${file.filename}: GitHub did not provide a patch`);
    const sections = files.map(
      (file) =>
        `FILE ${file.filename} (${file.status})\n${file.patch ?? "[patch unavailable]"}`,
    );
    const prefix = `BASE ${input.baseSha}\nHEAD ${input.headSha}\n`;
    const combined = `${prefix}\n${sections.join("\n\n")}`;
    const text = combined.slice(0, 64_000);
    if (combined.length > text.length)
      omissions.push(
        `Snapshot truncated by ${String(combined.length - text.length)} characters`,
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
    return {
      text,
      changedLines,
      priorStableIdentities: [...identities].sort(),
      coverageOmissions: omissions,
    };
  }

  public async publish(
    plan: Extract<PublicationPlan, { kind: "publish" }>,
  ): Promise<Readonly<{ reviewId: number }>> {
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
