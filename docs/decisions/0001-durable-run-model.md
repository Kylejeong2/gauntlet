# Decision 0001: use a normalized durable run model

Date: 2026-08-22

Status: accepted

## Decision

Gauntlet uses normalized SQLite tables, leased work items, and explicit run states. A pure `deriveNextWork` function decides the next admissible work. An append-only `run_events` table records redacted audit facts but does not determine state.

## Context

The architecture arena compared two designs:

- Candidate B used normalized run, work, report, finding, budget, Sailbox, and publication records.
- Candidate D used an append-only event journal and rebuilt all state through a reducer.

The designs were scored against [the architecture rubric](../architecture/arena-rubric.md). Candidate B scored 36 out of 40. Candidate D scored 25 out of 40.

## Why candidate B won

Candidate B closes the external side-effect crash windows. It persists Sailbox and pending GitHub review identities, then reconciles them before retrying. It also uses microdollar reservations, reserves cleanup, and gives every external boundary a narrow typed port.

Candidate D could repeat GitHub publication if a publish call succeeded before the observation event was appended. The same gap could orphan a Sailbox. Its cent-level budget type was too coarse for low-cost inference, and its partial admission policy could leave an incomplete scorecard.

## Corrections made before implementation

Neither candidate let an individual reviewer run an experiment after forming a hypothesis. Both relied on commands executed before reviewer inference. The accepted design adds a persisted reviewer-scoped tool loop with bounded file reads, fixed-string search, named project commands, and isolated reproduction files.

Candidate B also allowed an unbounded number of findings. The accepted design caps each reviewer at three findings. Gauntlet can now reserve the worst-case number of reviewer turns and challenges before paid work begins.

## Ideas retained from candidate D

- `deriveNextWork(view, now)` remains pure and deterministic.
- Final ranking uses finding ID as the last tie-breaker.
- Reviewer-selection rationale is stored as an immutable audit fact.

## Consequences

The first release runs as one Node 22 service with SQLite. A second process can recover expired leases, but horizontal scaling across hosts is outside ProductSpec revision 1. A later PostgreSQL adapter can implement the same `RunStore` contract without changing the domain model.

