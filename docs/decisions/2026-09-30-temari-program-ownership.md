# Decision: Temari owns programs; Archon executes admitted runs

**Status:** Accepted. Semantic routing and fail-closed admission are implemented.
Program execution and legacy-store retirement remain gated.

## Context

The imported Poteto Orchestrate playbook combines program judgment, worker
briefs, PR-frontier control, verification records, and a plain-file `orch`
store. Temari already has one semantic coordinator, a six-stage workflow,
revision-bound receipts, a durable child-task store, and a replaceable
`ExecutionHarness` port. Archon implements native start, status, and
exact-run resume behind that port. A source-workspace, model-free conformance
journey writes a canonical receipt, while installed and live-model parity remain
unproven.

Starting a new `orch` store alongside `.temari/runs/` would create two
authorities for unit state, gates, and completion.

## Decision

1. Temari classifies standing programs and owns the goal, standing orders,
   human gates, evidence obligations, and completion decision.
2. Poteto selects the engineering method for each bounded unit. Its Orchestrate,
   Autopilot, Autonomous run, and Multi-phase files remain available as
   technical references. The Orchestrate file and `orch` CLI may resume an
   already-recorded legacy program; they are not the entry for a new Temari
   program.
3. The typed Temari route uses an explicit `programKind`. It is
   `planning-only`. The current serial `executeRequestPlanAndPersist`
   rejects it before invoking a stage or persisting a receipt.
4. The runtime owns mechanical persistence, claims, leases, retries, and
   evidence binding. A selected execution harness may run work, but neither
   a harness status nor a worker summary authorizes closeout. Archon remains
   replaceable and non-authoritative for semantic decisions.
5. Temari selects pause, pickup, and closeout across tasks. The existing
   Poteto playbooks remain reusable mechanics during migration.

The explicit program kinds are autonomous run, Orchestrate, Autopilot full,
Autopilot stack, and multi-phase plan. A large `workType` alone does not
infer a program. A program intent cannot also claim QA responsibility or
start as a bounded QA subtask.

## Current behavior

A new program is classified as Temari-owned and reports its missing execution
capability. It does not run through the ordinary serial workflow and does not
produce a false six-stage completion receipt. An existing legacy Orchestrate
program can still use its recorded store and playbook. This is a temporary
compatibility path, not a second canonical store for new work.

The current public `policy.json` admits lightweight and full-feature engineering
and QA, but has no program execution entry. The typed program route therefore
does not expand installed public admission. The imported runtime package retains
the legacy files and the verifier that exercises their bookkeeping. Each changed
vendored file has an updated artifact hash and an explicit transformation
explanation in `provenance.json`.

## User-facing priority

Verification is the first product priority. A dependable contract for unattended
agent work is second. Temari should suggest it when the user will be away or
wants one substantial task driven to a checkable finish condition. The contract
needs a goal, isolated checkout and base, authorized actions, verification, a
decision trail, bounded time or retries, a dead-end stop, and a morning report.
A duration alone is not a finish condition. The
[upstream overnight guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/07-overnight.md)
routes a substantive overnight task through Figure-It-Out for reviewable
phases, then Autonomous Run to the finish condition.
Independent PR queues and multi-day programs select their own heavier methods;
being asleep by itself does not select Orchestrate.

This priority does not itself admit a new program execution route. The current
public route can draft the contract, then must check the selected host and
policy before promising unattended work. A proven host-specific route can be
offered with its own state and completion evidence labeled explicitly. If none
is available, Temari reports the execution gap and keeps the contract ready for
admission rather than claiming the agents will continue overnight.

## Promotion gates

Remove the planning-only guard only after an end-to-end program journey proves:

- One canonical Temari run records every unit, dependency, gate, owner, active
  revision, and current-head verification verdict.
- The selected host or harness resumes the **same** run after interruption.
  Partial writes, duplicate dispatch, stale workers, and delayed results
  reconcile without changing the accepted outcome.
- A PR-head change invalidates its prior verdict, and only a contiguous
  independently verified stack can be marked ready to land.
- Archon node outcomes, if Archon is selected, map to the same six-stage,
  revision-bound Temari receipt semantics as the authoritative serial path.
  Status and native run identity alone are insufficient.
- Pause, pickup, cancellation, and closeout read the same state and preserve
  evidence provenance across process restart.
- A legacy `orch` program has a documented finish-or-migrate procedure.
  A migration proves each old unit and ledger entry has a canonical counterpart
  before the old store is retired.

Only then remove the `orch` route, CLI, store, and their packaging/verifier
requirements in one reviewed change. Do not leave two writable program stores
behind a compatibility switch.

## Other ownership decisions

Babysit and Shipping keep their quality rules in Poteto; forge polling and
queue state belong behind host/runtime adapters. `make-bot-ui`, model setup,
personal-mode creation, and tone helpers remain optional, explicit skills.
`no-comments` and `deslop` overlap, but the former includes a focused review
workflow; consolidate them only after a behavior eval shows the retained route
catches its meaningful findings. Third-party MCP plugins and Ralph Loop remain
separate integrations. Benny remains an opt-in automation pack.
