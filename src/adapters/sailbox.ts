import { App, Image, Sailbox } from "@sailresearch/sdk";
import { z } from "zod";
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
      image: "devbox";
      size: "s";
      memoryLimitGib: number;
      diskLimitGib: number;
    }>,
  ) => Promise<SailboxInstance>;
}>;

export type SailboxAuditEvent = Readonly<{
  kind: "sailbox_created" | "command_completed" | "sailbox_terminated";
  sailboxId: string;
  command?: readonly string[];
  exitCode?: number;
}>;

export class SailSdkFactory implements SailboxFactory {
  readonly #appName: string;

  public constructor(appName = "gauntlet") {
    this.#appName = appName;
  }

  public async create(
    options: Readonly<{
      name: string;
      image: "devbox";
      size: "s";
      memoryLimitGib: number;
      diskLimitGib: number;
    }>,
  ): Promise<SailboxInstance> {
    const app = await App.find(this.#appName, { mintIfMissing: true });
    const box = await Sailbox.create({
      app,
      name: options.name,
      size: options.size,
      memoryLimitGib: options.memoryLimitGib,
      diskLimitGib: options.diskLimitGib,
      image: Image.devbox(),
    });
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
  projectCommands: ProjectCommands | null;
  evidenceCache: Map<string, Promise<SailboxCommandResult>>;
}>;

type ProjectCommands = Readonly<{
  install: readonly string[];
  test?: readonly string[];
  lint?: readonly string[];
  typecheck?: readonly string[];
  build?: readonly string[];
  documentation?: readonly string[];
}>;

export class SailboxReviewEnvironment {
  readonly #factory: SailboxFactory;
  readonly #audit: (event: SailboxAuditEvent) => void;
  readonly #instances = new Map<string, EnvironmentState>();

  public constructor(
    factory: SailboxFactory = new SailSdkFactory(),
    audit: (event: SailboxAuditEvent) => void = (event) => {
      void event;
    },
  ) {
    this.#factory = factory;
    this.#audit = audit;
  }

  public async prepare(input: ReviewRunInput): Promise<EnvironmentHandle> {
    const safeRunName = input.runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
    const instance = await this.#factory.create({
      name: `gauntlet-${safeRunName}`,
      image: "devbox",
      size: "s",
      memoryLimitGib: 2,
      diskLimitGib: 8,
    });
    this.#audit({ kind: "sailbox_created", sailboxId: instance.id });
    try {
      await checkedRun(
        instance,
        ["mkdir", "-p", "/workspace"],
        "/",
        this.#audit,
      );
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
        this.#audit,
      );
      await checkedRun(
        instance,
        ["git", "fetch", "--depth=1", "origin", input.headSha],
        "/workspace/repo",
        this.#audit,
      );
      await checkedRun(
        instance,
        ["git", "fetch", "--depth=1", "origin", input.baseSha],
        "/workspace/repo",
        this.#audit,
      );
      await checkedRun(
        instance,
        ["git", "checkout", "--detach", input.headSha],
        "/workspace/repo",
        this.#audit,
      );
      const manifests = await checkedRun(
        instance,
        [
          "git",
          "ls-files",
          "package.json",
          "pnpm-lock.yaml",
          "package-lock.json",
          "yarn.lock",
        ],
        "/workspace/repo",
        this.#audit,
      );
      const packageJson = manifests.stdout
        .split("\n")
        .some((file) => file.trim() === "package.json")
        ? await checkedRun(
            instance,
            ["git", "show", "HEAD:package.json"],
            "/workspace/repo",
            this.#audit,
          )
        : undefined;
      this.#instances.set(instance.id, {
        instance,
        input,
        projectCommands: detectProjectCommands(
          manifests.stdout,
          packageJson?.stdout,
        ),
        evidenceCache: new Map(),
      });
      return { id: instance.id, estimatedCost: usdMicros(10_000) };
    } catch (error: unknown) {
      this.#instances.delete(instance.id);
      await instance.terminate();
      this.#audit({ kind: "sailbox_terminated", sailboxId: instance.id });
      throw error;
    }
  }

  public async evidence(
    handle: EnvironmentLookupHandle,
    reviewer: ReviewerId,
  ): Promise<readonly string[]> {
    const state = this.#instances.get(handle.id);
    if (state === undefined) throw new Error("Sailbox is not active");
    const requests = evidenceCommands(
      reviewer,
      state.input,
      state.projectCommands,
    );
    const evidence: string[] = [];
    for (const request of requests) {
      let pending = state.evidenceCache.get(request.key);
      if (pending === undefined) {
        pending = runEvidenceCommand(state.instance, request.argv, this.#audit);
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
    this.#audit({ kind: "sailbox_terminated", sailboxId: state.instance.id });
  }
}

const checkedRun = async (
  instance: SailboxInstance,
  argv: readonly string[],
  cwd: string,
  audit: (event: SailboxAuditEvent) => void,
): Promise<SailboxCommandResult> => {
  const result = await instance.run(inDirectory(cwd, argv), {
    env: {},
    timeoutSeconds: 120,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Sailbox command failed (${String(result.exitCode)}): ${result.stderr.slice(-500)}`,
    );
  audit({
    kind: "command_completed",
    sailboxId: instance.id,
    command: argv,
    exitCode: result.exitCode,
  });
  return result;
};

type EvidenceCommand = Readonly<{ key: string; argv: readonly string[] }>;

const evidenceCommands = (
  reviewer: ReviewerId,
  input: ReviewRunInput,
  projectCommands: ProjectCommands | null,
): readonly EvidenceCommand[] => {
  const diffCheck: EvidenceCommand = {
    key: "diff-check",
    argv: ["git", "diff", "--check", `${input.baseSha}..${input.headSha}`],
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
  if (reviewer === reviewerId("dependency-history")) return [dependencies];
  if (projectCommands === null) return [diffCheck];
  const install: EvidenceCommand = {
    key: "install",
    argv: projectCommands.install,
  };
  const optionalCommand = (
    key: string,
    argv: readonly string[] | undefined,
  ): readonly EvidenceCommand[] => (argv === undefined ? [] : [{ key, argv }]);
  const tests = optionalCommand("tests", projectCommands.test);
  const lint = optionalCommand("lint", projectCommands.lint);
  const typecheck = optionalCommand("typecheck", projectCommands.typecheck);
  const build = optionalCommand("build", projectCommands.build);
  const documentation = optionalCommand(
    "documentation",
    projectCommands.documentation,
  );
  if (reviewer === reviewerId("documentation"))
    return documentation.length === 0
      ? [diffCheck]
      : [install, ...documentation];
  if (reviewer === reviewerId("new-user-simulation"))
    return [install, ...build];
  if (reviewer === reviewerId("api-compatibility"))
    return [install, ...typecheck, ...tests];
  if (reviewer === reviewerId("performance"))
    return [install, ...build, ...tests];
  if (reviewer === reviewerId("test-quality")) return [install, ...tests];
  if (reviewer === reviewerId("concurrency"))
    return [install, ...typecheck, ...tests];
  return [install, ...lint, ...tests];
};

const detectProjectCommands = (
  manifestList: string,
  packageJson: string | undefined,
): ProjectCommands | null => {
  const files = new Set(
    manifestList
      .split("\n")
      .map((file) => file.trim())
      .filter((file) => file.length > 0),
  );
  const scripts = parsePackageScripts(packageJson);
  if (files.has("pnpm-lock.yaml")) {
    const runner = (name: string): readonly string[] =>
      name === "test" || name === "lint" || name === "typecheck"
        ? ["corepack", "pnpm", name]
        : ["corepack", "pnpm", "run", name];
    return projectCommandsFor(
      ["corepack", "pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      runner,
      scripts,
    );
  }
  if (files.has("package-lock.json")) {
    const runner = (name: string): readonly string[] =>
      name === "test" ? ["npm", "test"] : ["npm", "run", name];
    return projectCommandsFor(
      ["npm", "ci", "--ignore-scripts"],
      runner,
      scripts,
    );
  }
  if (files.has("yarn.lock")) {
    const runner = (name: string): readonly string[] => [
      "corepack",
      "yarn",
      name,
    ];
    return projectCommandsFor(
      ["corepack", "yarn", "install", "--immutable", "--mode=skip-build"],
      runner,
      scripts,
    );
  }
  return null;
};

const projectCommandsFor = (
  install: readonly string[],
  runner: (name: string) => readonly string[],
  scripts: ReadonlySet<string>,
): ProjectCommands => {
  const find = (...names: readonly string[]): readonly string[] | undefined => {
    const name = names.find((candidate) => scripts.has(candidate));
    return name === undefined ? undefined : runner(name);
  };
  const test = find("test");
  const lint = find("lint");
  const typecheck = find("typecheck", "type-check");
  const build = find("build");
  const documentation = find("docs:build", "build:docs", "docs");
  return {
    install,
    ...(test === undefined ? {} : { test }),
    ...(lint === undefined ? {} : { lint }),
    ...(typecheck === undefined ? {} : { typecheck }),
    ...(build === undefined ? {} : { build }),
    ...(documentation === undefined ? {} : { documentation }),
  };
};

const parsePackageScripts = (packageJson: string | undefined): Set<string> => {
  if (packageJson === undefined || packageJson.length > 256_000)
    return new Set();
  try {
    const parsed = z
      .looseObject({
        scripts: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(JSON.parse(packageJson));
    return parsed.success
      ? new Set(Object.keys(parsed.data.scripts ?? {}))
      : new Set();
  } catch {
    return new Set();
  }
};

const runEvidenceCommand = (
  instance: SailboxInstance,
  argv: readonly string[],
  audit: (event: SailboxAuditEvent) => void,
): Promise<SailboxCommandResult> =>
  instance
    .run(inDirectory("/workspace/repo", argv), {
      env: {},
      timeoutSeconds: 180,
    })
    .then((result) => {
      audit({
        kind: "command_completed",
        sailboxId: instance.id,
        command: argv,
        exitCode: result.exitCode,
      });
      return result;
    });

const inDirectory = (
  cwd: string,
  argv: readonly string[],
): readonly string[] => ["env", "-C", cwd, ...argv];
