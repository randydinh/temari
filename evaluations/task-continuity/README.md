# Task continuity: first local increment

The latest [dashboard controls and parallel-agent record](dashboard-controls-2026-09-30.md)
verifies the writable UI, real Codex overlap, native verification and restart recovery.

For the subsequent main integration, host entry, scoped pickup, and handoff
increment, see the [compatibility and verification record](main-compatibility-2026-09-30.md).
The results below remain the historical evidence for the first increment.
The next [source host entry record](host-entry-2026-09-30.md) covers automatic
recovery and outcome handoffs around actual stage dialogue.
The [public entry record](installed-entry-2026-09-30.md) extends this journey to
rebuilt public bundles, including full-feature worker preparation.
The [local activation record](activation-2026-09-30.md) verifies the installed and
enabled `0.15.3+codex.2` plugin and retention of the previous pinned bundle.

Verified on 2026-09-30, macOS arm64, against implementation candidate
`2656e8420e33e25894bec32d5764b5b270a68440`. Base:
`a2d33b9b496f83e6fbebbbb9ce1c3e518895c749`.

The user approved extending Temari's existing Archon integration with durable
tasks and a small read-only inbox. See the [operating guide](../../docs/task-continuity.md)
and [roles matrix](../../docs/system-roles-and-responsibilities.md).

## Results

| Check                                              | Observed result                                                                                                                                    | Evidence                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime:test`                                     | 245 passed, zero failures/skips, 44.7 seconds                                                                                                      | [Full output](2026-09-30/runtime-test.log)                                                                                                                                            |
| `workflow-runtime:canonical-test`                  | 11 passed, zero failures/skips, 5.2 seconds                                                                                                        | [Full output](2026-09-30/canonical-test.log)                                                                                                                                          |
| `runtime:task-test`                                | Passed after all recovery fixes                                                                                                                    | Task ledger/runtime, separate CLI process and HTTP tests in source                                                                                                                    |
| `runtime:task-typecheck`                           | Passed with runtime dependencies                                                                                                                   | Nx command result observed by coordinator                                                                                                                                             |
| `runtime:task-native-test`                         | Both model-free tests passed using pinned Archon 0.10.1                                                                                            | [Native regression](../../tools/task-native.test.mts); Nx command result observed by coordinator                                                                                      |
| `archon-harness:test` and runtime harness boundary | 19 and 8 tests passed respectively                                                                                                                 | Scoped builder's execution report; [adapter tests](../../libs/archon-harness/src/lib/archon-harness.test.ts) and [boundary tests](../../libs/runtime/src/lib/harness-runtime.test.ts) |
| Browser                                            | Actual retained task displayed after reload/server restart; search empty state and restored results worked; no browser warning/error logs observed | Local inbox at port 3092, inspected through the in-app browser at 1280×720                                                                                                            |
| Native run URL                                     | Project-scoped route displays the existing run; project-free route did not                                                                         | UI changed to `/console/p/<codebase-id>/r/<run-id>` with native-observed project identity                                                                                             |

The test suites overlap; these counts must not be summed as unique cases.
Native test homes are isolated and cleaned after success; failed tests retain
their directories. The checked-in smoke is reproducible execution evidence,
not a retained live-provider engineering receipt.

## Independent review

A read-only architect recommended a logical ledger above execution, durable
intent before side effects, one execution owner, and separate acceptance. Scoped
builders implemented task persistence and native controls. A separate reviewer
examined frozen candidate `f17068465b6a77abc9c1ba29d66080fedab1373e` and found:

1. A recovered native ID could be unrelated to the pending task.
2. Native-backed acceptance was unavailable through the CLI.
3. Cancellation racing normal completion left the task permanently uncertain.

The fixes add retained native provenance and an explicit verification port, native
harness selection during CLI acceptance, and a resolved `finished-before-cancel`
outcome. Native smoke now rejects a different real run before recovering the exact
interrupted launch and exercises acceptance through the CLI. Focused re-review of
`2656e8420e33e25894bec32d5764b5b270a68440` reported **no findings**. The reviewer
inspected source/tests independently and did not execute additional tests.

## Proof boundaries

This record documents actual tool execution and independent review. It is not a
trusted packaged `feature-v1` PASS receipt. The inbox is read-only, and local
serial acceptance cannot discharge independent-review or forge obligations.
No model calls were made by the native smoke. It does not establish live swarms,
provider budget enforcement, Windows process control, recurring scheduling,
automatic chat capture, a Registrar map, or authenticated role permissions.
Mobile viewport emulation did not take effect in the browser used here, so this
record makes no mobile visual verification claim.
