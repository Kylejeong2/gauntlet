# Operations

## Start and stop

Run `pnpm build` once, then start with `pnpm start`. Probot owns the HTTP server and verifies webhook signatures. SQLite is created at `DATABASE_PATH`; its parent directory is created automatically.

Stop the process with a normal termination signal. Do not delete a live SQLite database. Runtime `.db`, `.db-wal`, and `.db-shm` files are ignored by Git.

## Healthy run sequence

1. `review accepted` records the run, repository, and pull number.
2. The worker claims snapshot work, heartbeats its lease, and persists the exact GitHub snapshot.
3. Prior review markers and the selected reviewer plan are persisted, and the full worst-case cost is reserved.
4. A deterministic Sailbox intent is stored before creation; the exact head is checked out and its receipt is persisted.
5. Reviewer evidence commands run inside the box and every completed report is checkpointed with its findings and cost.
6. The Sailbox terminates after reviewer evidence; a retry reattaches an active box or creates a new attempt without repeating stored reports.
7. Candidate challenges run serially and each verdict is checkpointed.
8. A final structured synthesis call produces one headline, a 30-to-70-word overview, one top risk, and one next action.
9. Pure policy creates one publication plan with copyable fix prompts for specialist reviews below 5/5 and every verified finding.
10. GitHub adds or replaces the marked one-line summary in the PR description, then returns one review ID per specialist and one final summary review ID.
11. Cleanup reconciles any active Sailbox, settles checkpointed cost, and marks the run complete.

## Failure handling

Provider rejection, response timeout, malformed JSON, missing reports, challenge failure, budget denial, sandbox setup failure, command setup failure, off-head publication rejection, and GitHub API failure all fail closed. A phase retries at most three times with an expiring, heartbeat-backed lease. Exhaustion dead-letters the phase into cleanup and preserves the terminal reason. The authenticated webhook has already been durably accepted, so it does not remain open while inference runs. Gauntlet never publishes a partial scorecard or unchallenged finding.

`SqliteRunStore.requestCancellation` records operator intent without stealing an active lease. The engine observes it at the next checkpoint, suppresses successor work, and routes the run through cleanup before recording a cancelled terminal failure. This keeps cancellation from orphaning an active Sailbox.

Sail 429 responses are retried with delays of 15, 30, 60, 120, and 240 seconds. Server failures are not retried inside one model request because the synchronous ASAP route does not support idempotency keys. The durable phase may retry, so the currently uncheckpointed request can be repeated after a failure; completed reviewer and challenge checkpoints are never repeated. The model is never substituted.

## Duplicate deliveries and updates

`delivery_id` is unique. The tuple `(installation_id, repository_id, pull_number, head_sha)` is also unique. Replayed delivery IDs and separate deliveries for the same head are acknowledged without a second run. A new head SHA creates a new run.

A human can add `@gauntlet review` as a new pull request comment. The `issue_comment` adapter accepts that exact mention on public pull requests, ignores ordinary issue comments and bot authors, resolves the current base and head through GitHub, and sends the target through the same durable acceptance path. Mentioning Gauntlet again on an already accepted head remains a no-op.

Stable identities embedded as `<!-- gauntlet:identity -->` are read from existing review comments. The next head suppresses an equivalent finding instead of repeating it. Reviewer comments carry `<!-- gauntlet-reviewer:run-id:reviewer-id -->` markers so a retry skips specialist comments already posted.

Run markers embedded as `<!-- gauntlet-run:run-id -->` reconcile publication after a crash. Publication intent and its body digest are stored before submission; a recovered lease checks existing reviews and reuses the matching GitHub review ID. Sailbox creation uses the same pattern with a deterministic name and persisted lifecycle receipt.

## Incident checklist

For a failed run:

1. Locate the structured log by run ID.
2. Confirm whether GitHub accepted a review ID.
3. Confirm Sailbox termination in the Sail dashboard.
4. Inspect provider status and the redacted error class.
5. Run `pnpm check` locally before changing code.
6. Inspect the phase attempt and durable checkpoints before deciding whether a new head is needed; transient failures retry without discarding completed work.

Never paste credentials or raw environment dumps into an issue. Include only run IDs, response IDs, status codes, redacted messages, and the exact commit SHA.
