import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fingerprintSecret,
  loadRuntimeEnvironment,
} from "../src/runtime-environment.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("runtime environment", () => {
  it("uses the persistent env file as the authoritative local secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "gauntlet-environment-"));
    directories.push(directory);
    const persistentSecret = "a".repeat(64);
    writeFileSync(
      join(directory, ".env"),
      [
        "APP_ID=4683878",
        "PRIVATE_KEY_PATH=/tmp/app.pem",
        `WEBHOOK_SECRET=${persistentSecret}`,
      ].join("\n"),
    );

    const loaded = loadRuntimeEnvironment(
      {
        APP_ID: "1",
        PRIVATE_KEY: "ephemeral",
        WEBHOOK_SECRET: "b".repeat(64),
      },
      directory,
    );

    expect(loaded.environment.WEBHOOK_SECRET).toBe(persistentSecret);
    expect(loaded.webhookSecretSource).toBe("env-file");
    expect(loaded.webhookSecretFingerprint).toBe(
      `sha256:${createHash("sha256").update(persistentSecret).digest("hex").slice(0, 12)}`,
    );
  });

  it("rejects short secrets and missing GitHub authentication", () => {
    const directory = mkdtempSync(join(tmpdir(), "gauntlet-environment-"));
    directories.push(directory);

    expect(() =>
      loadRuntimeEnvironment(
        {
          APP_ID: "4683878",
          PRIVATE_KEY: "key",
          WEBHOOK_SECRET: "short",
        },
        directory,
      ),
    ).toThrow();
  });

  it("produces a stable non-secret fingerprint", () => {
    expect(fingerprintSecret("c".repeat(64))).toBe(
      fingerprintSecret("c".repeat(64)),
    );
    expect(fingerprintSecret("c".repeat(64))).not.toContain("c".repeat(16));
  });
});
