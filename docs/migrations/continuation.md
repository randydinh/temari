# Temari migration continuation

This record is for the maintainer who resumes the migration. Read the current
Git state and pull requests before acting. A checked implementation item does
not replace acceptance evidence from the installed product.

## Current handoff — 2026-09-26

Continue in [Choose temari build source (3)](codex://threads/01a0dcca-d913-7d52-9f1b-16e47b5bd90a).
The user requested closure of the completed increment in the source thread and
continued development in that existing thread. The development base is current
`origin/main` of `randydinh/temari`, the **temari-next / Temari Nx monorepo**,
not the old v4.1 checkout. PR #53 is merged as
`4d316e31fb8cbd7cbb3011e59896fafacc5aaead`; reconcile subsequent main commits
before starting. The historical pending gates below are superseded only by
their explicitly recorded review, CI and merge outcomes.

The successor's `b203/temari-next` worktree was detached at `0d6c7a1` during
handoff preparation and contains uncommitted privacy, lockfile and tsconfig
work plus an untracked `.pnpm-store/`. Preserve it. Use a clean isolated branch
from current Nx main for the next increment; do not reset the successor or
commit its unrelated work. Main's separate protected changes also remain.

The source thread's `continue-temari-migration-and-parallelism` heartbeat is
paused for this handoff. Earlier engineering workers and native probe processes
have ended. No branch, worktree, legacy checkout, evidence or installed plugin
was deleted. The completed canonical-package, stage-evidence and
candidate-closeout worktrees are clean and their heads are pushed. The clean
host worktree is reused for the docs-only closeout branch
`codex/nx-thread-closeout-20260926`; the merged host branch remains preserved.

This closes an experimental local host-transport increment, **not** public
migration, installed-product acceptance or distributed parallelism. The next
owner should follow the bounded sequence below and retain all remaining gates.

Closeout verification reran from the isolated branch based on `4d316e3`, with
only the four documentation files changed: all ten workspace typechecks,
557 tests across contracts/core/engine/runtime/knowledge/plan-draft, 34 legacy
distribution tests, eleven compiled-package checks, 39 host-session checks,
and the 234-file pinned inventory passed. Nx cache and sync were disabled;
no protected WIP entered this test checkout. Nx changed-file formatting,
whitespace and six-column decision-trail checks also passed. The successor
acknowledged the Nx base and WIP boundary at 08:45 UTC and is waiting for the
final handoff. The docs-only closeout PR must record its exact head, final
independent review, CI and merge before final delivery and source-thread archive.

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

The next completed unit started from the PR #50 merge on
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
Independent re-review of repaired source head
`80f13355ec75d6eac1d0268321419ff6d5fa9798` returned PASS, with base-to-head
stable patch ID `1f70b928bccbe9a406a0be8a86676e63e5879b9f`. The reviewer
reproduced the 214 core tests, four typechecks, and six compiled-package checks,
and ran twelve additional in-memory adapter probes (ten refusals, two positive
controls). The scoped decision-trail audit found no blocker. Linux run
`36221336318` and Windows run `36221334558` passed at that repaired source head.
The final documentation head `7ecd1381b936a072ee1665c80e2e6db6786b622a`
received a separate independent delta PASS. Linux run `36221717118` and
Windows run `36221728823` passed at that exact final head. PR #51 merged as
`64bd51fa640da5c96910b7ba294de0066cbe5153`. Main was fast-forwarded, with
the same stable patch ID as the final review,
`edba8ae1bd531c5fd2713011763a2134fac2330d`. The pre-existing main changes and
protected file hashes were preserved. No branch, worktree, or task was deleted.
See [the runtime API and limits](./stage-evidence.md).

The completed candidate-aware closeout unit was developed on
`codex/candidate-closeout-20260926`, in `.audit/worktrees/candidate-closeout`,
based on the PR #51 merge. There was no open PR or active previous worker when
this unit began. The unmodified baseline passed all eight core typecheck/test
targets and all six compiled-package checks. The implemented successor profile
binds initial candidate intent in an empty checkpoint and permits build changes
while binding subsequent stages to the built bytes. A separate persisted reader
requires an independently selected expected current identity. It retains stable
stage-workspace checks and refuses profile relabeling, terminal replay, orphan
manifests, and unacknowledged mutation. See [the API and limits](./candidate-closeout.md).

Local verification passed all ten workspace typechecks and all six core,
knowledge, and plan-draft test targets, including 167 runtime tests. The core
implementation owner also passed the four core typechecks and 257 core tests.
All eleven compiled-package checks passed, including five candidate crash/recovery
scenarios and restricted readback. All 34 legacy package tests and the 234-file
pinned inventory check pass. Independent comment review recommended two redundant
comment deletions, applied without behavior changes; it found no refactor flags
or new suppressions. Independent code/trail review and current-head Linux/Windows
CI remain merge gates; no merge is claimed at this point.
Final inspection added explicit reader-service admission: a JavaScript caller
cannot omit the manifest store and silently skip workspace checks. The repaired
patch passed all eight core typecheck/test targets (168 runtime tests, 258 core
tests total) and all eleven compiled checks. No new comments or suppressions
were added by this guard and its regression test.

[PR #52](https://github.com/randydinh/temari/pull/52) was held open during these
checks. Independent source
and decision-trail review of `c93fcdc12116f6f7bb56da7180a29a88a87fb8a8` returned
FAIL: the scheduled wrapper could accept caller mutations during its run-store
prelude before the direct entry captured candidate intent, including a silent
downgrade to legacy execution. The reviewer reproduced four typechecks, 258 core
tests and eleven compiled checks, then exposed the gap with two failing safety
probes and three passing controls. Linux run `36224516207` and Windows run
`36224485760` passed at that source head; neither green run clears this finding.
That candidate was not merged.

The repair captures and admits the selected execution request before scheduler
callbacks, preserves stage bindings and scheduler options, and rechecks resolved
roots before dispatch. Scheduled candidate/legacy controls and clock/create/claim/
dispatch mutation regressions are added. The packaging guide now distinguishes
the original evidence-only fixture from the newer candidate scenarios. The repair
passes the eight core targets (267 tests, including runtime177) and all eleven
compiled checks. Independent re-review and current-head CI are required before merge.
The PR is linked here and in the task. The available app tools could queue its
page but could not save a PR attachment; no saved-attachment claim is made.

Independent re-review passed at repaired head
`3cf507c61bb783ab10c0545a43cb5e079e762e77`, base-to-head patch ID
`0b911f0bd8a2cb9344099ce8db93151de9268f57`. The reviewer read all six repair
files, reproduced four typechecks, 267 core tests and eleven compiled checks,
and ran five independent probes with fresh state. Both original faults now
pass their safety assertions; no new findings remain. The original FAIL and
its probe state are retained separately. Review used an independent context
with the inherited model, not a cross-model or independent product-QA claim.
Linux run `36225287151` and Windows run `36225285286` were started for that
repair head; final documentation review and CI at the eventual merge head
remain required. Source review does not establish host installation or cutover.

Repair-head Linux CI passed, but Windows CI failed the older local child-takeover
test: 177 runtime tests, 175 passed, one failed and one skipped. The failing
path surfaced the child store's error-length assertion; later Windows acceptance
steps were skipped. This is a failed gate, not a successful candidate run.
The fixture advanced its fake clock after a handler-return signal and a 100 ms
delay without waiting for durable child completion. Adding a 250 ms evidence
publication delay reproduced a local failure (`BLOCKED` instead of `PASS`),
recorded in test-first commit `ac4ef8c`. The exact Windows interleaving was not
captured, so this local trigger is not claimed as an identical platform trace.
Hold merge for a reviewed fix and fresh native Windows/Linux checks.

The fixture fix now signals worker-1 completion only after the genuine store
has persisted SUCCEEDED and an independently opened store reads that state.
The delayed publication remains, worker-2 stays blocked until takeover, and
the replacement-count, evidence, manifest and receipt assertions are unchanged.
Worker and main runs passed all 177 runtime tests; main also reproduced the
four core typechecks and all 267 core tests. This changes only the fixture,
not production timing, leases, fencing or store validation. Final delta review
and current-head CI remain gates. The separate independently reproduced
empty/oversized-worker-error persistence gap is retained in the
[roadmap](../implementation-inventory-and-parallelism-roadmap.md#retained-local-failure-reporting-gap),
not hidden by this fix or claimed resolved.

Both platforms passed at `7aaef6f83e3eeb7cf748c1b7a608fd5b5eb0115b`
(Linux `36226124466`, Windows `36226122596`), but final independent review
returned FAIL for the fixture's success-only barrier: a durably failed child
could leave it waiting without reaching cleanup. A separate negative probe
timed out after five seconds instead of surfacing its retained diagnostic.
That head was not merged. The next fixture-only repair propagates completion
and readback errors, observes coordinator rejection, bounds readiness inside
the cleanup path, and drains the held child using the persisted group mapping.
Five controls cover evidence failure, completion rejection, readback rejection,
an absent signal, and failure while draining the held child. They assert exact
diagnostics and completed cleanup; the delayed successful takeover and its
original assertions remain. Main reproduced four core typechecks and 272 tests
(runtime182). Production runtime/store code is unchanged from the independently
reviewed `3cf507c`; this test/docs delta still requires independent re-review
and fresh exact-head Linux/Windows CI.

Re-review of `407d111` confirmed the original barrier failure paths were fixed,
but rejected a delayed-start cleanup race: worker-2 was marked in flight only
after its initial file write, so another child's earlier failure could skip
the drain. The independent probe and test-first commit `8d55eff` reproduced
cleanup before settlement (`false !== true`). The narrow fix moves that marker
to synchronous handler entry while retaining the readiness signal after the
write. The six failure controls and delayed successful takeover now pass;
main reproduced four core typechecks and 273 tests (runtime183). No production
code changed. The rejected head was not merged; this final delta still needs
independent review and current-head CI.

Independent review passed at `66256008244b70e8b579495c7ba03fc727559b23`,
patch ID `ea7f83256f0b8a34674ffbf27ecca91e186dc4f6`; it reproduced all
273 core tests and a fresh delayed-start probe showing settlement before
cleanup. Linux `36226915057` passed, but Windows `36226913657` failed a
different existing test: child-lease renewal expected COMPLETE and observed
RUNNING. Later Windows packaging/Archon steps were skipped, so this is not a
passing platform gate. The renewal fixture uses a 300 ms wall-clock lease,
a 50 ms timer and a 650 ms handler delay. The exact missed-renewal interleaving
was not retained; investigate that timing boundary without weakening production
expiry or treating another head's green checks as acceptance. The PR remains
unmerged pending a scoped repair, review and fresh CI.

A bounded local probe with genuine stores reproduced lease starvation: a
350 ms event-loop pause yielded RUNNING, `lease-lost`, no receipt and no renewal
event. This confirms a reachable mechanism, not the unobserved Windows schedule.
The test-only repair retains the runtime's 50 ms interval and store's 300 ms
lease, using an injected clock advanced only after durable renewal readback.
It asserts three literal renewed deadlines and successful completion beyond
the initial expiry. A separate missed-deadline control requires RUNNING,
`lease-lost`, the original expiry and no receipt or completion event. The bounded
handler wait settles through the runtime before fixture cleanup. Worker local
verification passed runtime185 and dependency typechecks. Production behavior
and all previously reviewed takeover tests remain unchanged; independent delta
review and fresh platform CI are still required.
Main independently reproduced the four core typechecks and all 275 core tests
(including runtime185), then passed formatting and whitespace checks.

Final independent review passed at
`2f54bf8bf4e1662d34156e13146c2b179362e5ff`, reproducing the four core
typechecks, 275 tests and two additional renewal failure probes. Linux run
`36227717603` and Windows run `36227715032` both passed at that exact head.
PR #52 merged as `0d6c7a1e4afa8ade8f1d5496d2194d059fe4356f` on
2026-09-26 at 07:50 UTC. The reviewed and merged changes share stable patch ID
`b5ae95d60f4aaa56199d641a3b428c4830307203`. Main was fast-forwarded with
the original privacy, lockfile and tsconfig changes and their hashes preserved.
The failed review/CI attempts above remain historical evidence, not active
gates or passing runs. Independent review used a separate context with the
inherited model; it was not cross-model review or installed-product QA.

The next unit starts from that merge in `.audit/worktrees/public-entry-host`,
branch `codex/public-entry-host-20260926`. There was no open PR or active
previous worker at its start. It will compare and implement a bounded host
entry boundary using the canonical runtime. No installed discovery root,
marketplace, private overlay or existing plugin may be changed by this unit.
Actual host acceptance and independent product QA remain open.

The design comparison selected a private local stdio bridge, rather than a
direct-only callback facade that cannot reach native Codex tools from stock
Node. This first increment is explicitly experimental transport, not public
skill installation or policy migration. It uses the existing runtime's
candidate observations, evidence, checkpoints and terminal receipts. No shared
library, pinned asset, installed plugin or capability proof is changed.
See [the boundary, usage and limits](./host-session.md).

The new focused Nx target passes 37 subprocess checks locally: actual candidate
changes and persisted verification; fresh-session prefix reuse; empty intent;
dirty unacknowledged build and orphan refusal; malformed/stale/duplicate/oversized
input; confined evidence bytes; lost input/output and SIGINT; changed retained
intent/manifest; and terminal no-replay. A native Codex PTY probe used the real
entry, actual patch/read/assert tools and bounded regular-file product. It
acknowledged build, exited 130 on raw Ctrl-C, resumed at review in a new session,
and persisted PASS with all six stages and the original start time. LF and CRLF
replies worked. This used source bridge files and a separately built/checked
canonical artifact, not an installed public capsule. Self-review only was
requested; no independent product QA or host capability was claimed. Retained
local evidence is under the ignored `.audit/host-dialogue-native` directory.
Source/trail review and exact-head Linux/Windows CI remain merge gates.

[PR #53](https://github.com/randydinh/temari/pull/53) was opened at `3c77814`.
Independent review reproduced a candidate-root substitution: changing only the
descriptor to a different directory with identical bytes redirected resumed
work and could still yield PASS. It also found that ETX in an ordinary pipe was
misclassified as a keyboard interrupt. Test-first commit `cfb2599` reproduced
both failures (37 passing checks, two failing). That head is not mergeable on
the strength of its other passing tests or CI.

The scoped repair derives the runtime's candidate scope ID from the canonical
validated invocation descriptor. Existing empty-checkpoint identity now binds
the original root, run directory and runtime selection without a new progress
ledger or shared-library change. Raw Ctrl-C handling applies only to a terminal;
malformed pipe bytes produce terminal BLOCKED. All 39 focused checks pass after
the repair. Independent re-review and fresh exact-head CI remain required.

The repair was committed as `9773b23`. A second native terminal probe retained
the descriptor-bound empty checkpoint through raw Ctrl-C exit130, resumed at
investigate in a new session, then intentionally returned ISSUES through CRLF
and persisted that nonpass with exit1. Its evidence is retained separately in
`.audit/host-dialogue-repaired`; it is not a completed product journey. Main
also passed all ten workspace typechecks and 557 tests across core, knowledge
and plan-draft before this narrow repair; shared libraries did not change.
Independent comment audit recommended two redundant comment removals and one
shortening, applied without behavior changes or suppressions. The PR is linked
here and in the task; the app could queue its page but exposed no attachment
writer, so no saved attachment is claimed. Finish current-head review and CI
before merge, then proceed to isolated packaging and public policy admission.

Final independent source and decision-trail review passed at
`937ee6392c4ce215f5c1c2de417b646c20462427`. The reviewer reproduced all 39
host checks and eleven compiled-package checks, verified both repaired faults,
and checked descriptor key-order equivalence and changed-scope refusal. Review
used a separate context with the inherited model, not cross-model review or
independent product QA. Linux run
[36230021028](https://github.com/randydinh/temari/actions/runs/36230021028)
and Windows run
[36230019066](https://github.com/randydinh/temari/actions/runs/36230019066)
passed at that exact head. PR #53 merged as
`4d316e31fb8cbd7cbb3011e59896fafacc5aaead` at 2026-09-26T08:38:09Z.
The reviewed and merged stable patch ID is
`6fcef8dee2940bcc3d74dc246e3a58464655e4e2`.
The [PR evidence record](https://github.com/randydinh/temari/pull/53#issuecomment-5844661301)
retains the final verdict and verification; the earlier failed candidate was
not merged. Main was fast-forwarded with all nine protected privacy, lockfile
and tsconfig file hashes unchanged. The native probe directories above remain
ignored local-only evidence, not runtime dependencies or portable acceptance.

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

The evidence-only verifier remains distinct from candidate verification. The
candidate operation reloads the complete stage chain and stable manifests, then
reobserves the caller's expected current candidate. It throws on refusal and
returns only local regular-file verification on success, not closeout authority.
The architecture comparison chose compact observations and existing empty
checkpoints over full duplicated inventories and a second initial manifest key.
Initial capability-gap handling precedes the checkpoint hook; no handler runs.
Root isolation, immutable comparison expectations, and typed service requirements
are part of the selected boundary. Scans still require a cooperative exclusive
writer and are not atomic snapshots.

Next, connect the three public entries in an isolated installation using this
canonical runtime, keeping existing engine and run-store ownership. Retain actual
host and independent-QA evidence before shared-service workers. Keep archive
permission separate from a verified receipt. Do not replace the user's installed
plugin or bring in private overlays without specific authority.

### Next owner's first bounded increment

Package the experimental bridge and three public entries into a new, explicit
isolated destination. Keep the exact four-package canonical runtime artifact
as a nested unit with its existing checker; give wrappers, bridge and policy
references their own outer inventory and provenance. Preserve the pinned v4.1
inventory and license as migration references, not the development base. Test
relocation, transitive references, symlink/overlap/tamper refusal, partial
publication and no-overwrite behavior. Do not run the legacy installer against
real discovery roots or replace the currently installed plugin.

Before advertising an installed entry, resolve these policy and evidence gaps:

- Full-playbook route classification alone does not enforce its obligations;
  `createRequestPlan` can default to minimal obligations without supplied policy.
  Admit supported routes explicitly and refuse unsupported routes rather than
  silently falling back to a minimal feature plan.
- The pinned lightweight profile has four source steps (intake, route, build,
  verify), while the canonical engine has six stages. Its current compatibility
  mapping is unsupported. Add a reviewed mapping and requirement evidence;
  preserve final/commit/review requirements and the additional publish approval.
  Do not omit canonical review or deliver to imitate the source labels.
- The bridge deliberately reports zero available capabilities. Caller-written
  capability labels, evaluator IDs or `freshContext` fields are not live proof.
  Retain actual host-tool observations and a genuinely independent QA journey.
  Keep the existing frozen QA input allowlist and mechanical verdict boundary.
- Installed closeout must derive its host-bound scope from trusted invocation
  input and use an independently selected expected current candidate, not copy
  values from a receipt to make verification pass. Reuse existing store readers.
  Some store creation factories create directories; verify open-existing
  semantics before describing closeout as strictly read-only. A verified receipt
  does not grant merge or archive authority.

After installed engineering and QA acceptance, progress the shared-service and
worker integration gates, then real multi-machine recovery. Also retain the
[worker-error persistence gap](../implementation-inventory-and-parallelism-roadmap.md#retained-local-failure-reporting-gap)
as a separately scoped repair before claiming complete worker-failure recovery.
No next implementation or backend choice is implied by this handoff.

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

The source task's 30-minute continuation named
`continue-temari-migration-and-parallelism` is paused for the user-requested
thread closeout. It must not resume alongside the successor owner. Any future
recurring continuation must have one explicit owner and avoid duplicate workers.

## Current unit — public-entry packaging (working)

This unit is being developed from `bd826463ab35bf2746381437ed33cba295f31c85`
(`origin/main`) on the isolated branch
`codex/public-entry-packaging-20260926`. The protected successor checkout and
main-checkout privacy, lockfile and tsconfig work are not in this branch.
The implementation commit for this unit is
`19b5fbc73fb6b47988fe748c21c2cdef14cc34c7`; later documentation-only
amendments preserve that implementation unchanged.

The new outer bundle keeps the exact four-package canonical runtime under a
nested `runtime/` directory, copies the reviewed experimental bridge under
`host/`, and adds a separate outer inventory/provenance manifest. It exposes
three current public skill wrappers plus executable preflight entries for
`temari`, `poteto-mode`, and `closeout`. The wrappers do not define a second
lifecycle: scheduling, checkpoints, receipts, evidence and closeout remain
owned by the canonical runtime and existing stores.

The public admission policy is intentionally narrow and explicit. It records
the exact v4.1 feature profile/playbook hashes as provenance, admits only the
reviewed `full-playbook` / `feature-v1` shape with required delegation,
independent review, revision-bound evidence and pull-request delivery, and
refuses lightweight and QA routes. Because the experimental bridge proves no
host capabilities, a matching feature request returns `blocked` with missing
`subagents` and `forge`; it never accepts caller-authored capability labels.
The closeout entry returns `blocked` until trusted invocation input and
independent current-candidate selection are implemented.

Actual local evidence for this unit:

- `workflow-runtime:public-entry-test`: 5/5 passed, including relocation,
  provenance hash matching, unsupported-route refusal, capability blocking,
  closeout blocking, tamper/symlink refusal and no-overwrite publication.
- `workflow-runtime:canonical-test`: 11/11 passed.
- `workflow-runtime:host-session-test`: 39/39 passed.
- Five affected-project typechecks passed (`contracts`, `temari-core`,
  `workflow-engine`, `runtime`, `workflow-runtime`). Core, engine and runtime
  test projects passed (24 + 48 + 18 + 185 tests). The legacy
  `workflow-runtime:test` lane ran 33/34 tests but its pre-existing upstream
  maintenance test cannot start because this environment has no `bun`
  executable (`spawnSync bun ENOENT`); no legacy source or tooling was changed.
- Plugin JSON and all three skill frontmatters passed structural checks. The
  bundled Python validators could not run because this environment lacks the
  `yaml` module; the equivalent manifest/frontmatter fields were checked with
  Node and Ruby.

This is still packaging/preflight evidence, not installed-host acceptance,
independent product-QA evidence, or distributed/multi-machine proof. The next
safe action is independent source review, exact-head Linux/Windows CI, then
merge this scoped packaging unit if those gates pass. Afterward, implement
trusted installed closeout and live host/QA evidence before shared-service
workers and real multi-machine recovery.

## Remaining gates

- Public entry packaging and proof that the installed host uses the new core.
- Integrate the locally verified candidate reader into actual host closeout;
  the library operation and process fixtures are not an installed entry.
- Independent QA evaluator journey and capability-provenance enforcement.
- Shared-service selection, artifact access, and real multi-machine evidence.
- Complete cancellation policy and automatic failover acceptance.
- Rollback installation and operator authorization for final cutover.
- Separate review of the uncommitted privacy work.

The [cutover plan](../temari-nx-cutover-plan.md) and
[implementation inventory](../implementation-inventory-and-parallelism-roadmap.md)
retain the full program scope. Do not mark those gates complete from this
local acceptance unit alone.
