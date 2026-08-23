# Operations

## Start and stop

Run `pnpm build` once, then start with `pnpm start`. Probot owns the HTTP server and verifies webhook signatures. SQLite is created at `DATABASE_PATH`; its parent directory is created automatically.

Stop the process with a normal termination signal. Do not delete a live SQLite database. Runtime `.db`, `.db-wal`, and `.db-shm` files are ignored by Git.

## Healthy run sequence

1. `review accepted` records the run, repository, and pull number.
2. GitHub files and prior review markers are fetched with bounded pagination.
3. The full worst-case plan is reserved.
4. One Sailbox is created and the exact head is checked out.
5. Reviewer evidence commands run inside the box.
6. Reviewer calls run serially.
7. Candidate challenges run serially.
8. A final structured synthesis call turns the reports and challenge outcomes into a PR-level briefing.
9. Pure policy creates one publication plan with copyable fix prompts.
10. GitHub returns one review ID per specialist and one final summary review ID.
11. The Sailbox terminates and `review completed` records counts and estimated total microdollars.

## Failure handling

Provider rejection, response timeout, malformed JSON, missing reports, challenge failure, budget denial, sandbox setup failure, command setup failure, off-head publication rejection, and GitHub API failure all fail closed. The worker logs an identifier-scoped error and records a failed terminal state. The authenticated webhook has already been durably accepted, so it does not remain open while inference runs. Gauntlet never publishes a partial scorecard or unchallenged finding.

Sail 429 responses are retried with delays of 15, 30, and 60 seconds. Server failures are not retried because the synchronous ASAP route does not support idempotency keys, so an ambiguous retry could spend twice. The model is never substituted.

## Duplicate deliveries and updates

`delivery_id` is unique. The tuple `(installation_id, repository_id, pull_number, head_sha)` is also unique. Replayed delivery IDs and separate deliveries for the same head are acknowledged without a second run. A new head SHA creates a new run.

A human can add `@gauntlet review` as a new pull request comment. The `issue_comment` adapter accepts that exact mention on public pull requests, ignores ordinary issue comments and bot authors, resolves the current base and head through GitHub, and sends the target through the same durable acceptance path. Mentioning Gauntlet again on an already accepted head remains a no-op.

Stable identities embedded as `<!-- gauntlet:identity -->` are read from existing review comments. The next head suppresses an equivalent finding instead of repeating it. Reviewer comments carry `<!-- gauntlet-reviewer:run-id:reviewer-id -->` markers so a retry skips specialist comments already posted.

Run markers embedded as `<!-- gauntlet-run:run-id -->` reconcile publication after a crash. A recovered lease checks existing reviews before submission and reuses the matching GitHub review ID.

## Incident checklist

For a failed run:

1. Locate the structured log by run ID.
2. Confirm whether GitHub accepted a review ID.
3. Confirm Sailbox termination in the Sail dashboard.
4. Inspect provider status and the redacted error class.
5. Run `pnpm check` locally before changing code.
6. Update the pull request to create a new head after the cause is fixed.

Never paste credentials or raw environment dumps into an issue. Include only run IDs, response IDs, status codes, redacted messages, and the exact commit SHA.
