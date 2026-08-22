# Testing Gauntlet

Gauntlet requires Node.js 22 or newer and pnpm 10. The lockfile pins all JavaScript dependencies. pnpm is configured to build the native `better-sqlite3` dependency during installation.

## Complete local gate

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting verification, ESLint, strict TypeScript checking, Vitest, and the declaration build in that order. It performs no network requests after dependencies are installed and uses an in-memory SQLite database.

## Individual commands

| Command             | Behavior                                                 |
| ------------------- | -------------------------------------------------------- |
| `pnpm format`       | Formats package, source, test, and maintained docs.      |
| `pnpm format:check` | Checks formatting without modifying files.               |
| `pnpm lint`         | Runs type-aware strict ESLint rules.                     |
| `pnpm typecheck`    | Checks all source and tests without emitting JavaScript. |
| `pnpm test`         | Runs deterministic unit and SQLite integration tests.    |
| `pnpm build`        | Emits ESM JavaScript, source maps, and declarations.     |
| `pnpm check`        | Runs every non-live local gate.                          |

## Current acceptance-criteria coverage

The domain tests cover the eight mandatory and two optional reviewer definitions, the ten-reviewer ceiling, 1-to-5 readiness scores, strict candidate-finding fields, and the three-finding ceiling. These checks map to AC-4, AC-5, AC-6, and AC-14.

The pure-policy tests cover conservative integer-microdollar estimates, the $0.25 reservation ceiling, challenge failure closure, exact changed-line validation, stable-identity suppression, deterministic deduplication and ranking, the five-comment ceiling, sensitive-value redaction, and deterministic scheduling. These checks map to AC-7, AC-8, AC-10, AC-13, and AC-15.

The SQLite integration tests execute direct migrations against a real in-memory SQLite database. They cover duplicate deliveries, rejected-delivery reasons, same-target delivery idempotency, new-head runs, immutable snapshot put and reload, snapshot conflicts, lease exclusion, expired-lease recovery, stale-owner rejection, idempotent budget reservation, and overflow denial. These checks map to AC-1, AC-2, AC-3, AC-10, AC-13, AC-14, and the applicable SQLite layer of AC-16.

## Provider and orchestration contracts

The GitHub suites cover complete event classification, public-only, draft, bot, and unsupported-action filtering, unified-patch right-side line extraction, constant-time webhook signature verification, exact-SHA comparison, merge-base capture, bounded pagination, prior stable-marker extraction, exact-head COMMENT review rendering, and one-call publication.

The Sail suites assert the DeepSeek V4 Flash model slug, `metadata.completion_window: "asap"`, disabled storage, strict output parsing, integer-microdollar token accounting, bounded transient retry, malformed-response failure, and reviewer identity preservation.

The Sailbox suites assert size `s` with the live provider minimums, public HTTPS clone, exact base and head fetch, detached checkout, empty command environments, argument arrays, timeouts, bounded output, allowlisted project commands, setup-failure cleanup, and normal termination.

The orchestration suites prove all selected reviewers run, every candidate gets a distinct challenge call, reviewer or provider failure publishes nothing, sandbox cleanup runs in a `finally` path, the full ten-reviewer plan reserves $0.13, and successful output makes one GitHub call.

These tests extend coverage through AC-1 to AC-11, AC-13 to AC-15, and the implemented portions of AC-16.

## Live smoke record

On 2026-08-22, the Sail SDK 0.9.0 live smoke created size `s` Sailbox `sb_32526880-0867-48e4-a173-69fdb5b4e91f` with 2 GiB memory and 8 GiB disk, executed `uname -s` with an empty environment overlay, observed exit code 0 and `Linux`, and terminated the same ID. Earlier attempts failed locally before allocation and established the provider-enforced size minimums.

The live DeepSeek smoke established the current request contract. Sail rejected the obsolete `service_tier` field, accepted `metadata.completion_window: "asap"`, and exposed reviewer identity drift, rate limiting, and slow capacity before the client was hardened. The final production call completed with response ID `resp_01a028bf-4ab0-7115-900a-2476a057eaa2`, a schema-valid security score of 4, zero findings, and an estimated cost of 68 microdollars. The production schema fixes reviewer identity with `const`, and transient 429/5xx responses retry without changing models.

The first GitHub Actions CI run passed dependency installation and `pnpm check` in 31 seconds. Two public fixture PRs then passed CI: the command-injection fixture after its source moved under the TypeScript project, and the documentation-only control fixture on its first run.

A local production-server smoke sent pull-request payloads through Probot's real HTTP route after the exact-snapshot change. An invalid HMAC returned 400. A valid eligible payload returned 200 in 3.4 ms and persisted one run before background processing. A valid unsupported action returned 200 in 1.6 ms and persisted `unsupported_action` without a run. The intentionally fake installation then failed cleanly in the worker. The captured log contained nine `[REDACTED]` markers and contained neither the JSON webhook body nor the invalid signature. A unit contract preserves the nested Probot error shapes that required redaction.

GitHub App creation, installation, live webhook delivery, visible review, and stable-marker update remain open live gates. They require persistent repository access and are performed only with user confirmation at the GitHub action boundary.

## TDD evidence

The first production modules were preceded by tests importing the intended domain and storage boundaries. The initial `pnpm test` run failed because `src/domain/ids.ts`, `src/domain/budget.ts`, and `src/storage/run-store.ts` did not exist. After implementation, the same suites run without mocks against the pure policies and SQLite.

The provider and orchestration modules followed the same sequence. Their initial suites failed on missing `src/adapters` and `src/application` modules. The next runs exposed an obsolete Sail request field, undersized Sailbox resources, provider identity drift, and missing cleanup details before the final green gate.
