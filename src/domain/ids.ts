import { z } from "zod";

const nonEmptyId = (name: string) =>
  z.string().trim().min(1, `${name} must not be empty`).max(255);
const positiveInteger = (name: string) =>
  z
    .number()
    .int(`${name} must be an integer`)
    .positive(`${name} must be positive`);

const runIdSchema = nonEmptyId("RunId").brand<"RunId">();
const deliveryIdSchema = nonEmptyId("DeliveryId").brand<"DeliveryId">();
const installationIdSchema =
  positiveInteger("InstallationId").brand<"InstallationId">();
const repositoryIdSchema =
  positiveInteger("RepositoryId").brand<"RepositoryId">();
const pullNumberSchema = positiveInteger("PullNumber").brand<"PullNumber">();
const commitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i, "CommitSha must be a 40-character hexadecimal SHA")
  .brand<"CommitSha">();
const reviewerIdSchema = nonEmptyId("ReviewerId").brand<"ReviewerId">();
const findingIdSchema = nonEmptyId("FindingId").brand<"FindingId">();
const workerIdSchema = nonEmptyId("WorkerId").brand<"WorkerId">();
const usdMicrosSchema = z.number().int().nonnegative().brand<"UsdMicros">();

export type RunId = z.infer<typeof runIdSchema>;
export type DeliveryId = z.infer<typeof deliveryIdSchema>;
export type InstallationId = z.infer<typeof installationIdSchema>;
export type RepositoryId = z.infer<typeof repositoryIdSchema>;
export type PullNumber = z.infer<typeof pullNumberSchema>;
export type CommitSha = z.infer<typeof commitShaSchema>;
export type ReviewerId = z.infer<typeof reviewerIdSchema>;
export type FindingId = z.infer<typeof findingIdSchema>;
export type WorkerId = z.infer<typeof workerIdSchema>;
export type UsdMicros = z.infer<typeof usdMicrosSchema>;

export const runId = (value: unknown): RunId => runIdSchema.parse(value);
export const deliveryId = (value: unknown): DeliveryId =>
  deliveryIdSchema.parse(value);
export const installationId = (value: unknown): InstallationId =>
  installationIdSchema.parse(value);
export const repositoryId = (value: unknown): RepositoryId =>
  repositoryIdSchema.parse(value);
export const pullNumber = (value: unknown): PullNumber =>
  pullNumberSchema.parse(value);
export const commitSha = (value: unknown): CommitSha =>
  commitShaSchema.parse(value);
export const reviewerId = (value: unknown): ReviewerId =>
  reviewerIdSchema.parse(value);
export const findingId = (value: unknown): FindingId =>
  findingIdSchema.parse(value);
export const workerId = (value: unknown): WorkerId =>
  workerIdSchema.parse(value);
export const usdMicros = (value: unknown): UsdMicros =>
  usdMicrosSchema.parse(value);

export const idSchemas = {
  runId: runIdSchema,
  deliveryId: deliveryIdSchema,
  installationId: installationIdSchema,
  repositoryId: repositoryIdSchema,
  pullNumber: pullNumberSchema,
  commitSha: commitShaSchema,
  reviewerId: reviewerIdSchema,
  findingId: findingIdSchema,
  workerId: workerIdSchema,
  usdMicros: usdMicrosSchema,
};
