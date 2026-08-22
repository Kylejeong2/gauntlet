# Reviewer reference

Gauntlet treats reviewers as named perspectives with a narrow question, not as personas competing to produce comments. Every selected reviewer must return one readiness score, a concise rationale, examined areas, and zero to three candidate findings.

## Score meaning

| Score | Meaning                                                                                    |
| ----- | ------------------------------------------------------------------------------------------ |
| 5     | Ready from this reviewer's perspective. No material defect was found.                      |
| 4     | Low residual risk. A non-blocking concern may remain, but no verified defect blocks merge. |
| 3     | Meaningful uncertainty or a medium-impact verified defect remains.                         |
| 2     | A high-impact verified defect or substantial untested risk blocks a confident merge.       |
| 1     | A critical, reachable defect makes the change unsafe to merge.                             |

A reviewer can assign a low score without producing an inline comment when evidence is incomplete. Only findings that survive an independent challenge can become inline comments.

## Core reviewers

| Reviewer ID           | Question                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| `security`            | Can an attacker cross a trust boundary or control a sensitive operation?        |
| `performance`         | Can the change cause material latency, memory, I/O, or algorithmic growth?      |
| `api-compatibility`   | Does the change break a public caller, wire format, or persisted contract?      |
| `adversarial-testing` | Which hostile or malformed input breaks the new behavior?                       |
| `documentation`       | Do the docs match implementation and required migration steps?                  |
| `new-user-simulation` | Can a new contributor follow setup from a clean checkout?                       |
| `dependency-history`  | Does a dependency change reintroduce a known problem or violate version policy? |
| `edge-cases`          | Which boundary value, lifecycle state, platform, or ordering is missing?        |

## Optional reviewers

`test-quality` is selected when changed paths or patches look like tests. `concurrency` is selected when the snapshot contains concurrency, queue, worker, lock, atomic, parallel, or transaction concepts. The registry contains exactly ten definitions, so optional selection can never exceed the global limit.

## Finding contract

Each candidate finding contains:

- A stable finding ID and semantic identity.
- The reviewer ID.
- Exact changed path and right-side line.
- Severity and confidence.
- A short title.
- A concrete trigger.
- Evidence tied to the reviewed snapshot or sandbox output.
- A proposed action.

The challenge call receives the candidate and the same immutable snapshot. It is prompted to disprove reachability and impact. Only a single `confirmed` verdict survives. Rejected, inconclusive, failed, missing, or contradictory verdicts produce no inline comment.

## Publication ranking

Verified findings are ordered by severity, confidence, evidence specificity, and stable finding ID. Semantic identities are deduplicated, identities already posted on earlier heads are suppressed, off-diff lines are removed, and only the strongest five comments are submitted in one GitHub COMMENT review.
