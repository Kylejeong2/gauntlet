import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

const cliArguments = process.argv.slice(2);
if (cliArguments[0] === "--") cliArguments.shift();

const { values } = parseArgs({
  args: cliArguments,
  options: {
    "app-id": { type: "string" },
    "private-key-path": { type: "string" },
    "secret-file": { type: "string" },
    "database-path": { type: "string" },
    port: { type: "string", default: "3002" },
  },
  strict: true,
});

const appId = values["app-id"];
const privateKeyPath = values["private-key-path"];
if (appId === undefined || !/^\d+$/.test(appId))
  throw new Error("--app-id must be a numeric GitHub App ID");
if (privateKeyPath === undefined)
  throw new Error("--private-key-path is required");

const envPath = resolve(".env");
const currentText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const current = currentText.length === 0 ? {} : parseEnv(currentText);
const suppliedSecret =
  values["secret-file"] === undefined
    ? undefined
    : readFileSync(resolve(values["secret-file"]), "utf8").trim();
const existingSecret = current.WEBHOOK_SECRET;

if (
  existingSecret !== undefined &&
  suppliedSecret !== undefined &&
  existingSecret !== suppliedSecret
)
  throw new Error(
    "Refusing to replace the persistent webhook secret. Remove WEBHOOK_SECRET from .env only when intentionally rotating it.",
  );

const webhookSecret =
  existingSecret ?? suppliedSecret ?? randomBytes(32).toString("hex");
if (webhookSecret.length < 32)
  throw new Error("WEBHOOK_SECRET must contain at least 32 characters");

const nextText = setEnvironmentValues(currentText, {
  APP_ID: appId,
  PRIVATE_KEY_PATH: resolve(privateKeyPath),
  WEBHOOK_SECRET: webhookSecret,
  HOST: "0.0.0.0",
  PORT: values.port,
  DATABASE_PATH:
    values["database-path"] ?? current.DATABASE_PATH ?? "./data/gauntlet.db",
});
const temporaryPath = `${envPath}.tmp`;
writeFileSync(temporaryPath, nextText, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, envPath);

if (process.platform === "darwin") {
  const copied = spawnSync("pbcopy", { input: webhookSecret });
  if (copied.status !== 0)
    throw new Error("Could not copy the webhook secret to the clipboard");
}

process.stdout.write(
  `Local GitHub configuration is persistent in ${envPath}. The existing webhook secret was copied to the clipboard without rotating it.\n`,
);

function setEnvironmentValues(
  text: string,
  valuesToSet: Readonly<Record<string, string>>,
): string {
  let result = text.trimEnd();
  for (const [key, value] of Object.entries(valuesToSet)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    result = pattern.test(result)
      ? result.replace(pattern, line)
      : `${result}${result.length === 0 ? "" : "\n"}${line}`;
  }
  return `${result}\n`;
}
