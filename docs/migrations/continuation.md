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

The first completed unit added process-restart migration acceptance tests against the
existing request-plan API and persisted runtime. Its boundary is a sanitized
filesystem fixture. It does not prove an installed agent host, independent
reviewer execution, or cross-machine coordination.

Local acceptance and all eight core typecheck/test tasks pass. Independent
read-only review of head `b0ecf8badcffd32aff52c9686f3962b57e1d4bd4` against the
starting trunk returned PASS+NOTES with no blocking findings and reproduced
the six acceptance scenarios. The stable patch ID was
`25977de0ac6dbfd34c0bed90dc48de092c2a65f1`.

The branch is `codex/migration-acceptance-20260925`,
[PR #48](https://github.com/randydinh/temari/pull/48). Linux CI passed at that
head (run `36174260034`). Windows core checks passed, but the later native
Archon smoke failed when the script combined a stderr update notice with
stdout JSON (run `36174236786`). Do not treat that failure as a passing CI
run. The scoped repair is
[PR #49](https://github.com/randydinh/temari/pull/49), branch
`codex/windows-json-streams-20260925`, head
`c8f93a0c8be69f601d9961ca64eec0ebaae8b526`. It separates the streams and
requires a deliberately seeded real update notice. Independent review and
Linux/Windows runs `36203664260` / `36203623339` passed at that head. PR #49
merged as `214bc1de910bf7908036c090a245f226898ec4f2`, and its repair is now
included in #48. PR #48 then passed its own Linux run `36204513002` and
Windows run `36204509941` at final head
`5fc750b569ace0f19109232f193f9e848ebaae30`. The independent reviewer checked
the final CI/documentation delta without treating the prior failed run as
success. PR #48 merged as `dbcd8ba9bcd20eea48773e96185a24dbc6da02ce`.

The next completed unit added compiled canonical packaging on branch
`codex/canonical-runtime-package-20260925`, based on that merge,
[PR #50](https://github.com/randydinh/temari/pull/50). Source candidate
`2407705332cd1b361f8aabafdbbe140a74f73aae` received an independent PASS
review, with stable patch ID `a575c8f3d4f445f93afc636f4350e85ab1236be8`.
The reviewer reproduced all six packaging checks, built a clean-head artifact,
and independently typechecked all 28 emitted declarations without source
libraries entering the consumer program. The six packaging checks pass locally,
including fresh-process recovery and denied-source evidence readback. Core
typecheck/tests and workflow-runtime typecheck passed; the legacy test first
stopped at missing Bun, then all 34 tests (including the copied upstream ten-test
suite) passed with the existing Bun 1.4.2 on the search path. The 234-file pinned
payload check passed. Local tools were Node 26.9.0 and pnpm 11.25.0; CI remains
pinned to Node 24 and pnpm 9.15.9. Linux run `36218487553` and Windows run
`36218440080` passed on source candidate `2407705`. A documentation-only
follow-up at `369a092144032183e0dc94f712bd3b4a6af9625c` received an independent
delta PASS review. Linux run `36218761742` and Windows run `36218779513`
passed at that final head. PR #50 merged as
`5c5a66ecb3c357976a9f94df3a98320c7b6cab2a`. Main was fast-forwarded without
changing the pre-existing lockfile and tsconfig hashes. The PR is linked here
and in the task; the app's attachment-writing
tool was unavailable after the interruption, so a queued review panel is not
claimed as a saved attachment.
The completed working copy is the ignored `.audit/worktrees/canonical-runtime-package`
under the main checkout. The earlier temporary worktree and worker session
were unavailable after the 2026-09-26 interruption; their uncommitted parent
drafts were reconstructed from the task record. No completion or test result
is inferred from that interrupted worker. Keep durable continuation evidence
inside the checkout or on the forge, not only in an operating-system temporary
directory. Leave unrelated missing-worktree metadata untouched.

The active unit starts from the PR #50 merge on
`codex/stage-evidence-20260926`, in `.audit/worktrees/stage-evidence`.
It adds persisted per-stage evidence ownership and byte verification before
candidate-aware closeout. The eight core typecheck/test tasks and six compiled
package checks passed at this baseline. The initial implementation passed all ten
workspace typecheck targets and 490 tests across contracts, core, engine,
runtime, knowledge, and plan-draft. The six compiled-package checks pass with
fresh-process evidence refusal and restoration. Independent comment review
found no deletions or suppressions. The packaged legacy runtime's 34 tests and
234-file pinned payload check also pass.

[PR #51](https://github.com/randydinh/temari/pull/51) initially passed Linux
run `36220736618` and Windows run `36220715987` at
`da6ba0cd6e6340e19d7b468ba5d734e59e402ab0`. Independent code/trail review
returned FAIL after reproducing a custom store substituting different valid
bytes during publication. That candidate was not merged. The scoped repair
compares returned identities against intended bytes before acknowledgment,
with payload, kind, attestation, and mutable-input fault tests. The reader also
rejects invalid expected identity before contacting its receipt store.
The repair passes the eight core typecheck/test targets, including 124 runtime
tests and 214 core tests in total, plus all six compiled-package checks.
Fresh review and current-head CI remain required before merge.
See [the runtime API and limits](./stage-evidence.md).

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
2. First package the existing canonical library closure as executable JS, with
   ordinary package resolution, an exact artifact inventory, and a relocated
   stock-Node recovery check. Keep this separate from the pinned v4.1 payload.
   This establishes portable packages, not an installed engineering entry.
   Then complete isolated public-entry installation invoking the canonical
   engine without a legacy checkout. Verify engineering and QA on the actual
   host. Keep optional private overlays absent by default.
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

Design review rejected combining packaging with a new execution facade,
transport protocol, candidate-freezing policy, or reservation store. Existing
checkpoint and run-store semantics already own recovery and claims. A future
host integration must support real candidate-changing builds and reconcile
with those owners; it must not silently add a second lifecycle. Prove compiled
dependency closure before selecting that interface.

The active evidence verifier loads actual bytes and validates complete
persisted stage bindings. Its success says evidence-only, not closeout-ready.
It throws on refusal, consistent with the existing storage APIs; it does not
return the blocked-result union considered in the design sketches.
A separate candidate-aware operation must check the expected current candidate.
Preserve the existing engine and
run-store owners. Establish how real builds change candidate identity before
selecting the installed host transport; freezing the candidate for all six
stages does not support normal engineering. Keep archive permission separate
from a verified workflow receipt. Then connect the three public entries in an
isolated installation and retain actual host/independent-QA evidence before
moving on to shared-service workers.

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
