# Gauntlet

<p align="center">
  <img src="assets/gauntlet-app-logo-512.png" alt="Gauntlet cosmic armored fist logo" width="180" />
</p>

Gauntlet is an open-source GitHub App that reviews public pull requests through several specialist viewpoints. It uses GPT-OSS 120B through Sail and executes repository checks in ephemeral Sailboxes.

The product goal is strict. Every visible finding must survive a separate challenge. Each specialist gets a readable top-level comment, while verified code defects stay inline and speculative findings stay hidden.

## Current status

Gauntlet has a working implementation against [ProductSpec revision 1](specs/gauntlet.product-spec.md). The deterministic gate covers domain, SQLite, GitHub payload, exact-SHA snapshots, Sail requests, Sailbox lifecycle, orchestration, challenges, redacted logging, and publication policy contracts.

Live verification on 2026-08-22 completed the installed GitHub App flow on two public fixture pull requests. The command-injection run published eight separate specialist comments and one verified inline finding for $0.013657; the documentation-only control published eight specialist comments and zero inline findings for $0.012065. Both credential-free Sailboxes terminated, and replaying the first PR at the same head created no duplicate review. Gauntlet never silently switches models.

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

The implemented publication reducer enforces these rules without provider or GitHub SDK types. It requires one valid report per selected reviewer, keeps only explicitly confirmed findings, requires cross-specialist same-line corroboration except for high-confidence critical findings, validates right-side lines against the reviewed snapshot, suppresses stable identities from prior heads, collapses same-line duplicates, ranks deterministically, and returns at most five inline comments.

## How a review works

1. Probot verifies the signature, and the handler durably records the delivery decision.
2. A leased worker compares the exact base and head SHAs, then stores and reloads the merge base, patches, right-side changed lines, and coverage omissions.
3. The planner reserves the full worst-case run under $0.25.
4. Gauntlet creates one credential-free Sailbox, checks out the exact public head SHA, and scopes every diff command to the persisted merge-base SHA.
5. Repository setup and standard checks run with bounded time and output.
6. Up to ten GPT-OSS reviewers inspect the snapshot and bounded reviewer-specific Sailbox evidence.
7. Each reviewer returns one score and at most three candidate findings.
8. A separate GPT-OSS request tries to disprove every finding.
9. Pure policy rejects unconfirmed, duplicate, stale, or unanchorable findings.
10. Gauntlet publishes one top-level comment per specialist, then one compact summary review with verified inline findings, and terminates the Sailbox.

Read [the architecture](docs/architecture.md) for the state model, tool limits, database tables, budget rules, and recovery behavior.

## Security boundary

Pull request code is hostile input. The GitHub App host never checks out or executes it. Sailboxes receive no GitHub key, installation token, webhook secret, Sail key, host environment, host volume, or Docker socket.

Reviewers cannot run an unrestricted shell. The first implementation uses a fixed evidence plan with pnpm installation, tests, diff checks, and dependency diffs. Every operation uses an argument vector, timeout, output limit, and cost reservation.

Private repositories are outside the first release. Gauntlet rejects them before inference or code execution.

Read [the security model](docs/security.md) for the full threat model, credential boundary, and operating controls.

## Cost limit

Every pull request has a hard estimated cost ceiling of $0.25. The ledger reserves conservative maximum cost before creating a Sailbox. It prices GPT-OSS input without assuming cache discounts and reserves the configured maximum Sailbox resource use.

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
- [Decision 0002](docs/decisions/0002-exact-pull-request-snapshots.md) records the exact-SHA snapshot boundary.
- [Prior art](docs/research/prior-art.md) traces the inspected PR-AF, PR-Agent, CodeRabbit, Sail, and Sailbox sources.
- [GitHub App setup](docs/setup.md) lists permissions, events, local webhook forwarding, and startup.
- [Configuration](docs/configuration.md) defines environment, model, Sailbox, and budget contracts.
- [Reviewer reference](docs/reviewers.md) defines every score, viewpoint, finding, challenge, and ranking rule.
- [Security model](docs/security.md) documents hostile-code isolation, credentials, validation, and limitations.
- [Operations](docs/operations.md) covers run sequence, failures, duplicates, and incident handling.
- [Testing](docs/testing.md) lists the local gates and the acceptance criteria covered by the current suites.
- [Acceptance status](docs/acceptance-status.md) maps each ProductSpec criterion to deterministic and live evidence.

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
