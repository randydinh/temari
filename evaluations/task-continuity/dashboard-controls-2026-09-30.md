# Dashboard controls and parallel agents

Verified on macOS arm64 on September 30, 2026 local time (October 1 UTC).
Implementation: `04e6da5`; latest main `ef5553a` merged as `91bd6d3`.
Browser verification used `08a4a0e77e64`, including UI clarity fixes. The final
log-preview change only removes terminal escape sequences; raw evidence is retained.

## Delivered journeys

- Save a general goal with durable continuation context.
- Prepare and run fixed, host-configured verification through Archon. Observe,
  resume the exact native run, cancel, verify evidence, and explicitly accept.
- Prepare 2–4 read-only Codex investigators/reviewers with a configured concurrency
  ceiling. Retain each attempt, findings, logs, cancellation and partial results.
- Review worker findings and edit next actions without losing conflicted drafts.

The [operator guide](../../docs/task-dashboard.md) contains configuration and
limits. Local state remains outside the selected clean Git workspace.

## Executed evidence

| Check                                            | Result                                                                                                  | Retained evidence                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Task ledger, runtime, HTTP and CLI tests         | 57 passed                                                                                               | [Task tests](2026-09-30-dashboard-controls/task-tests.log)                     |
| Dashboard controller and actual subprocess tests | 17 passed, repeated through the live native workflow after merging main                                 | [Native review capture](2026-09-30-dashboard-controls/native-review.log)       |
| Parallel runtime and evidence integrity          | 88 passed, repeated through the live native workflow                                                    | [Native verify capture](2026-09-30-dashboard-controls/native-verify.log)       |
| Archon harness                                   | 20 passed                                                                                               | [Harness output](2026-09-30-dashboard-controls/archon-tests.log)               |
| Native HTTP integration                          | Real restart, forced stage failure, resume of the same native ID, six verified stages and explicit DONE | [Native regression output](2026-09-30-dashboard-controls/native-http.log)      |
| Merged TypeScript checks                         | Passed, including runtime dependencies                                                                  | [Merged typecheck](2026-09-30-dashboard-controls/merged-typecheck.log)         |
| Merged public package and entry checks           | 63 passed; task tracking and bundled Registrar both retained                                            | [Public package checks](2026-09-30-dashboard-controls/merged-public-entry.log) |
| Real model parallelism                           | Two Codex processes, both exit 0 on attempt 1; **20.013 seconds of overlap**, receipt peak 2            | [Structured live proof](2026-09-30-dashboard-controls/live-proof.json)         |

Suites overlap; their counts are not a unique-test total. Text log copies omit terminal
color escapes and normalize line endings and trailing whitespace. The structured proof records original native capture hashes and
the local canonical receipt/evidence roots.

### Live browser and persistence

The browser created task `task-13476a2c-81b7-4192-b8d8-4ce6c835e771`, prepared two
agents at concurrency 2, and started both. PIDs 26561 and 26562 produced independent
source-cited findings. Both results passed retained-evidence checks after restarting
the dashboard server. The task remained **NEEDS_REVIEW**, with no semantic acceptance.
The real model runs finished before the attempted active-run server restart;
active supervisor survival is covered by the separate real-subprocess regression.

The browser then created `task-7e346e45-ac5f-4c1f-b8c1-72e129272423` for the fixed
dashboard-verification recipe at `08a4a0e77e64`. Native run
`81c58ecc71f8a1d13c69fd1129199b27` retained six successful captures. After inspecting
the logs and verifying evidence, explicit acceptance produced **DONE** for that
verification goal. This does not complete the broader dashboard roadmap task.

For note-conflict recovery, a draft was entered, another operation advanced the
same task version, and refresh preserved the text while disabling Save. Explicitly
keeping the draft against the displayed current version enabled a successful save.
Both services were observed listening only on loopback: dashboard `127.0.0.1:3092`
and its matching Archon console `127.0.0.1:3091`.

The matching native run link was opened in Archon. Its Log view showed all stage
transitions. Graph initially reported a missing workflow because pinned Archon
looks up the current workflow catalog instead of the retained run definition.
Copying the exact retained 1,694-byte YAML into the dedicated
`ARCHON_HOME/workflows/temari-nx-canonical.yaml` restored the graph. The browser
then showed six completed stages plus finalization. The copied SHA-256 is
`89f03b21c7acf58add17fe041a842fcbf0fbef397a8926b1baa3e814d7217e02`.
Captured evidence and the execution workspace were unchanged.

## Review and fixes

An independent reviewer found and re-reviewed fixes for stale note drafts and
lost cancellation controls when preparation or a sibling's evidence is damaged.
Final source review reported no remaining actionable findings. The reviewer did
not independently rerun the reported suites or certify other platforms.

Parallel verification also exposed concurrent evidence temporary-file collisions
and peak-concurrency underreporting across worker waves. Unique temporary names
and durable peak observations now have focused regression coverage. Uncertain
supervisor ownership never authorizes duplicate launch or proves worker termination.

## Alignment with latest main

The merge retains both host task tracking and main's `0.15.4+codex.1` knowledge
package inventory. It does not activate that plugin release. Registrar owns
source bytes, intake and citations; current sharing settings are checked in the
knowledge APIs. Dashboard startup does not register sources or initiate hosted
knowledge queries. New knowledge jobs use the child runtime but do not yet have
dashboard group bindings. Graph expansion remains diagnostic and opt-in.

## Remaining scope

The swarm route returns read-only findings. Autonomous coding swarms, automatic
Temari planning/synthesis, schedules, a Registrar map, currency budgets and
cross-platform process-control proof remain outside this increment. This record
is local implementation evidence, not a trusted full-feature delivery receipt or
proof of GitHub publication.
