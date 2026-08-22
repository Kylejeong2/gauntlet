# ProductSpec acceptance status

This reference maps [ProductSpec revision 1](../specs/gauntlet.product-spec.md) to current proof. `Local pass` means deterministic tests or a local production-server smoke prove the criterion. `Live pass` requires the installed GitHub App and a public pull request.

| Criterion | Status              | Evidence                                                                                                                                                                                                            |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1      | Local and live pass | Signed reopen events created one run per new target; a same-head replay returned `existing_target` and created no new reviews.                                                                                      |
| AC-2      | Local and live pass | Complete payload classification covers private, draft, bot-authored, unsupported, malformed, and invalid-signature paths; live close events were recorded as unsupported without starting work.                     |
| AC-3      | Local and live pass | Exact-SHA comparison persisted merge base `8ff26e1...`; live Sailbox evidence used that merge base rather than the advancing base head.                                                                             |
| AC-4      | Local and live pass | Domain tests prove the eight core reviewers, two optional reviewers, and ten-reviewer ceiling; both live runs selected the eight core reviewers.                                                                    |
| AC-5      | Local and live pass | Strict schemas validated a 1-to-5 score, rationale, examined areas, and bounded findings for every live specialist response.                                                                                        |
| AC-6      | Local and live pass | The vulnerable fixture produced a schema-valid changed-line finding with trigger, severity, confidence, evidence, action, and stable identity.                                                                      |
| AC-7      | Local and live pass | The vulnerable run challenged eleven candidates independently; the clean control challenged three and published none of them inline.                                                                                |
| AC-8      | Local and live pass | Exact-line validation, corroboration, stable identity, deduplication, and ranking reduced the vulnerable run to one inline finding and the clean run to zero.                                                       |
| AC-9      | Local and live pass | Each live run rendered eight distinct specialist comments followed by one compact summary review.                                                                                                                   |
| AC-10     | Local and live pass | The same-head replay retained the original run ID and left the bot review count unchanged.                                                                                                                          |
| AC-11     | Local and live pass | Both credential-free Sailboxes cloned the public repository, checked out the exact head, used bounded commands, and terminated after publication.                                                                   |
| AC-12     | Local and live pass | Live evidence ran lockfile-aware install, lint, test, build, typecheck, merge-base diff check, and dependency diff without shell interpolation.                                                                     |
| AC-13     | Local and live pass | SQLite reserved worst-case cost before work; settled totals were $0.013657 and $0.012065, below the $0.25 ceiling.                                                                                                  |
| AC-14     | Local and live pass | Zod validated live webhooks, model output, persisted snapshots, configuration, and publication inputs; a truncated provider response failed closed before publication.                                              |
| AC-15     | Local and live pass | Structured logs correlated run, reviewer, finding, challenge, model response, Sailbox, command, and publication IDs without exposing secrets.                                                                       |
| AC-16     | Local and live pass | The 53-test gate and installed-App E2E cover unit, SQLite integration, provider contracts, fixture evals, lifecycle cleanup, rendering, redaction, vulnerable detection, and clean suppression.                     |
| AC-17     | Local pass          | The README links the architecture, setup, configuration, reviewer, security, operations, testing, research, decisions, and acceptance references. `pnpm check` validates the documented clean-checkout command set. |

## AI evaluation status

| Evaluation | Status                      | Evidence                                                                                                                             |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| EVAL-1     | Deterministic and live pass | Public PR #1 published one challenged, corroborated command-injection finding on changed line 4.                                     |
| EVAL-2     | Deterministic and live pass | Public PR #2 published eight separate specialist scores and zero inline findings after three speculative candidates were challenged. |
| EVAL-3     | Deterministic fixture pass  | Policy tests remove duplicates and invalid locations before the five-finding ceiling.                                                |
