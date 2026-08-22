import { describe, expect, it } from "vitest";
import {
  SailboxReviewEnvironment,
  type SailboxFactory,
  type SailboxInstance,
} from "../src/adapters/sailbox.js";
import { commitSha, reviewerId, runId } from "../src/domain/ids.js";
import { CORE_REVIEWERS } from "../src/domain/reviewers.js";

describe("Sailbox lifecycle", () => {
  it("creates a small credential-free box, checks out the exact head, and terminates it", async () => {
    const commands: Readonly<{
      argv: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }>[] = [];
    let terminated = false;
    const instance: SailboxInstance = {
      id: "box-1",
      run: (argv, options) => {
        commands.push({ argv: [...argv], ...options });
        return Promise.resolve({
          exitCode: 0,
          stdout:
            argv[0] === "git" && argv[1] === "ls-files"
              ? "package.json\npnpm-lock.yaml\n"
              : argv[0] === "git" && argv[1] === "show"
                ? JSON.stringify({
                    scripts: {
                      test: "vitest run",
                      lint: "eslint .",
                      "docs:build": "typedoc",
                    },
                  })
                : "ok",
          stderr: "",
        });
      },
      terminate: () => {
        terminated = true;
        return Promise.resolve();
      },
    };
    const creates: unknown[] = [];
    const factory: SailboxFactory = {
      create: (options) => {
        creates.push(options);
        return Promise.resolve(instance);
      },
    };
    const environment = new SailboxReviewEnvironment(factory);
    const input = {
      runId: runId("run-1"),
      owner: "Kylejeong2",
      repository: "gauntlet",
      pullNumber: 1,
      baseSha: commitSha("a".repeat(40)),
      headSha: commitSha("b".repeat(40)),
      snapshotText: "diff",
      changedLines: [],
      priorStableIdentities: [],
      coverageOmissions: [],
      reviewers: CORE_REVIEWERS,
    };

    const handle = await environment.prepare(input);
    expect(creates).toEqual([
      { name: "gauntlet-run-1", size: "s", memoryLimitGib: 2, diskLimitGib: 8 },
    ]);
    expect(commands[0]).toEqual({
      argv: [
        "git",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "https://github.com/Kylejeong2/gauntlet.git",
        "/workspace/repo",
      ],
      cwd: "/workspace",
      env: {},
      timeoutSeconds: 120,
    });
    expect(commands[3]?.argv).toEqual([
      "git",
      "checkout",
      "--detach",
      "b".repeat(40),
    ]);
    await environment.evidence(handle, reviewerId("security"));
    await environment.evidence(handle, reviewerId("edge-cases"));
    await environment.evidence(handle, reviewerId("documentation"));
    expect(
      commands.filter((command) =>
        command.argv.join(" ").includes("pnpm install"),
      ),
    ).toHaveLength(1);
    expect(
      commands.filter(
        (command) => command.argv.join(" ") === "corepack pnpm test",
      ),
    ).toHaveLength(1);
    expect(
      commands.filter(
        (command) => command.argv.join(" ") === "corepack pnpm run docs:build",
      ),
    ).toHaveLength(1);
    expect(
      commands.some((command) =>
        command.argv.join(" ").includes("pnpm typecheck"),
      ),
    ).toBe(false);
    await environment.terminate(handle);
    expect(terminated).toBe(true);
  });

  it("terminates a partially prepared box when checkout setup fails", async () => {
    let terminated = false;
    const factory: SailboxFactory = {
      create: () =>
        Promise.resolve({
          id: "box-failed",
          run: () =>
            Promise.resolve({
              exitCode: 1,
              stdout: "",
              stderr: "clone failed",
            }),
          terminate: () => {
            terminated = true;
            return Promise.resolve();
          },
        }),
    };
    const environment = new SailboxReviewEnvironment(factory);
    await expect(
      environment.prepare({
        runId: runId("run-failed"),
        owner: "Kylejeong2",
        repository: "gauntlet",
        pullNumber: 1,
        baseSha: commitSha("a".repeat(40)),
        headSha: commitSha("b".repeat(40)),
        snapshotText: "diff",
        changedLines: [],
        priorStableIdentities: [],
        coverageOmissions: [],
        reviewers: CORE_REVIEWERS,
      }),
    ).rejects.toThrow("clone failed");
    expect(terminated).toBe(true);
  });
});
