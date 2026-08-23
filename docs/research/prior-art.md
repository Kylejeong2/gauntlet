# Prior art for Gauntlet

This report records the source code inspected before Gauntlet's architecture was chosen. The references are pinned to commits so future maintainers can reproduce the comparison.

## PR-AF

[Agent-Field/pr-af at `48ae7ee`](https://github.com/Agent-Field/pr-af/tree/48ae7eeb4f07779004db6354728d49ca7b36dbc3) is the closest public implementation to Gauntlet's intended review graph. Its maintained Go package runs several review dimensions, verifies evidence, challenges findings, checks coverage, validates comment locations, and publishes one GitHub review. Its install manifest defaults to `deepseek/deepseek-v4-flash-0731`.

The relevant code is concentrated in these files:

- [`go/internal/orch/phases.go`](https://github.com/Agent-Field/pr-af/blob/48ae7eeb4f07779004db6354728d49ca7b36dbc3/go/internal/orch/phases.go) owns parallel review, evidence verification, adversarial challenges, coverage, and consistency.
- [`go/internal/orch/output.go`](https://github.com/Agent-Field/pr-af/blob/48ae7eeb4f07779004db6354728d49ca7b36dbc3/go/internal/orch/output.go) filters severity, validates diff locations, caps comments, and publishes one review.
- [`go/internal/node/webhook.go`](https://github.com/Agent-Field/pr-af/blob/48ae7eeb4f07779004db6354728d49ca7b36dbc3/go/internal/node/webhook.go) verifies GitHub signatures and dispatches label-triggered reviews.
- [`go/internal/github/client.go`](https://github.com/Agent-Field/pr-af/blob/48ae7eeb4f07779004db6354728d49ca7b36dbc3/go/internal/github/client.go) creates installation tokens, paginates pull request data, and publishes reviews.

Gauntlet keeps the review graph but changes the operating contract. It caps reviewers at ten, caps inline findings at five, triggers automatically on pull request updates, runs code in Sailboxes, publishes 1-to-5 specialist scores, and refuses to schedule work above $0.25.

## PR-Agent

[The-PR-Agent/pr-agent at `4ebd5c5`](https://github.com/The-PR-Agent/pr-agent/tree/4ebd5c5333c6ef21509e7304d27969eb825e6f22) has the strongest public GitHub delivery implementation in this comparison.

The relevant code is concentrated in these files:

- [`pr_agent/servers/github_app.py`](https://github.com/The-PR-Agent/pr-agent/blob/4ebd5c5333c6ef21509e7304d27969eb825e6f22/pr_agent/servers/github_app.py) verifies webhooks, filters pull requests, and coalesces synchronize events.
- [`pr_agent/git_providers/github_provider.py`](https://github.com/The-PR-Agent/pr-agent/blob/4ebd5c5333c6ef21509e7304d27969eb825e6f22/pr_agent/git_providers/github_provider.py) computes merge-base-aware file context, fingerprints comments, validates line ranges, batches reviews, and handles invalid-location failures.
- [`pr_agent/algo/pr_processing.py`](https://github.com/The-PR-Agent/pr-agent/blob/4ebd5c5333c6ef21509e7304d27969eb825e6f22/pr_agent/algo/pr_processing.py) packs diffs into token budgets and records omitted files.
- [`pr_agent/algo/run_details.py`](https://github.com/The-PR-Agent/pr-agent/blob/4ebd5c5333c6ef21509e7304d27969eb825e6f22/pr_agent/algo/run_details.py) records model, token, call-count, and duration data per run.

PR-Agent's open and reopen flow, merge-base diff, request correlation, stable comment markers, and 422 recovery inform Gauntlet. Its in-process background tasks and process-local synchronize coalescing do not meet Gauntlet's durability requirement. Its optional self-reflection also treats verification as a quality filter rather than a required independent challenge.

The inspected commit contains 115 Python test files. The suites cover webhook routing, signature validation, inline location checks, suggestion filtering, deduplication, provider behavior, and a live GitHub App flow.

## Original CodeRabbit action

The original `coderabbitai/ai-pr-reviewer` repository is unavailable. [Dapper Labs' preserved fork at `44244a9`](https://github.com/dapperlabs/ai-pr-reviewer/tree/44244a9e06f5acf72a93f661c7dbb8d8d808143d) retains the last public TypeScript action.

Useful patterns include these:

- [`src/review.ts`](https://github.com/dapperlabs/ai-pr-reviewer/blob/44244a9e06f5acf72a93f661c7dbb8d8d808143d/src/review.ts) tracks the highest reviewed commit in hidden HTML, reviews only new work, filters paths, triages files with a cheap model, and omits positive inline comments.
- [`src/commenter.ts`](https://github.com/dapperlabs/ai-pr-reviewer/blob/44244a9e06f5acf72a93f661c7dbb8d8d808143d/src/commenter.ts) batches one pending review and falls back to individual comments when GitHub rejects the batch.
- [`src/bot.ts`](https://github.com/dapperlabs/ai-pr-reviewer/blob/44244a9e06f5acf72a93f661c7dbb8d8d808143d/src/bot.ts) isolates the OpenAI-compatible model client and records request timing.

Gauntlet keeps incremental review identities, cheap triage, and one batched review. It does not inherit the action's weak test coverage, unstructured responses, missing verifier, or missing cost gate.

## Sail contracts

The implementation targets the current official contracts:

- [Sail's Responses API](https://docs.sailresearch.com/quickstart) is OpenAI-compatible and supports background polling.
- [The support matrix](https://docs.sailresearch.com/support) documents structured JSON output, client-side function tools, idempotency, and completion windows.
- [The TypeScript Sailbox SDK](https://docs.sailresearch.com/reference/typescript-sdk) runs on Node 22 or newer.
- [The Sailbox API](https://docs.sailresearch.com/sailbox-sdk) provides create, command execution, file transfer, lifecycle, and guaranteed termination operations.
- [Sailbox pricing](https://docs.sailresearch.com/sailboxes-pricing) charges by observed CPU, memory, and disk use, plus a one-time creation fee.

The live account listed `deepseek/deepseek-v4-flash-0731` on 2026-08-22. An early synchronous inference completed, but the model later returned sustained 429 capacity responses. Its ASAP-only route also rejected background mode and idempotency keys. Because the product brief allowed DeepSeek or another cheap Sail model, Gauntlet explicitly changed its fixed model to `openai/gpt-oss-120b`; it did not perform a silent runtime fallback. On 2026-08-23, Sail's authenticated model list and official pricing page again exposed DeepSeek V4 Flash, so Gauntlet deliberately restored `deepseek/deepseek-v4-flash-0731` as its fixed model and reverified the provider contract.

## Decisions carried into Gauntlet

Gauntlet uses these rules:

1. A pull request head SHA identifies an immutable review target.
2. Webhook delivery, review scheduling, and GitHub publication are idempotent.
3. Reviewers publish independent facts into per-reviewer state. A single reducer owns the final publication decision.
4. Every finding has a stable identity, a changed-line location, a trigger, evidence, and a separate challenge verdict.
5. Failed or inconclusive verification rejects a finding.
6. One ephemeral Sailbox holds the exact public pull request checkout. No application credential enters the Sailbox.
7. One budget ledger reserves cost before work starts and records provider usage after completion.
8. One GitHub review contains the scorecard and at most five inline comments.
9. Logs record identifiers, state changes, costs, and redacted errors. Logs do not record credentials or full source text.
10. Tests must cover both the review engine and the framework adapters.
