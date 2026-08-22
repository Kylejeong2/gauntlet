# Gauntlet

Gauntlet is an open-source GitHub App that reviews public pull requests through several specialist viewpoints. It uses DeepSeek V4 Flash through Sail and executes repository checks in ephemeral Sailboxes.

The product goal is strict. Every visible finding must survive a separate challenge. Maintainers get one compact review, not a stream of speculative comments.

## Current status

Gauntlet has a working local implementation against [ProductSpec revision 1](specs/gauntlet.product-spec.md). The local gate currently covers domain, SQLite, GitHub payload, Sail request, Sailbox lifecycle, orchestration, challenge, and publication policy contracts.

Live verification on 2026-08-22 created a size `s` Sailbox, executed a credential-free argument-vector command, and terminated it. Sail accepted the current DeepSeek V4 Flash request contract with `metadata.completion_window: "asap"`; one request completed with a reviewer-identity mismatch that is now prevented by provider JSON Schema, while a later request exceeded the bounded response timeout during provider capacity pressure. A completed valid inference response and the installed GitHub App flow remain explicit live gates. Gauntlet never silently switches models.

## Reviewers

Every eligible pull request receives these eight viewpoints:

- Security.
- Performance.
- API compatibility.
- Adversarial testing.
- Documentation.
- New-user simulation.
- Dependency history.
- Edge cases.

Gauntlet can add test-quality and concurrency reviewers. A run never has more than ten reviewers.

Each reviewer returns a readiness score from 1 through 5. A score of 5 means ready to merge from that viewpoint. A score of 1 means a critical problem blocks a safe merge.

## Publication contract

Gauntlet publishes one GitHub COMMENT review with:

- One score and rationale per selected reviewer.
- The areas and files examined.
- Any explicit coverage omissions.
- Estimated cost and duration.
- At most five verified inline findings.

Gauntlet does not publish positive inline comments, style preferences, duplicates, off-diff findings, or claims that failed or skipped verification.

The implemented publication reducer enforces these rules without provider or GitHub SDK types. It requires one valid report per selected reviewer, keeps only explicitly confirmed findings, validates right-side lines against the reviewed snapshot, suppresses stable identities from prior heads, deduplicates, ranks deterministically, and returns at most five inline comments.

## How a review works

1. The GitHub App verifies and durably records the webhook.
2. The handler captures the exact base, head, patch snapshot, and right-side changed lines.
3. The planner reserves the full worst-case run under $0.25.
4. Gauntlet creates one credential-free Sailbox and checks out the exact public head SHA.
5. Repository setup and standard checks run with bounded time and output.
6. Up to ten DeepSeek reviewers inspect the snapshot and bounded reviewer-specific Sailbox evidence.
7. Each reviewer returns one score and at most three candidate findings.
8. A separate DeepSeek request tries to disprove every finding.
9. Pure policy rejects unconfirmed, duplicate, stale, or unanchorable findings.
10. Gauntlet publishes one compact review and terminates the Sailbox.

Read [the architecture](docs/architecture.md) for the state model, tool limits, database tables, budget rules, and recovery behavior.

## Security boundary

Pull request code is hostile input. The GitHub App host never checks out or executes it. Sailboxes receive no GitHub key, installation token, webhook secret, Sail key, host environment, host volume, or Docker socket.

Reviewers cannot run an unrestricted shell. The first implementation uses a fixed evidence plan with pnpm installation, tests, diff checks, and dependency diffs. Every operation uses an argument vector, timeout, output limit, and cost reservation.

Private repositories are outside the first release. Gauntlet rejects them before inference or code execution.

The full threat model and operating controls will live in `docs/security.md` as the implementation lands.

## Cost limit

Every pull request has a hard estimated cost ceiling of $0.25. The ledger reserves conservative maximum cost before creating a Sailbox. It prices DeepSeek input without assuming cache discounts and reserves the configured maximum Sailbox resource use.

The app reports provider token usage and estimated Sailbox cost separately. It does not present a local estimate as settled billing.

## Repository layout

The module map is:

```text
src/
  adapters/        GitHub, Sail Responses, and Sailbox boundaries.
  application/     Review orchestration and budget admission.
  domain/          IDs, schemas, reviewers, budgets, scheduling, and publication policy.
  storage/         SQLite migrations, idempotency, leases, and reservations.
tests/             Unit, SQLite integration, provider contract, and orchestration tests.
docs/              Architecture, setup, security, operation, testing, and research.
specs/             Product intent and acceptance criteria.
```

## Documentation

- [ProductSpec revision 1](specs/gauntlet.product-spec.md) is the product contract.
- [Architecture](docs/architecture.md) explains the runtime and data model.
- [Architecture comparison rubric](docs/architecture/arena-rubric.md) records how competing designs were judged.
- [Decision 0001](docs/decisions/0001-durable-run-model.md) records the chosen durability model.
- [Prior art](docs/research/prior-art.md) traces the inspected PR-AF, PR-Agent, CodeRabbit, Sail, and Sailbox sources.
- [GitHub App setup](docs/setup.md) lists permissions, events, local webhook forwarding, and startup.
- [Configuration](docs/configuration.md) defines environment, model, Sailbox, and budget contracts.
- [Reviewer reference](docs/reviewers.md) defines every score, viewpoint, finding, challenge, and ranking rule.
- [Security model](docs/security.md) documents hostile-code isolation, credentials, validation, and limitations.
- [Operations](docs/operations.md) covers run sequence, failures, duplicates, and incident handling.
- [Testing](docs/testing.md) lists the local gates and the acceptance criteria covered by the current suites.

## Development contract

The implementation uses Node 22 or newer and TypeScript in strict mode. Tests are written before production behavior. Every external payload is parsed at its adapter boundary. The domain has no framework or SDK imports.

Install dependencies and run the complete local gate:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The individual commands are `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. `pnpm check` uses the non-mutating `format:check` variant. The current test command does not spend Sail credit or contact GitHub. Live tests remain opt-in because they spend Sail credit and write a review to the public fixture repository.

Continue with the [GitHub App setup guide](docs/setup.md) when the local gate passes.

## Prior work

Gauntlet's design draws on public source code without copying an implementation:

- [PR-AF](https://github.com/Agent-Field/pr-af) demonstrates parallel specialist review, evidence checks, adversarial challenges, cost reporting, and batched publication.
- [PR-Agent](https://github.com/The-PR-Agent/pr-agent) demonstrates hardened GitHub App delivery, merge-base diff context, stable comment identities, and extensive provider tests.
- [The preserved CodeRabbit action](https://github.com/dapperlabs/ai-pr-reviewer) demonstrates incremental reviewed-commit tracking and low-noise publication.

Pinned commits and file-level evidence are in [the prior-art report](docs/research/prior-art.md).

## License

Gauntlet is available under the MIT License.
