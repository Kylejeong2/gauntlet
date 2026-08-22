# Security model

Gauntlet handles two hostile inputs: a GitHub webhook from the network and code supplied by a pull request. The host trusts neither.

## Trust boundaries

The host process owns GitHub App credentials, the webhook secret, the Sail API key, and the SQLite database. Pull request source never enters the host filesystem. The GitHub API supplies patches as bounded text for inference, while source checkout and execution occur only inside a new Sailbox.

Probot validates the webhook signature before invoking the application handler. The domain also provides a constant-time SHA-256 verifier for contract tests. Unsupported events, drafts, and private repositories are rejected before provider work.

## Sailbox isolation

The Sailbox receives:

- A public repository HTTPS URL.
- The immutable base and head commit SHAs.
- Explicit argument-vector commands.
- An empty environment overlay.

It does not receive a GitHub token, GitHub App private key, webhook secret, Sail key, host environment dump, host volume, Docker socket, SSH key, or private repository URL.

Lifecycle commands have explicit timeouts. Captured evidence is truncated before model use. Dependency installation disables lifecycle scripts. Project tests are still hostile code and therefore run only inside the box. Termination happens after both successful and failed review paths, and setup failure terminates a partially prepared box before returning the error.

## Model boundary

The model receives the bounded patch snapshot and bounded command evidence. Strict JSON Schema constrains output. Zod parses the response again at the domain boundary. Reviewer identity is fixed by a JSON Schema `const`, readiness must be an integer from 1 through 5, and a report can contain no more than three complete findings.

Model text cannot choose a shell command. The command broker accepts only known argument vectors. The first implementation runs a fixed evidence plan keyed by reviewer, which is a smaller attack surface than model-authored commands.

## Publication boundary

Before publication, pure policy requires:

- Exactly one report for every selected reviewer.
- Exactly one confirmed challenge for a finding.
- A path and right-side line contained in the reviewed head snapshot.
- A semantic identity not already posted on an earlier head.
- Deterministic deduplication and a five-comment maximum.

GitHub receives one COMMENT review pinned to the exact head SHA. Gauntlet never approves, requests changes, merges, pushes code, or edits a developer's branch.

## Logs and redaction

Structured logs use run, repository, pull request, review, reviewer, and challenge identifiers. They do not include raw source, raw patches, environment values, keys, cookies, authorization headers, or full command output. The reusable redactor removes sensitive keys, common inline credential forms, configured environment values, private keys, and long strings.

## Known limitations

- A worker lease lasts 30 minutes. A process crash can delay recovery until that lease expires, but it does not require a new pull request event.
- Review and challenge prompts use the same model. Separate calls and adversarial instructions reduce correlation but do not create model diversity.
- The fixed evidence plan supports pnpm, npm, and Yarn lockfiles. JavaScript repositories without one of those lockfiles receive diff evidence but no dependency installation or project-script execution.
- Local estimated cost is conservative accounting, not provider settlement.
