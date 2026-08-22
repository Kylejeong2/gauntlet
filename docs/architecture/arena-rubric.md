# Architecture comparison rubric

Gauntlet compared two independent architecture sketches before implementation. Each candidate received the ProductSpec and prior-art report, but not this scoring rubric.

Each criterion is scored from 1 to 5.

## Product contract coverage

The design must trace every acceptance criterion in ProductSpec revision 1 to an owning module, a state transition, or a test boundary. A high score requires explicit handling for the reviewer limit, independent challenge, exact-head location checks, the five-comment limit, the $0.25 limit, detailed logs, and required documentation.

## Crash safety and idempotency

The webhook must acknowledge before long work begins. Duplicate delivery, process restart, expired worker lease, orphaned Sailbox, and repeated GitHub publication must converge on one marked comment per reviewer and one summary for one head SHA. A high score encodes these properties in storage keys and state transitions instead of relying on process memory.

## Hostile-code containment

The design must keep GitHub and Sail credentials outside reviewed code, bound time and output, terminate every Sailbox, and separate command execution from inference. A high score makes unsafe execution difficult to represent and exposes only narrow tools to reviewers.

## Budget correctness

One ledger must reserve conservative cost before every paid operation, reconcile actual token usage, and reject work that could cross $0.25. A high score avoids distributed counters and distinguishes estimated Sailbox cost from settled provider billing.

## Interface depth and testability

The public application API should be small while hiding orchestration, provider, and persistence rules. Pure policy functions must be testable without GitHub, Sail, or a database. Framework payloads and SDK objects must not enter the domain model.

## Maintainer load

The system should run as one understandable Node 22 service for the first open-source release. A high score uses few packages, short call chains, one authoritative configuration, direct SQL migrations, and clear ownership. It must leave room for another database or model without adding unused abstractions now.

## Developer experience

The final GitHub output must show each selected reviewer score and examined areas in a separate comment, then coverage, cost, and no more than five verified findings in a compact summary review. A high score makes quiet publication a deterministic policy, not a prompt suggestion.

## Verification plan

The design must name failing-first tests for each risky boundary and a live path through GitHub, the selected cheap Sail model, and Sailboxes. A high score treats live verification as a separate gate from unit and integration tests.
