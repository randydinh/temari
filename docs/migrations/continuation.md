# Temari migration continuation

This record is for the maintainer who resumes the migration. Read the current
Git state and pull requests before acting. A checked implementation item does
not replace acceptance evidence from the installed product.

## Outcome and authority

Finish migration acceptance and isolated installation of `temari`,
`poteto-mode`, and `closeout` before completing distributed parallelism.
The user authorized continued implementation and commit, push, and merge at
verified milestones while away. Deployments, paid infrastructure, credential
changes, replacement of the installed plugin, and destructive cleanup are
not authorized by this continuation.

Keep the pre-existing `libs/privacy/`, `pnpm-lock.yaml`, and `tsconfig.json`
changes in the main checkout separate. They were present before this run.

## Baseline and current unit

The starting trunk is `2a2b8c942e8883c0cc24014781b9ed1aafb7c2b3`, merged PR #47.
The canonical contracts, coordinator, workflow engine, and runtime passed
their eight Nx typecheck and test tasks from an isolated checkout before
this increment.

The current unit adds process-restart migration acceptance tests against the
existing request-plan API and persisted runtime. Its boundary is a sanitized
filesystem fixture. It does not prove an installed agent host, independent
reviewer execution, or cross-machine coordination.

Local acceptance and all eight core typecheck/test tasks pass. Independent
review and CI are still required before this unit merges. The branch is
`codex/migration-acceptance-20260925`. Find its PR and current head before
resuming; do not infer merge status from this paragraph.

Data follows the existing types. `TemariPlanRequest` becomes a
`TemariRequestPlan`, then persisted `WorkflowCheckpoint` and `WorkflowReceipt`
records. Evidence bytes must verify before interpreting a `CloseoutDecision`.
The pure `deriveCloseout` function validates identities and procedure. It
does not load artifacts or prove the product result.

## Work sequence and acceptance

1. Add a reproducible request-to-artifact journey with fresh-process recovery.
   Assert literal product output, durable stage reuse, missing-capability
   refusal, altered-workspace refusal, revision mismatch, and evidence
   integrity. Review independently and run the affected Nx checks and CI.
2. Complete an isolated public-entry installation that invokes the canonical
   engine without reading a legacy checkout. Verify the engineering and QA
   paths on the actual host. Keep optional private overlays absent by default.
3. Implement one distributed workflow with shared durable control records,
   shared evidence, and independent worker dispatch. Reuse the existing
   contracts. Record backend decisions before expanding dependencies.
4. Prove actual process and machine interruption, duplicate delivery,
   cancellation, stale-owner rejection, and concurrency bounds. Test rollback
   before cutover. Automatic failover remains last.

The first two steps complete only when the public entry works from a clean
installation with retained evidence. Local callbacks and copied skill assets
do not satisfy that predicate. Report local, process, host, and multi-machine
evidence separately.

## Resume safely

1. Inspect `git status`, `git worktree list`, current trunk, and open PRs in
   `randydinh/temari`. Resume an existing unit before starting another.
2. Keep a single writer for each branch. Preserve unrelated changes. Do not
   restart workers while their owner is active.
3. Run the narrow acceptance target when present:

   ```sh
   NX_DAEMON=false pnpm exec nx run runtime:migration-acceptance --skipSync
   ```

4. Run the regression bracket before a milestone push:

   ```sh
   NX_DAEMON=false pnpm exec nx run-many -t typecheck test --projects=contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync
   ```

5. Check the full diff, obtain an independent review, and verify CI on the
   current PR head before merging. Attach the PR to this task.
6. Append decisions and actual results to [the decision trail](./migration-decisions.tsv).
   Update this record with the next safe action and unresolved gates.

The task has a 30-minute continuation named
`continue-temari-migration-and-parallelism`. It should remain quiet when no
actionable state changed and stop repeated runs at completion or a genuine
user-input gate.

## Remaining gates

- Public entry packaging and proof that the installed host uses the new core.
- A runtime-owned closeout operation that verifies actual bytes, expected
  candidate identity, and complete stage-evidence bindings. The current pure
  decision and acceptance fixture do not provide that installed operation.
- Independent QA evaluator journey and capability-provenance enforcement.
- Shared-service selection, artifact access, and real multi-machine evidence.
- Complete cancellation policy and automatic failover acceptance.
- Rollback installation and operator authorization for final cutover.
- Separate review of the uncommitted privacy work.

The [cutover plan](../temari-nx-cutover-plan.md) and
[implementation inventory](../implementation-inventory-and-parallelism-roadmap.md)
retain the full program scope. Do not mark those gates complete from this
local acceptance unit alone.
