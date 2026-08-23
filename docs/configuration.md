# Configuration

Gauntlet has one GitHub provider, one model, one sandbox provider, and one local database in the first release. Keeping those choices narrow makes costs and failure behavior visible.

## Environment variables

| Variable           | Required | Purpose                                                              |
| ------------------ | -------- | -------------------------------------------------------------------- |
| `APP_ID`           | Yes      | Numeric GitHub App ID consumed by Probot.                            |
| `PRIVATE_KEY`      | Yes*     | GitHub App PEM private key consumed by Probot.                       |
| `PRIVATE_KEY_PATH` | Yes*     | Absolute path to the GitHub App PEM; preferred for local hosting.    |
| `WEBHOOK_SECRET`   | Yes      | HMAC secret used by Probot to authenticate webhook bodies.           |
| `SAIL_API_KEY`     | Yes      | Host-only credential for Sail inference and Sailbox lifecycle calls. |
| `DATABASE_PATH`    | No       | SQLite path. Defaults to `./data/gauntlet.db`.                       |
| `LOG_LEVEL`        | No       | Probot log level. Defaults to Probot's normal setting.               |

Exactly one of `PRIVATE_KEY` or `PRIVATE_KEY_PATH` is required. An ignored local `.env` overrides matching process values, which makes it the stable source of truth during local restarts. Hosted deployments should store the same fixed values in their secret manager. Gauntlet does not forward this environment to a Sailbox. Every sandbox command receives an explicit empty environment overlay and the Sail SDK communicates with the box from the host.

`pnpm local:configure` creates `WEBHOOK_SECRET` once and refuses an accidental replacement. The only time an operator should change it is an intentional credential rotation coordinated with the GitHub App setting. Startup validates the GitHub variables and prints a non-secret SHA-256 fingerprint of the effective webhook secret.

## Inference contract

The model slug is fixed to `deepseek/deepseek-v4-flash-0731`. Requests use Sail's OpenAI-compatible Responses endpoint at `https://api.sailresearch.com/v1/responses` with:

- `metadata.completion_window` set to `asap`, the window supported by DeepSeek V4 Flash.
- `reasoning.effort` set to `low`.
- Strict JSON Schema output.
- A 180-second request timeout.
- Serial model calls through Sail's `asap` completion window, with bounded exponential backoff for HTTP 429 responses at 15, 30, 60, 120, and 240 seconds.
- A 6,000-token response ceiling with concise schema-only output instructions.

Gauntlet does not silently change models. A provider rejection, timeout, malformed response, missing reviewer report, malformed final synthesis, or inconclusive challenge fails closed. The client reads only `output_text` content from the response envelope and validates the extracted JSON again with Zod. The final synthesis is one additional structured request after every specialist and challenge completes. It returns a headline, a 120-to-350-word overview, and up to six items each for changes, risks, and recommended actions.

The local price estimate uses $0.09 per million input tokens and $0.18 per million output tokens. Prices are configuration facts captured from Sail's official pricing page on 2026-08-23, not a billing guarantee. The app reads actual response token counts and converts them to integer microdollars.

## Sailbox contract

Each run creates one size `s` Sailbox with 2 GiB of memory and 8 GiB of disk, the minimums enforced by SDK 0.9.0 on 2026-08-22. Gauntlet clones only a public HTTPS repository, fetches the exact base and head SHAs, and checks out the head in detached mode.

Repository commands use argument arrays, explicit working directories, empty environment overlays, timeouts, and bounded captured output. Lockfile discovery selects pnpm, npm, or Yarn. Installation uses the matching frozen or immutable mode with lifecycle and build scripts disabled. Gauntlet reads the checked-out `package.json` through `git show` and schedules only scripts that exist. It recognizes `test`, `lint`, `typecheck`, `type-check`, `build`, `docs:build`, `build:docs`, and `docs`. A missing or malformed manifest does not create a guessed script command. The box terminates in a `finally` path after success or failure.

The ledger reserves $0.01 for the bounded Sailbox lifecycle. This is intentionally conservative and is reported as an estimate rather than settled billing.

## Budget contract

Every reviewer may emit at most three findings. At ten reviewers, the worst case is ten reviewer calls, thirty independent challenge calls, and one final synthesis call. Gauntlet reserves 3,000 microdollars per model request and 10,000 microdollars for the Sailbox, for a maximum admitted plan of 133,000 microdollars ($0.133). The global run ceiling remains 250,000 microdollars ($0.25).

No paid work begins if the worst-case reservation cannot fit. Runtime accounting also fails if observed estimates cross the hard ceiling.
