import { App, Sailbox } from "@sailresearch/sdk";
import type { ReviewRunInput } from "../application/review-runner.js";
import { reviewerId, usdMicros, type ReviewerId } from "../domain/ids.js";

export type SailboxCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type SailboxInstance = Readonly<{
  id: string;
  run: (
    argv: readonly string[],
    options: Readonly<{
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutSeconds?: number;
    }>,
  ) => Promise<SailboxCommandResult>;
  terminate: () => Promise<void>;
}>;

export type SailboxFactory = Readonly<{
  create: (
    options: Readonly<{
      name: string;
      size: "s";
      memoryLimitGib: number;
      diskLimitGib: number;
    }>,
  ) => Promise<SailboxInstance>;
}>;

export class SailSdkFactory implements SailboxFactory {
  readonly #appName: string;

  public constructor(appName = "gauntlet") {
    this.#appName = appName;
  }

  public async create(
    options: Readonly<{
      name: string;
      size: "s";
      memoryLimitGib: number;
      diskLimitGib: number;
    }>,
  ): Promise<SailboxInstance> {
    const app = await App.find(this.#appName, { mintIfMissing: true });
    const box = await Sailbox.create({ app, ...options });
    return {
      id: box.sailboxId,
      run: async (argv, runOptions) => {
        const result = await box.run(argv, {
          ...runOptions,
          check: false,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
      terminate: async () => {
        await box.terminate();
      },
    };
  }
}

type EnvironmentHandle = Readonly<{
  id: string;
  estimatedCost: ReturnType<typeof usdMicros>;
}>;
type EnvironmentLookupHandle = Readonly<{ id: string }>;

type EnvironmentState = Readonly<{
  instance: SailboxInstance;
  input: ReviewRunInput;
  evidenceCache: Map<string, Promise<SailboxCommandResult>>;
}>;

export class SailboxReviewEnvironment {
  readonly #factory: SailboxFactory;
  readonly #instances = new Map<string, EnvironmentState>();

  public constructor(factory: SailboxFactory = new SailSdkFactory()) {
    this.#factory = factory;
  }

  public async prepare(input: ReviewRunInput): Promise<EnvironmentHandle> {
    const safeRunName = input.runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
    const instance = await this.#factory.create({
      name: `gauntlet-${safeRunName}`,
      size: "s",
      memoryLimitGib: 2,
      diskLimitGib: 8,
    });
    this.#instances.set(instance.id, {
      instance,
      input,
      evidenceCache: new Map(),
    });
    try {
      await checkedRun(
        instance,
        [
          "git",
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          `https://github.com/${input.owner}/${input.repository}.git`,
          "/workspace/repo",
        ],
        "/workspace",
      );
      await checkedRun(
        instance,
        ["git", "fetch", "--depth=1", "origin", input.headSha],
        "/workspace/repo",
      );
      await checkedRun(
        instance,
        ["git", "fetch", "--depth=1", "origin", input.baseSha],
        "/workspace/repo",
      );
      await checkedRun(
        instance,
        ["git", "checkout", "--detach", input.headSha],
        "/workspace/repo",
      );
      return { id: instance.id, estimatedCost: usdMicros(10_000) };
    } catch (error: unknown) {
      this.#instances.delete(instance.id);
      await instance.terminate();
      throw error;
    }
  }

  public async evidence(
    handle: EnvironmentLookupHandle,
    reviewer: ReviewerId,
  ): Promise<readonly string[]> {
    const state = this.#instances.get(handle.id);
    if (state === undefined) throw new Error("Sailbox is not active");
    const requests = evidenceCommands(reviewer, state.input);
    const evidence: string[] = [];
    for (const request of requests) {
      let pending = state.evidenceCache.get(request.key);
      if (pending === undefined) {
        pending = runEvidenceCommand(state.instance, request.argv);
        state.evidenceCache.set(request.key, pending);
      }
      const result = await pending;
      evidence.push(
        [
          `$ ${request.argv.join(" ")}`,
          `exit=${String(result.exitCode)}`,
          result.stdout.slice(-6_000),
          result.stderr.slice(-6_000),
        ]
          .filter((part) => part.length > 0)
          .join("\n"),
      );
    }
    return evidence;
  }

  public async terminate(handle: EnvironmentLookupHandle): Promise<void> {
    const state = this.#instances.get(handle.id);
    if (state === undefined) return;
    this.#instances.delete(handle.id);
    await state.instance.terminate();
  }
}

const checkedRun = async (
  instance: SailboxInstance,
  argv: readonly string[],
  cwd: string,
): Promise<SailboxCommandResult> => {
  const result = await instance.run(argv, {
    cwd,
    env: {},
    timeoutSeconds: 120,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Sailbox command failed (${String(result.exitCode)}): ${result.stderr.slice(-500)}`,
    );
  return result;
};

type EvidenceCommand = Readonly<{ key: string; argv: readonly string[] }>;

const evidenceCommands = (
  reviewer: ReviewerId,
  input: ReviewRunInput,
): readonly EvidenceCommand[] => {
  const diffCheck: EvidenceCommand = {
    key: "diff-check",
    argv: ["git", "diff", "--check", `${input.baseSha}..${input.headSha}`],
  };
  const tests: EvidenceCommand = {
    key: "tests",
    argv: ["corepack", "pnpm", "test"],
  };
  const install: EvidenceCommand = {
    key: "install",
    argv: [
      "corepack",
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
  };
  const dependencies: EvidenceCommand = {
    key: "dependency-diff",
    argv: [
      "git",
      "diff",
      `${input.baseSha}..${input.headSha}`,
      "--",
      "package.json",
      "pnpm-lock.yaml",
      "pyproject.toml",
      "requirements.txt",
    ],
  };
  if (reviewer === reviewerId("documentation")) return [diffCheck];
  if (reviewer === reviewerId("dependency-history")) return [dependencies];
  if (reviewer === reviewerId("new-user-simulation")) return [install];
  return [install, tests];
};

const runEvidenceCommand = (
  instance: SailboxInstance,
  argv: readonly string[],
): Promise<SailboxCommandResult> =>
  instance.run(argv, {
    cwd: "/workspace/repo",
    env: {},
    timeoutSeconds: 180,
  });
