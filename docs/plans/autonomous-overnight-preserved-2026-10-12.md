# Autonomous overnight controller — preserved candidate design

Status: recovered candidate design, preserved on 2026-10-12. This document is for
the maintainer evaluating whether to adopt the recovered implementation. The
controller and its commands are not integrated into this checkout. Current
standing-program routing remains planning-only; consult the
[program ownership decision](../decisions/2026-09-30-temari-program-ownership.md)
and [current public admission policy](../../packages/workflow-runtime/public/policy.json).

## Outcome and ownership

The recovered candidate runs one frozen engineering goal through sequential,
independently reviewed local units. Temari owns the goal, obligations and meaning
of completion. The existing task ledger retains mechanical program state. A
host-selected reviewed-unit adapter supplies execution and recovery; a host
wakeup asks the same controller to reconcile or advance the same task. Archon
is an execution adapter, not the program owner.

The candidate prepares local work for review. It does not publish, merge or
automatically install a wake service. A scheduler can provide wakeups only after
the selected host's execution capability and task authority are established.

## Frozen inputs and dispatch

Before dispatch, retain the goal, explicit finish criteria, initial candidate,
local permissions, adapter selection, deadline and maximum units. Preserve the
existing provider/model admission boundary and protected host checks.

Persist a deterministic unit intent before external launch. A duplicate wakeup
must observe that intent instead of starting another worker. A lost launch reply
requires exact-operation reconciliation. Missing or ambiguous identity enters
recovery; lease or deadline expiry alone does not establish that a worker stopped.

Each unit has a separate linked task and evidence directory. Keep every attempt.
Accept a unit only after independent verification of its exact candidate and
evidence, then advance the base to that accepted candidate. Native success alone
cannot complete the parent goal.

## Controls and recovery

Pause, cancellation and concurrent task edits must fence late publication.
Preparation and pending dispatch recheck the original parent contract, deadline
and cancellation. Cancellation targets the retained native binding.

Failed, uncertain or rejected attempts remain retained rather than automatically
relaunched. The recovered version has no confirmed-cleanup transition for
replacing unresolved ownership with a new run. Preserve this limitation until a
new transition has its own implementation and recovery proof.

Completion reopens retained unit review proofs, observes the final candidate and
runs every frozen finish check. A later status check repeats verification with a
finite check timeout, including after the execution deadline. Generic task
acceptance and unrelated program routes retain their existing boundaries.

## Host portability

The candidate's `ReviewedUnitPort` separates the controller from host execution.
An operator-selected adapter implements exact start, inspect and cancel,
independent unit verification, candidate observation and finish checks. A second
adapter's conformance does not establish execution quality for every host.

The recovered Codex adapter reuses the managed reviewed-local-candidate operation,
separate linked unit tasks, independent reviewer and native supervision. Model
admission proves the initial configuration digest and retains a sanitized critical
projection bound to the run ledger. Critical model, reasoning, provider, profile
or catalog changes fail verification. Noncritical preference drift remains a
diagnostic. A retained account-catalog snapshot must preserve actual fetch time
and freshness checks without copying credentials into the artifact.

## Adoption and acceptance

1. Select and rebase the recovered source against current runtime, worker and
   public-entry contracts. Review overlap with ongoing work before applying it.
2. Review the proposed public-policy change independently. Having recovered an
   executable candidate does not admit its route in the current policy.
3. Verify multi-unit progress, duplicate/concurrent wakeups, interrupted launch
   and result recovery, cancellation with late results, candidate/evidence drift,
   failed checks, deadline expiry and attempt exhaustion.
4. Exercise a relocated installed artifact and a second adapter. Retain transport
   conformance separately from actual host/model execution evidence.
5. Reopen applicable execution artifacts and run a fresh supported-host journey
   before offering unattended execution. Keep substantial migrations, other
   operating systems, publication and PR queues outside a one-unit proof.

The preserved source snapshot is
`cf8807bba10f2af6448f9af1d61437a349899fae`. It contains the controller, Codex adapter,
public command changes, operator instructions, tests and a historical verification
report. The recovered report describes deterministic, relocated and one-unit live
checks. Those are historical reports, not checks rerun during preservation.
The ignored run artifacts referenced by that report were not recovered or
revalidated by this task. A Git snapshot preserves source, not those execution
artifacts or current host readiness.

Exact source copies, patches, the Git bundle and their digests remain in local
custody. See the [preservation record](../evidence/local-artifact-preservation-2026-10-12.md)
for the source and integration disposition.
