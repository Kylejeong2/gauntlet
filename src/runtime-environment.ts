import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const githubEnvironmentSchema = z
  .object({
    APP_ID: z.string().regex(/^\d+$/),
    WEBHOOK_SECRET: z.string().min(32),
    PRIVATE_KEY: z.string().min(1).optional(),
    PRIVATE_KEY_PATH: z.string().min(1).optional(),
  })
  .refine(
    (environment) =>
      environment.PRIVATE_KEY !== undefined ||
      environment.PRIVATE_KEY_PATH !== undefined,
    { message: "PRIVATE_KEY or PRIVATE_KEY_PATH is required" },
  );

export type LoadedRuntimeEnvironment = Readonly<{
  environment: NodeJS.ProcessEnv;
  webhookSecretSource: "env-file" | "process";
  webhookSecretFingerprint: string;
}>;

export const loadRuntimeEnvironment = (
  processEnvironment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): LoadedRuntimeEnvironment => {
  const envPath = resolve(workingDirectory, ".env");
  let fileEnvironment: NodeJS.Dict<string> = {};
  try {
    fileEnvironment = parseEnv(readFileSync(envPath, "utf8"));
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }
  const environment = { ...processEnvironment, ...fileEnvironment };
  const github = githubEnvironmentSchema.parse(environment);
  return {
    environment,
    webhookSecretSource:
      fileEnvironment.WEBHOOK_SECRET === undefined ? "process" : "env-file",
    webhookSecretFingerprint: fingerprintSecret(github.WEBHOOK_SECRET),
  };
};

export const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
