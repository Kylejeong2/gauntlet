# Configuration

Gauntlet has one GitHub provider, one model, one sandbox provider, and one local database in the first release. Keeping those choices narrow makes costs and failure behavior visible.

## Environment variables

| Variable         | Required | Purpose                                                              |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `APP_ID`         | Yes      | Numeric GitHub App ID consumed by Probot.                            |
| `PRIVATE_KEY`    | Yes      | GitHub App PEM private key consumed by Probot.                       |
| `WEBHOOK_SECRET` | Yes      | HMAC secret used by Probot to authenticate webhook bodies.           |
| `SAIL_API_KEY`   | Yes      | Host-only credential for Sail inference and Sailbox lifecycle calls. |
| `DATABASE_PATH`  | No       | SQLite path. Defaults to `./data/gauntlet.db`.                       |
| `LOG_LEVEL`      | No       | Probot log level. Defaults to Probot's normal setting.               |

The process environment is the configuration boundary. Gauntlet does not forward it to a Sailbox. Every sandbox command receives an explicit empty environment overlay and the Sail SDK communicates with the box from the host.

## Inference contract

The model slug is fixed to `openai/gpt-oss-120b`. Requests use Sail's OpenAI-compatible Responses endpoint at `https://api.sailresearch.com/v1/responses` with:

- `metadata.completion_window` set to `asap`.
- `reasoning.effort` set to `low`.
- Strict JSON Schema output.
- A maximum of 3,000 output tokens.
- A 180-second request timeout.
- Serial model calls and bounded retries for HTTP 429 responses.

Gauntlet does not silently change models. A provider rejection, timeout, malformed response, missing reviewer report, or inconclusive challenge fails closed. GPT-OSS may emit a reasoning item before its message item; Gauntlet reads only `output_text` content and validates the extracted JSON again with Zod.

The local price estimate uses $0.06 per million input tokens and $0.40 per million output tokens. Prices are configuration facts captured on 2026-08-22, not a billing guarantee. The app reads actual response token counts and converts them to integer microdollars.

## Sailbox contract

Each run creates one size `s` Sailbox with 2 GiB of memory and 8 GiB of disk, the minimums enforced by SDK 0.9.0 on 2026-08-22. Gauntlet clones only a public HTTPS repository, fetches the exact base and head SHAs, and checks out the head in detached mode.

Repository commands use argument arrays, explicit working directories, empty environment overlays, timeouts, and bounded captured output. Lockfile discovery selects pnpm, npm, or Yarn. Installation uses the matching frozen or immutable mode with lifecycle and build scripts disabled. Gauntlet reads the checked-out `package.json` through `git show` and schedules only scripts that exist. It recognizes `test`, `lint`, `typecheck`, `type-check`, `build`, `docs:build`, `build:docs`, and `docs`. A missing or malformed manifest does not create a guessed script command. The box terminates in a `finally` path after success or failure.

The ledger reserves $0.01 for the bounded Sailbox lifecycle. This is intentionally conservative and is reported as an estimate rather than settled billing.

## Budget contract

Every reviewer may emit at most three findings. At ten reviewers, the worst case is ten reviewer calls and thirty independent challenge calls. Gauntlet reserves 3,000 microdollars per model request and 10,000 microdollars for the Sailbox, for a maximum admitted plan of 130,000 microdollars ($0.13). The global run ceiling remains 250,000 microdollars ($0.25).

No paid work begins if the worst-case reservation cannot fit. Runtime accounting also fails if observed estimates cross the hard ceiling.
