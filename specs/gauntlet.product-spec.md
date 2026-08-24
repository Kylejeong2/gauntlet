---
spec_format_version: "0.1"
title: "Gauntlet public pull request reviewer"
artifact_type: "prd"
spec_revision: 2
author: "Kyle Jeong"
created_at: "2026-08-22T08:29:19Z"
updated_at: "2026-08-24T03:54:26Z"
linked_github_repo: "Kylejeong2/gauntlet"
applies_to:
  - component: "github-app"
  - component: "review-engine"
  - component: "sail-inference"
  - component: "sailbox-execution"
---

## Problem

Open-source maintainers need serious pull request review, but one general reviewer misses specialist risks and a large group of uncoordinated reviewers floods the pull request with guesses. Existing automated reviewers often publish a claim before another reviewer has tried to disprove it. Maintainers then spend attention separating real defects from plausible prose.

## Hypothesis

If Gauntlet gives each public pull request to a small group of specialist reviewers, lets those reviewers execute the code in an isolated Sailbox, and independently challenges every proposed finding before publication, maintainers will act on a larger share of comments while receiving fewer comments per pull request.

## Product Summary

Gauntlet is an open-source GitHub App for public repositories. It reviews pull requests with up to ten named specialist viewpoints using DeepSeek V4 Flash through Sail. Reviewers can inspect and execute the exact pull request head inside one ephemeral Sailbox. Every reviewer returns a merge-readiness score from 1 to 5 and zero or more structured findings. A separate model call tries to disprove each finding. Gauntlet publishes each specialist separately, a compact final review with no more than five verified inline comments, and one marked summary line in the PR description. The entire run, including inference and Sailbox execution, has a hard estimated cost ceiling of $0.25.

## Scope

```productspec-scope
in:
  - Run as a GitHub App on opened, reopened, ready-for-review, and synchronized pull requests in public repositories.
  - Support TypeScript and JavaScript repositories first, with Python as the next language-specific review target.
  - Provide security, performance, API compatibility, adversarial testing, documentation, new-user simulation, dependency history, and edge-case reviewers.
  - Allow up to two additional reviewers for test quality, concurrency, or another diff-specific concern, while keeping the total at ten or fewer.
  - Let every selected reviewer return a merge-readiness score from 1 to 5 and zero or more candidate findings.
  - Run repository inspection and commands in an ephemeral Sailbox without forwarding GitHub, Sail, or host credentials.
  - Challenge every candidate finding with a separate DeepSeek V4 Flash request before publication.
  - Publish one GitHub review with a scorecard and no more than five verified inline comments.
  - Keep an estimated total cost ledger with a hard $0.25 ceiling for inference and Sailbox execution.
  - Emit structured, redacted logs for every run, reviewer, model request, sandbox command, verification decision, and GitHub publication.
  - Provide extensive unit, integration, contract, fixture-eval, and live end-to-end tests.
out:
  - Review private repositories or retain private source code.
  - Support languages other than TypeScript, JavaScript, and Python with language-specific analysis in the first release.
  - Use models other than DeepSeek V4 Flash in the first release.
  - Approve, request changes, merge, close, or otherwise change the pull request beyond posting a COMMENT review.
  - Run pull request code on the GitHub App host.
cut:
  - Create one visible GitHub comment per reviewer.
  - Publish speculative, unverifiable, positive, style-only, or duplicate inline comments.
  - Create a literal organization of hundreds or thousands of agents.
```

## Acceptance Criteria

```productspec-acceptance-criteria
- id: AC-1
  criterion: A signed GitHub pull_request webhook for an opened, reopened, ready_for_review, or synchronize action creates exactly one durable review run for the repository, pull request number, and head SHA, and a repeated delivery does not create another run.
- id: AC-2
  criterion: A webhook for a private repository, draft pull request, unsupported action, invalid signature, or bot-authored pull request does not start code execution or inference and records a redacted reason.
- id: AC-3
  criterion: Every run uses an immutable pull request snapshot that includes the installation, repository, pull request number, base SHA, head SHA, merge-base SHA, changed files, changed line ranges, and explicit coverage omissions.
- id: AC-4
  criterion: The reviewer registry contains the eight named core viewpoints and no run schedules more than ten reviewers.
- id: AC-5
  criterion: Every selected reviewer returns exactly one integer readiness score from 1 through 5, a concise rationale, examined areas, and zero or more schema-valid candidate findings.
- id: AC-6
  criterion: Every candidate finding identifies a changed file and line, a concrete failure trigger, severity, confidence, evidence, and a proposed developer action.
- id: AC-7
  criterion: Every candidate finding receives a separate challenge request that returns confirmed or rejected with a reason, and missing, failed, or inconclusive challenges reject the finding.
- id: AC-8
  criterion: Gauntlet semantically deduplicates confirmed findings, validates every location against the exact reviewed head diff, and publishes no more than five inline comments.
- id: AC-9
  criterion: Gauntlet publishes one COMMENT review per selected specialist, a compact final COMMENT review containing the overall score, top risk, next action, coverage, cost, duration, and verified findings, and one idempotent summary line in the PR description while preserving author-written content.
- id: AC-10
  criterion: A synchronize webhook reviews only the new head SHA, reconciles earlier Gauntlet findings through stable hidden identities, and does not repeat an unchanged finding.
- id: AC-11
  criterion: Repository commands run only in a newly created Sailbox with no application credentials, bounded time, bounded output, and guaranteed termination after success or failure.
- id: AC-12
  criterion: TypeScript and JavaScript repositories receive dependency-aware install, test, lint, typecheck, and documentation commands when the repository exposes them, and unsupported commands fail closed without shell interpolation.
- id: AC-13
  criterion: The run reserves estimated cost before each model request or Sailbox operation, never schedules work that can exceed $0.25, and reports actual token usage plus estimated Sailbox cost without claiming provider billing is exact.
- id: AC-14
  criterion: All external payloads, model outputs, configuration, and persisted run records are validated at their boundaries before entering the typed review engine.
- id: AC-15
  criterion: Structured logs correlate delivery, run, reviewer, finding, challenge, Sailbox, command, and publication identifiers while excluding credentials, raw environment values, and full source text.
- id: AC-16
  criterion: Unit, integration, contract, fixture-eval, and live smoke tests cover webhook signatures, event routing, idempotency, budget exhaustion, reviewer limits, model parsing, challenge failure, sandbox cleanup, line validation, deduplication, GitHub review rendering, and redaction.
- id: AC-17
  criterion: The repository includes a detailed README, architecture explanation, GitHub App setup guide, Sail and Sailbox configuration guide, security model, reviewer reference, operating guide, and test guide whose commands pass from a clean checkout.
```

```productspec-ai-evals
- id: EVAL-1
  type: human_review
  cases:
    - input: "A TypeScript pull request adds an unauthenticated command endpoint that passes user input to a shell."
      expected: "The security or adversarial reviewer identifies the reachable command injection, and the finding survives challenge with a changed-line location and reproduction evidence."
    - input: "A TypeScript pull request removes an exported field without a compatibility path."
      expected: "The API compatibility reviewer identifies the breaking change, and the finding survives challenge with a consumer failure scenario."
  evaluator: human
  pass_threshold: 1
  checks:
    - The expected defect is present in the final verified findings.
    - The finding has a valid changed-line location.
    - The finding includes executable or source evidence.
- id: EVAL-2
  type: human_review
  cases:
    - input: "A TypeScript pull request changes only a correctly spelled documentation sentence."
      expected: "Gauntlet publishes no inline finding and still reports the applicable reviewer scorecard."
    - input: "A candidate finding claims a null dereference, but the surrounding changed code proves the value is narrowed before use."
      expected: "The challenge rejects the finding, and no developer-visible comment contains it."
  evaluator: human
  pass_threshold: 1
  checks:
    - Speculative findings remain internal.
    - Positive observations do not become inline comments.
    - The final review stays concise.
- id: EVAL-3
  type: human_review
  cases:
    - input: "A pull request contains six distinct model-proposed findings, including duplicates and findings outside changed lines."
      expected: "Gauntlet removes duplicates and invalid locations, then publishes at most five confirmed findings."
  evaluator: human
  pass_threshold: 1
  checks:
    - Every published finding has a confirmed challenge.
    - Every published finding points to the exact reviewed head diff.
    - The publication limit is enforced after deduplication and ranking.
```

## Success Metrics

```productspec-success-metrics
- id: SM-1
  metric: maintainer_accepted_finding_rate
  target: tbd
  target_status: provisional
  target_owner: Gauntlet maintainer
  window: first 100 published findings
- id: SM-2
  metric: maintainer_dismissed_as_incorrect_rate
  target: tbd
  target_status: provisional
  target_owner: Gauntlet maintainer
  window: first 100 published findings
- id: SM-3
  metric: median_inline_comments_per_review
  target: "<= 3"
  target_status: committed
  window: first 100 reviewed pull requests
- id: SM-4
  metric: reviews_with_estimated_cost_at_or_below_budget
  target: "= 100%"
  target_status: committed
  window: first 100 reviewed pull requests
- id: SM-5
  metric: sailbox_cleanup_success_rate
  target: "= 100%"
  target_status: committed
  window: first 100 Sailbox-backed reviews
```

## Risks

- The same model generates and challenges findings, so prompts and context isolation must reduce correlated errors until a second model is introduced.
- Public pull request code is hostile input. The Sailbox must receive no application credentials, and command output must be bounded and redacted before model use.
- A provider can omit or revise billing metadata. The hard gate therefore uses conservative local estimates and reports provider usage separately.
- GitHub can reject stale or invalid inline locations. Gauntlet must bind publication to the reviewed head SHA and suppress comments that cannot be anchored.
- A quiet reviewer can miss real defects. Coverage records and per-reviewer scores must remain visible even when no finding is published.

## Related Artifacts

```productspec-related-artifacts
- type: code
  url: "https://github.com/Agent-Field/pr-af/tree/48ae7eeb4f07779004db6354728d49ca7b36dbc3"
  title: "PR-AF multi-reviewer and adversarial review reference"
  section_id: acceptance_criteria
  item_id: AC-7
- type: code
  url: "https://github.com/The-PR-Agent/pr-agent/tree/4ebd5c5333c6ef21509e7304d27969eb825e6f22"
  title: "PR-Agent GitHub delivery and test reference"
  section_id: acceptance_criteria
  item_id: AC-16
- type: other
  url: "https://docs.sailresearch.com/"
  title: "Sail inference and Sailbox documentation"
  section_id: acceptance_criteria
  item_id: AC-11
- type: code
  url: "https://github.com/Kylejeong2/gauntlet"
  title: "Gauntlet source repository"
```
