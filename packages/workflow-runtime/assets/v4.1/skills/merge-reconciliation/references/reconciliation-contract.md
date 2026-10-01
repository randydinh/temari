# Reconciliation contract

## Authority and boundary

This contract governs one reconciliation attempt for an existing Temari task.
It is not a second task, program, ledger, or closeout store.

| Layer | Responsibility | It must not do |
| --- | --- | --- |
| Temari | Preserve the user's intent, name the obligations, request and retain confirmation, and decide closeout meaning. | Select a conflict winner or treat harness status as completion. |
| Poteto | Choose the proportional engineering method, preservation invariants, implementation order, and verification scope. | Persist lifecycle state or grant mutation authority. |
| Runtime | Persist the task, task version, run, revision-bound events, idempotency, leases, and immutable evidence references. | Infer user confirmation or merge a candidate. |
| Host adapter | Observe Git/forge state and execute the approved operation in an isolated integration checkout. | Invent portability, credentials, approval, or merge authority. |
| Dashboard | Render a derived task view and send idempotent intent requests. | Own reconciliation state or label an integration candidate done. |

Archon or another harness is replaceable execution plumbing. Its status and a
local worker receipt are not canonical Temari completion receipts.

## Observation and evidence

Create an observation before any mutation. It must bind these values together:

| Binding | Required value |
| --- | --- |
| Task continuity | Original project scope, `taskId`, task version, `runId`, and runtime revision. |
| Candidate | Source checkout identity, approved base, candidate head, operation head when present, and integration candidate identity when one exists. |
| Snapshot | Snapshot timestamp, Git operation, porcelain state, unmerged index stages, untracked paths, path/blob or diff identities, and a canonical snapshot hash. |
| Scope | Every affected path, classified as semantic source, generated derivative, metadata, stale evidence, or human decision. |

Retain the observation, classification and reconciliation plan, confirmation
record, patch/application log, regeneration log, verification results, and final
candidate comparison as immutable canonical runtime evidence. Every reference
must carry the same `runId` and revision as the attempt. A controller-readable
summary is derived from those records. Do not make it a second authoritative
ledger.

Evidence is stale if the original project scope, task version, run, revision,
source checkout identity, base, candidate, operation head, or snapshot hash no
longer matches. Stale evidence blocks integration and closeout. Preserve it for
audit; do not overwrite or relabel it.

## Preservation and confirmation

Observation is read-only. It must not alter the source checkout or worktree.
This applies to tracked, untracked, staged, unstaged, unmerged, and generated
content alike.

Before a mutation, show the operator all of the following in one reviewable
plan:

1. The exact isolated integration checkout path and its clean pinned base.
2. The original source checkout, task binding, snapshot hash, and candidate
   identities being reconciled.
3. Each exact path to mutate, its classification, and the intended resolution.
4. For semantic conflicts, the preservation invariant and why the selected
   result satisfies it.
5. For generated derivatives, the source generator, regeneration order, and
   parity or integrity check.
6. The verification commands, expected evidence, and invalidation conditions.

Require explicit confirmation for that plan. Confirmation covers only the named
integration checkout, identities, paths, intent, and verification plan. It does
not authorize a source-checkout write, a changed candidate, an unlisted path,
force-push, merge, publish, deployment, cleanup, or deletion.

## Isolation and integration

The source checkout is an observation target. Never use it as the integration
target. A host adapter creates a clean integration checkout at the confirmed base
and records its identity before applying the approved work. If it is not clean,
or source state changes before acceptance, stop and create a fresh observation.

Resolve semantic source conflicts before derivatives. Regenerate lockfiles,
generated payloads, provenance, and inventories through their owning tooling.
Validate source-to-output parity or integrity after regeneration. Do not edit
generated hashes or inventories as a conflict-resolution shortcut.

One controller serializes shared integration state. Workers may investigate or
prepare patches only in declared disjoint scopes, with separate evidence roots.
Workers cannot write the source checkout, decide a semantic conflict, confirm a
plan, create the final integration commit, or complete the parent task.

An integration commit may be created only after the approved verification passes
against the exact integration tree and the tree has no verification-created drift.
It is a `ready for review` candidate. It never means merged, published, or done.

## Derived dashboard view

The dashboard reconstructs its view from the current task plus canonical runtime
events and evidence. Its persisted and visible state vocabulary is:

| View | Required evidence | Meaning |
| --- | --- | --- |
| `observed` | Current snapshot | No mutation has been approved. |
| `blocked` | Conflict class or stale-binding evidence | A required condition is not satisfied. |
| `awaiting-confirmation` | Plan bound to a current snapshot | The exact mutation plan needs approval. |
| `integrating` | Confirmed plan and current integration identity | Approved work is applying in isolation. |
| `verifying` | Current verification invocation | The exact candidate is being checked. |
| `ready-for-review` | Passing verification and candidate comparison | A reviewable candidate exists. |

The dashboard must key reconciliation, confirmation, and resume requests with
an idempotency key and canonical request digest. A repeated key returns the same
attempt only when its digest is equal. A changed task, candidate, path list,
plan, or confirmation digest under an existing key is rejected and retained as
audit evidence. A candidate or source identity change is an `invalidated` reason
for `blocked`; it may not show a prior candidate as done.

## Manual validation scenarios

Run the applicable scenarios against a representative harness or fixture before
claiming the workflow complete.

1. Reobserve an unchanged dirty source checkout twice. The same snapshot binding
   is retained and neither observation writes the source.
2. Supply two overlapping worker patches. The attempt becomes `blocked`; no
   patch wins automatically and the source checkout remains unchanged.
3. Change the source head, base, operation head, status, or snapshot hash after
   observation. The plan and approval become stale and no integration commit is
   created.
4. Confirm a plan and attempt an unlisted path or a source-checkout write. The
   host adapter rejects it.
5. Resolve a semantic source conflict plus a lockfile or generated payload. The
   source resolution precedes regeneration; regenerated artifacts pass their
   integrity or parity check without hand-edited hashes.
6. Make verification leave a tracked or untracked mutation in the integration
   tree. Candidate acceptance and integration commit creation fail.
7. Race cancellation against completion. The runtime records one terminal state,
   cancellation wins, and a requested completion remains auditable without a
   second terminal event.
8. Restart while `blocked` or `awaiting-confirmation`. The same task, version,
   snapshot, and gate recover; the dashboard creates no duplicate attempt.
9. Repeat a reconciliation, confirmation, or resume request with the same
   idempotency key and digest. The state converges and only one integration
   candidate is created. Reuse the key with a changed request digest and require
   rejection without changing the retained attempt.
10. Produce a passing isolated integration commit, then change the source or
    candidate before closeout. The dashboard keeps the task open and trusted
    closeout refuses to complete it against stale evidence.
