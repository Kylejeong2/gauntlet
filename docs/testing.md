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

The pure-policy tests cover conservative integer-microdollar estimates, the $0.25 reservation ceiling, challenge failure closure, exact changed-line validation, cross-specialist corroboration, same-line collapse, stable-identity suppression, deterministic deduplication and ranking, the five-comment ceiling, separate reviewer-comment rendering, compact summary rendering without a fix prompt, fix prompts for specialist scores below 5/5, no fix prompt for 5/5 specialist comments, copyable fix prompts on verified findings, sensitive-value redaction, and deterministic scheduling. These checks map to AC-7, AC-8, AC-10, AC-13, and AC-15.

The SQLite integration tests execute direct migrations against a real in-memory SQLite database. They cover duplicate deliveries, rejected-delivery reasons, same-target delivery idempotency, new-head runs, immutable snapshot put and reload, snapshot conflicts, version-three in-flight migration, atomic successor scheduling, lease exclusion, heartbeat extension, expired-lease recovery, stale-owner rejection, bounded retry, cleanup dead-lettering, put-once reviewer and challenge checkpoints, idempotent budget reservation, and overflow denial. These checks map to AC-1, AC-2, AC-3, AC-10, AC-13, AC-14, and the applicable SQLite layer of AC-16.

## Provider and orchestration contracts

The GitHub suites cover complete event classification, public-only, draft, bot, and unsupported-action filtering, unified-patch right-side line extraction, constant-time webhook signature verification, exact-SHA comparison, merge-base capture, bounded pagination, prior stable-marker extraction, exact-head COMMENT review rendering, separate specialist comments, idempotent PR-description summary replacement, preservation of author text, and final summary publication.

The Sail suites assert the DeepSeek V4 Flash model slug, `metadata.completion_window: "asap"`, low reasoning effort, strict reviewer and final-synthesis output parsing, reasoning-item exclusion, integer-microdollar token accounting at current DeepSeek rates, bounded 429 retry, malformed-response failure, and reviewer identity preservation.

The Sailbox suites assert size `s` with the live provider minimums, public HTTPS clone, exact merge-base and head fetch, detached checkout, merge-base-scoped evidence, empty command environments, argument arrays, timeouts, bounded output, allowlisted project commands, setup-failure cleanup, and normal termination.

The durable-engine suite proves serial specialist execution through checkpoints, one synthesis after stored results, cleanup after review work, the full ten-reviewer bounded retry reservation of $0.171, end-to-end phase advancement, restart without repeating a stored reviewer report, deterministic-name Sailbox reconciliation after a lost creation receipt, and GitHub review reconciliation after a lost publication receipt. Pure publication-policy tests continue to cover distinct challenge requirements, missing-result closure, and final publication shaping.

These tests extend coverage through AC-1 to AC-11, AC-13 to AC-15, and the implemented portions of AC-16.

## Live smoke record

The fix-prompt and synthesis verification used closed public PR #3 at head `897cd7c50953bb419d3d0099f252db844c5589c4`. Signed-webhook run `46ed28d9-3497-4561-9e26-9986ee0d5b0f` completed eight specialist reports, twelve independent challenges, and the new final synthesis call before publishing summary review `5001502455`. The live review rendered twelve collapsed `Prompt to fix` controls: one on every specialist comment, three on verified inline findings, and one on the final summary. Expanding an inline control revealed GitHub's native code-block copy button and a complete path-, line-, evidence-, action-, test-, and verification-aware prompt. The summary rendered a substantive headline and overview followed by `What changed`, `Key risks`, and `Recommended next steps`, plus overall readiness `2.5/5`, duration `237.2s`, estimated cost `$0.014138`, and three verified findings. Chrome DOM inspection and screenshots confirmed both the expanded copy control and summary layout. Sailbox `sb_b92103b8-1bc1-435f-b870-1210bac991bf` terminated after publication, and the intentionally vulnerable fixture PR was closed without merging.

On 2026-08-22, the Sail SDK 0.9.0 live smoke created size `s` Sailbox `sb_32526880-0867-48e4-a173-69fdb5b4e91f` with 2 GiB memory and 8 GiB disk, executed `uname -s` with an empty environment overlay, observed exit code 0 and `Linux`, and terminated the same ID. Earlier attempts failed locally before allocation and established the provider-enforced size minimums.

The 2026-08-22 provider smoke recorded a temporary capacity incident: DeepSeek V4 Flash completed an early request, then returned 429 responses through the full retry window. Gauntlet explicitly moved to GPT-OSS 120B rather than silently falling back at runtime. The historical GPT-OSS production call completed with response ID `resp_01a02aab-140e-71cf-b030-f57a89cb3c12`, and a raw-envelope probe established the client's `output_text` extraction rule.

On 2026-08-23, Sail's authenticated model list again advertised `deepseek/deepseek-v4-flash-0731`, and the official pricing page listed ASAP rates of $0.09 per million input tokens and $0.18 per million output tokens. Gauntlet changed its single fixed model back to DeepSeek V4 Flash and live-verified the same synchronous ASAP, low-reasoning, strict-schema request shape. The compiled production client completed response `resp_01a02ffa-90a9-717c-b427-359c21e289f9`, parsed a documentation report with readiness `5/5` and zero findings, and accounted for the response at 137 microdollars. No runtime fallback was added. The earlier installed-App fixture reviews remain historical GPT-OSS evidence until the next opt-in end-to-end run.

The live Sailbox probes established two SDK contracts that unit mocks initially missed. Direct argument-vector commands cannot combine with the SDK `cwd` option, so Gauntlet uses `env -C` without invoking a shell. Fresh Debian boxes do not contain `/workspace` or the Node toolchain, so Gauntlet creates the directory explicitly and requests Sail's prebuilt development image. Live probes confirmed `env -C`, Node, and Corepack before the installed-App replay.

The first GitHub Actions CI run passed dependency installation and `pnpm check` in 31 seconds. Two public fixture PRs then passed CI: the command-injection fixture after its source moved under the TypeScript project, and the documentation-only control fixture on its first run.

A local production-server smoke sent pull-request payloads through Probot's real HTTP route after the exact-snapshot change. An invalid HMAC returned 400. A valid eligible payload returned 200 in 3.4 ms and persisted one run before background processing. A valid unsupported action returned 200 in 1.6 ms and persisted `unsupported_action` without a run. The intentionally fake installation then failed cleanly in the worker. The captured log contained nine `[REDACTED]` markers and contained neither the JSON webhook body nor the invalid signature. A unit contract preserves the nested Probot error shapes that required redaction.

The installed `gauntlet-review-dev` GitHub App completed two signed-webhook runs on 2026-08-22. Public PR #1 run `e6750a95-dda9-4da9-b23e-7c9a18a2ffaa` used persisted merge base `8ff26e1f917e76a7544c6f8cf06f5afb3545f2e1`, ran repository checks in Sailbox `sb_5600d67f-5932-4b5b-a219-61d99fae5240`, completed eight reviewers and eleven challenges, published eight separate specialist comments plus summary review `5000803125`, emitted one inline command-injection finding, cost an estimated $0.013657, and terminated the box. A same-head close/reopen replay retained the same run ID and left the bot review count unchanged at 19.

The installed App attribution verification used closed public PR #3 at head `897cd7c50953bb419d3d0099f252db844c5589c4`. Signed-webhook run `c5a3dfeb-8e2d-48a6-ae29-ba2490fcde58` completed eight specialist reports with scores `2, 5, 4, 1, 2, 2, 2, 1`, ran sixteen independent challenges, and published summary review `5000945678`. The rendered summary showed the arithmetic mean as `Overall readiness: 2.4/5`, duration as `254.9s`, estimated cost as `$0.014415`, and three verified findings. Every inline heading visibly named its originating specialist, including New User Simulation, Performance, and Security. Chrome DOM and screenshot inspection and a separate Computer Use accessibility-tree and screenshot inspection confirmed the same rendered values. Sailbox `sb_86e12a18-933c-4a55-8134-0ebd196b1524` terminated after publication. The intentionally vulnerable fixture PR was closed without merging, and its close webhook was recorded as `unsupported_action` without starting another run.

Public PR #2 run `93c13d9a-4ab7-4735-8db0-216d9e753007` ran in Sailbox `sb_f7c93098-149c-420f-8d03-dd5fad164fcc`, completed eight reviewers and three independent challenges, published eight separate specialist comments plus summary review `5000809179`, emitted zero inline findings, cost an estimated $0.012065, and terminated the box. Chrome semantic inspection and Computer accessibility inspection both confirmed that the specialist reports render as distinct GitHub comment cards followed by the compact summary.

## TDD evidence

The first production modules were preceded by tests importing the intended domain and storage boundaries. The initial `pnpm test` run failed because `src/domain/ids.ts`, `src/domain/budget.ts`, and `src/storage/run-store.ts` did not exist. After implementation, the same suites run without mocks against the pure policies and SQLite.

The provider and orchestration modules followed the same sequence. Their initial suites failed on missing `src/adapters` and `src/application` modules. The next runs exposed an obsolete Sail request field, undersized Sailbox resources, provider identity drift, and missing cleanup details before the final green gate.

The resumable engine began with four failing SQLite contract tests because work-item claiming and report/challenge checkpoint methods did not exist. The next engine test failed because `durable-review-engine.ts` did not exist. The implemented tests now drive the public `advance` interface through restart, external-effect reconciliation, cleanup, and terminal completion.
