# Decision 0002: persist exact pull request snapshots before review

Date: 2026-08-22

Status: accepted

## Decision

Gauntlet captures each source snapshot through GitHub's exact commit-comparison endpoint. The request uses the accepted base and head SHAs. The snapshot stores the merge-base SHA, ordered changed files, right-side changed lines, patches, and coverage omissions in one SQLite transaction.

The worker reloads the snapshot before it creates a Sailbox or calls a model. A transient GitHub response cannot enter the review engine.

The webhook handler classifies every signed `pull_request` delivery. Rejected deliveries store one enum reason without source data or validation details. Invalid signatures remain outside the application handler and receive Probot's redacted 400 response.

## Why this shape won

The architecture arena compared two designs. Candidate A kept the existing Probot, `SqliteRunStore`, leased worker, and `runReview` boundaries. Candidate B placed intake, authentication, snapshot capture, persistence, comment history, and publication behind one GitHub facade.

Candidate A scored 24 out of 25. Candidate B scored 22 out of 25. Both designs handled exact SHAs, merge-base capture, crash recovery, and eligibility. Candidate A required fewer new interfaces and fit the current live-test path.

The final design adds these parts from Candidate B:

- A persisted snapshot type that only `SqliteRunStore` can return.
- Pure rendering and changed-line projections from normalized files.
- Ordered file records with explicit reviewable and omitted states.
- Mutable prior-comment identities outside the immutable source snapshot.
- A typed omission when GitHub reaches its 300-file comparison limit.

## Rejected alternatives

- `pulls.listFiles` cannot bind every page to the accepted base and head SHAs.
- A host checkout violates the rule that pull request code stays off the GitHub App host.
- A Sailbox-owned snapshot makes paid infrastructure and cleanup prerequisites for durable source facts.
- An all-purpose GitHub facade hides unrelated invariants behind one large class and increases the live E2E change surface.
- Event-sourced page capture adds partial states when one SQLite transaction can store the complete aggregate.

## Consequences

GitHub returns at most 300 changed files for a comparison. Gauntlet records that limit as a coverage omission and never implies that the snapshot covers additional files.

An equal snapshot retry returns the stored aggregate. A conflicting retry fails closed. A crash before the transaction leaves no snapshot. A crash after the transaction reuses the stored snapshot without another source fetch.

Prior Gauntlet comment identities remain mutable publication history. The worker reads them after it reloads the source snapshot.
