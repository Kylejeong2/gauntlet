import { z } from "zod";
import {
  commitSha,
  installationId,
  pullNumber,
  repositoryId,
  runId,
  type CommitSha,
  type InstallationId,
  type PullNumber,
  type RepositoryId,
  type RunId,
} from "./ids.js";

const reviewableFileSchema = z
  .object({
    ordinal: z.number().int().nonnegative().max(299),
    kind: z.literal("reviewable"),
    path: z.string().min(1).max(4_096),
    status: z.string().min(1).max(64),
    patch: z.string().max(200_000),
    changedLines: z.array(z.number().int().positive()).max(100_000),
  })
  .strict();

const omittedFileSchema = z
  .object({
    ordinal: z.number().int().nonnegative().max(299),
    kind: z.literal("omitted"),
    path: z.string().min(1).max(4_096),
    status: z.string().min(1).max(64),
    reason: z.literal("patch_unavailable"),
  })
  .strict();

export const snapshotFileSchema = z.discriminatedUnion("kind", [
  reviewableFileSchema,
  omittedFileSchema,
]);

export const capturedPullRequestSnapshotSchema = z
  .object({
    formatVersion: z.literal(1),
    mergeBaseSha: z.unknown().transform(commitSha),
    files: z.array(snapshotFileSchema).max(300),
    coverageOmissions: z.array(z.string().min(1).max(2_000)).max(400),
  })
  .strict();

export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type CapturedPullRequestSnapshot = z.infer<
  typeof capturedPullRequestSnapshotSchema
>;

export type PersistedPullRequestSnapshot = Readonly<{
  persisted: true;
  runId: RunId;
  installationId: InstallationId;
  repositoryId: RepositoryId;
  pullNumber: PullNumber;
  owner: string;
  repository: string;
  baseSha: CommitSha;
  headSha: CommitSha;
  mergeBaseSha: CommitSha;
  files: readonly SnapshotFile[];
  coverageOmissions: readonly string[];
  capturedAtMs: number;
}>;

export const persistedPullRequestSnapshotSchema = z
  .object({
    persisted: z.literal(true),
    runId: z.unknown().transform(runId),
    installationId: z.unknown().transform(installationId),
    repositoryId: z.unknown().transform(repositoryId),
    pullNumber: z.unknown().transform(pullNumber),
    owner: z.string().trim().min(1).max(255),
    repository: z.string().trim().min(1).max(255),
    baseSha: z.unknown().transform(commitSha),
    headSha: z.unknown().transform(commitSha),
    mergeBaseSha: z.unknown().transform(commitSha),
    files: z.array(snapshotFileSchema).max(300),
    coverageOmissions: z.array(z.string().min(1).max(2_000)).max(400),
    capturedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const projectSnapshot = (
  snapshot: PersistedPullRequestSnapshot,
): Readonly<{
  text: string;
  changedLines: readonly Readonly<{ path: string; lines: readonly number[] }>[];
  coverageOmissions: readonly string[];
}> => {
  const files = [...snapshot.files].sort((left, right) =>
    left.ordinal === right.ordinal
      ? left.path.localeCompare(right.path)
      : left.ordinal - right.ordinal,
  );
  const prefix = [
    `INSTALLATION ${String(snapshot.installationId)}`,
    `REPOSITORY ${snapshot.owner}/${snapshot.repository} (${String(snapshot.repositoryId)})`,
    `PULL ${String(snapshot.pullNumber)}`,
    `BASE ${snapshot.baseSha}`,
    `HEAD ${snapshot.headSha}`,
    `MERGE_BASE ${snapshot.mergeBaseSha}`,
  ].join("\n");
  const sections = files.map(
    (file) =>
      `FILE ${file.path} (${file.status})\n${file.kind === "reviewable" ? file.patch : "[patch unavailable]"}`,
  );
  const combined = `${prefix}\n\n${sections.join("\n\n")}`;
  const text = combined.slice(0, 64_000);
  const coverageOmissions = [...snapshot.coverageOmissions];
  if (combined.length > text.length)
    coverageOmissions.push(
      `Snapshot truncated by ${String(combined.length - text.length)} characters`,
    );
  return {
    text,
    changedLines: files
      .filter((file) => file.kind === "reviewable")
      .map((file) => ({ path: file.path, lines: file.changedLines })),
    coverageOmissions,
  };
};

export const sameCapturedSnapshot = (
  left: CapturedPullRequestSnapshot,
  right: CapturedPullRequestSnapshot,
): boolean => JSON.stringify(left) === JSON.stringify(right);
