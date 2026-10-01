# Public engineering entry task continuity

Implementation candidate: `2f1b9254f02fc8b39d84ac808a2aca6441803bcf`.
Base: `67659a4`, including the source-host integration and main through `8e3ddc4`.
Verified locally on macOS arm64 on 2026-09-30.

## Delivered behavior

Rebuilt public bundles accept a separately hash-pinned task selection on
`temari.mjs` and `poteto-mode.mjs` engineering `start` and `resume`. Lightweight
work preserves the source-host version-1 sidecar. Full feature work uses version 2
to bind the original project, run identity, public request and bundle manifest.
The feature host still independently verifies the integration checkout.

Feature preparation retains a starting handoff before forge access or workers.
Its caught failures save a blocked handoff with worker-evidence locations, even
when no canonical run exists. The stage host reuses the initial task entry and
saves its outcome. Omitted or switched tracking cannot silently change the task.
Abrupt transport/process loss preserves the latest durable handoff and checkpoint;
it does not promise a final interrupted-outcome write.

The [packaged guide](../../packages/workflow-runtime/public/skills/temari/references/task-tracking.md)
is included in the hashed artifact and reachable from both public skills. README
and AGENTS link the contract for future sessions. Task metadata remains outside
the execution descriptor, and candidate receipts remain pending trusted closeout.

## Verification scope and results

| Outcome and risk                                        | Required proof                                                                                                                | Observed result                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Preserve task identity across a public process boundary | Both public entry names interrupt after build and resume in a new chat                                                        | Remaining stages complete once; retained invocation bytes stay identical; both chat links remain                              |
| Track feature preparation before side effects           | Invalid task digest, public request binding, source scope or evidence overlap                                                 | Zero fake forge/worker calls, no task entry, no worker evidence                                                               |
| Distinguish source project from integrated execution    | Tracked feature workers produce an integration checkout; resume existing proof                                                | Task workspace remains the source project; canonical descriptor selects the verified integration; three workers run only once |
| Failed preparation remains discoverable                 | Required architect worker returns a non-PASS outcome                                                                          | Task is BLOCKED with evidence pointers; no invented canonical run; untracked retry refused before forge/worker calls          |
| Exact selection and admission                           | Missing/duplicate/unknown tracking flags, stale task version, bundle overlap, swapped/omitted selection, unsupported commands | Refused; candidate content and task state remain intact as applicable                                                         |
| Preserve existing execution authority                   | Public admission, tampering, source evidence, exact resume and trusted closeout regressions                                   | Existing checks pass; tracking does not create TaskRun bindings, acceptance or DONE                                           |
| Preserve source-host behavior                           | Shared helper regression including crash windows, atomic binding, concurrent edits and canonical-task guard                   | 53 source-host checks pass                                                                                                    |

Executed commands:

- `workflow-runtime:public-entry-test`: **62 passed**, zero failures/skips.
  [Retained output](2026-09-30-installed-entry/public-entry-test.log).
- `workflow-runtime:host-session-test`: **53 passed**, zero failures/skips.
  [Retained output](2026-09-30-installed-entry/host-session-test.log).
- Skill Creator `quick_validate.py`: both modified public skills passed using
  the existing `skillopt` Python environment. The default Python lacks PyYAML;
  no dependency installation was needed.
- `git diff --check`: passed before candidate freeze.

The first installed test run exposed incorrect test expectations: abrupt EOF
preserves the starting handoff (task version 2), and a caught preparation failure
projects BLOCKED. Tests and recovery guidance were corrected to the actual
transport contract, then both suites passed against the frozen implementation. Both were rerun after
the independent-review concurrency correction.
The suites overlap; their counts are not a count of distinct product scenarios.

The existing P-stack audit builder was refreshed against this worktree, with its
output redirected outside the dirty main checkout: 86 nodes and 195 edges. That
graph covers the legacy bundled P-stack assets, which this increment does not
change. The public skill reference closure is exercised by the artifact tests.

## Independent review

The read-only architect recommended validating and recording feature tracking
before worker preparation, retaining source and execution identities separately,
and reusing the same sidecar and idempotency phases in both processes. A scoped
builder implemented the three production modules; the coordinator added process
journeys, packaging closure and operator documentation.

Independent review of `c3eb60951153151f31e9f1af7a9ab77d02cd479e` found that
a duplicate feature start could collide with worker evidence, save an interrupted
outcome against the shared attempt, then prevent the original process from
entering its stage runtime. The reviewer reproduced task version 2 advancing to 3
through the losing process, followed by the original's version conflict.

Candidate `2f1b9254f02fc8b39d84ac808a2aca6441803bcf` reserves tracked feature
preparation exclusively. It rejects an existing marker and an atomic publication
race before entering the task or launching workers. The regression holds the
original architect process open, attempts a duplicate, verifies unchanged task
and forge/worker call records, then lets the original complete and resume.
The recovery guide distinguishes canonical resume from a reserved preparation
that lacks a checkpoint.

Focused independent re-review reported **finding resolved; no residual findings**.
The reviewer examined the correction and regression test without rerunning the
full suites or live providers.

## Retained local bundle

Built with the existing public artifact packager from the frozen implementation:

- Path: `dist/task-tracking/2f1b925` in the managed task worktree.
- Source revision: `2f1b9254f02fc8b39d84ac808a2aca6441803bcf`.
- Inventory: **111 files**.
- Manifest SHA-256: `1d86b307c8620b56b6f885fd0259342a9efb24a22fad7193274df59fc7fdad6f`.

The packager verified the artifact after writing it. This is a retained local
bundle, not a replacement of the active Codex plugin cache or a published release.
The superseded generated bundle from `c3eb609` was removed after this build.

## Limits

Tracking requires a selected task; task discovery still uses the local task CLI
and dashboard. QA, standalone worker and closeout commands refuse tracking flags.
Tasks with canonical run history or acceptance use their existing controls.
Preparation failures before the first checkpoint retain evidence and context but
do not gain automatic worker recovery. A conflicting late task handoff fails
visibly instead of replacing another chat's progress.

Tests use real local processes, files and Git worktrees with deterministic fake
Codex/forge tools. They do not prove live model quality, live forge delivery,
Windows behavior or a trusted full-feature completion receipt. No new scheduler,
transcript harvesting, knowledge-plugin lifecycle or automatic task acceptance
was introduced. Existing admission, knowledge-sharing and closeout rules remain
the execution authority.
