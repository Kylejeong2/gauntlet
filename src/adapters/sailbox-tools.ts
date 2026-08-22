export type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CommandSandbox = Readonly<{
  exec: (argv: readonly string[]) => Promise<CommandResult>;
}>;

const projectCommands = {
  test: ["pnpm", "test", "--", "--runInBand"],
  typecheck: ["pnpm", "typecheck"],
  lint: ["pnpm", "lint"],
  build: ["pnpm", "build"],
} as const;

export type ProjectCommand = keyof typeof projectCommands;

export class AllowlistedToolBroker {
  readonly #sandbox: CommandSandbox;
  readonly #checkoutDirectory: string;
  readonly #maxOutputCharacters: number;

  public constructor(
    sandbox: CommandSandbox,
    options: Readonly<{
      checkoutDirectory: string;
      maxOutputCharacters?: number;
    }>,
  ) {
    this.#sandbox = sandbox;
    this.#checkoutDirectory = options.checkoutDirectory;
    this.#maxOutputCharacters = options.maxOutputCharacters ?? 12_000;
  }

  public async runProjectCommand(name: string): Promise<CommandResult> {
    if (!Object.hasOwn(projectCommands, name))
      throw new Error(`Unknown project command: ${name}`);
    const argv = projectCommands[name as ProjectCommand];
    const result = await this.#sandbox.exec(argv);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-this.#maxOutputCharacters),
      stderr: result.stderr.slice(-this.#maxOutputCharacters),
    };
  }

  public describeCheckout(): string {
    return this.#checkoutDirectory;
  }
}
