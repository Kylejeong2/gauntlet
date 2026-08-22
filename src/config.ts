import { z } from "zod";

const runtimeConfigSchema = z.looseObject({
  SAIL_API_KEY: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default("./data/gauntlet.db"),
});

export type RuntimeConfig = Readonly<{
  sailApiKey: string;
  databasePath: string;
}>;

export const loadRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig => {
  const parsed = runtimeConfigSchema.parse(environment);
  return {
    sailApiKey: parsed.SAIL_API_KEY,
    databasePath: parsed.DATABASE_PATH,
  };
};
