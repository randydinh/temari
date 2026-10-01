---
name: merge-reconciliation
description: Reconcile a Git merge, rebase, cherry-pick, or overlapping worker patch without losing work. Use when a candidate has unresolved paths, competing changes, stale candidate evidence, or an integration checkout that must be rebuilt and independently verified. Preserve the source checkout, require an explicit confirmation before mutation, and use the canonical runtime task and evidence records.
disable-model-invocation: true
---

# Merge reconciliation

This is a Temari-owned entry for a consequential recovery operation. Temari
owns user intent, the confirmation gate, and closeout meaning. Delegate the
engineering method to [Poteto mode](../poteto-mode/SKILL.md). The workflow
runtime owns durable tasks, retry control, and evidence. A host adapter gathers
Git and forge facts and creates isolated checkouts. This skill does not create a
ledger, receipt store, merge authority, or replacement task lifecycle.

Use the [reconciliation contract](references/reconciliation-contract.md). It
defines the evidence, isolation boundary, and validation scenarios.

## Trigger

Use this skill when any of these is true:

- A merge, rebase, cherry-pick, or index has unresolved paths.
- Independently produced patches overlap, do not apply, or disagree on a
  semantic change.
- The observed source checkout, base, candidate, or worker evidence becomes
  stale before integration.
- A generated artifact, lockfile, provenance record, or import inventory must
  be regenerated after a source-level reconciliation.
- A task dashboard needs to resume a blocked reconciliation without treating an
  isolated integration candidate as complete.

Do not use this skill for an ordinary clean fast-forward, a request to discard
work, or a simple code review with no candidate reconciliation.

## Preserve first

Start with an observation only. Capture the active Git operation, source and
candidate identities, index state, unmerged stages, porcelain status, untracked
paths, diff or blob identities, and the task's current run and revision. Store
the snapshot in the canonical runtime evidence store, outside the candidate
checkout.

Never resolve a conflict, choose a side, regenerate derived output, or alter the
observed checkout during this phase. Do not run `reset`, `restore`, `checkout`,
`clean`, `stash`, an operation abort, deletion, force-push, or any command that
silently selects or discards conflict content. Do not mutate the source checkout
after it was observed. A potentially destructive request remains blocked until
the exact target and intent are explicitly confirmed.

## Confirm before mutation

Present a reconciliation plan that names the exact isolated integration checkout,
the source project and task version, approved base and candidate identities,
every path to change, conflict class, intended resolution, and matching
verification commands. Record the explicit user or authorized operator
confirmation alongside that plan. A generic request to "fix the merge" is not a
confirmation.

If any bound identity, source status, snapshot hash, or task revision changes,
invalidate the plan and return to observation. Never carry approval forward to a
different candidate.

## Integrate through the owned layers

Temari sends the approved task to Poteto for a proportional feature/recovery
method. The runtime binds every event and retained artifact to the existing task,
task version, run ID, revision, and candidate identity. The host adapter performs
only the approved Git or forge operations in the isolated integration checkout.

Keep the original project task distinct from that checkout. A dashboard may show
derived state such as `observed`, `blocked`, `awaiting-confirmation`,
`integrating`, `verifying`, or `ready-for-review`; it must read canonical task
and evidence records and must not become another lifecycle store. An integration
commit is reviewable evidence, not a merge, publish, or task-completion receipt.

Only resolve source files first. Treat lockfiles, generated payloads, provenance,
import inventories, and hashes as derived artifacts. Regenerate them in the
isolated checkout, then verify their relationship to the accepted source. Do not
hand-edit a derived hash or claim byte parity without checking it.

For parallel work, give each worker a disjoint typed scope and evidence directory.
One controller owns the integration checkout, state transition, approval record,
and final candidate comparison. A worker result is evidence, not authority to
choose a conflict or close the task.

Bind each observation, confirmation, and integration request to an idempotency
key and a canonical request digest. A repeated key with the same digest returns
the existing attempt. A repeated key with a different task, candidate, path,
plan, or confirmation digest is rejected and preserved as audit evidence.

## Finish condition

Keep the task open until the canonical runtime records candidate-bound
verification for the current integration candidate and Temari's trusted closeout
path accepts it. If the source or candidate moves, the task remains open and the
dashboard must show the stale-evidence block rather than a completed result.
