# Dashboard reconciliation verification — 2026-10-03

## Scope

This increment adds bounded retained metadata review, an explicit current-binding
check and immutable local interaction evidence to **Review open work**. It
preserves legacy API contracts and keeps source operations, chat archival and
canonical task acceptance outside this panel.

The isolated build starts at Talk candidate
`1e1d63eb7c302c324594ee0854282df1460e7570`. PR #209's merged main
`bfd9a02154db17392f521f9e6757da29165ee75c` has the same tree. Current-main
composition and publication evidence are retained by the owning reconciliation
workflow; this record does not claim GitHub CI execution.

## Executed local gates

| Gate | Actual result |
| --- | --- |
| `runtime:task-typecheck` | Passed after controller route/containment changes. |
| `runtime:dashboard-test` | 61/61 passed: controller, parallel-runtime regression and reconciliation facade cases. |
| `runtime:dashboard-talk-test` | 69/69 passed: HTTP/CLI, scheduler, Talk and conversation-store regression cases. |
| `runtime:reconciliation-test` | 21/21 passed, including real temporary SHA-1 Git repositories and actual immutable event-file fixtures. These cases also appear in the combined dashboard gate. |
| `runtime:reconciliation-ui-test` | 14/14 passed plus browser-script syntax checks, after recovery and layout repairs. |

These are focused local gates, not additive counts of unique cases or proof of
general host feature admission. Dependency typechecks may reuse Nx cache.

Independent peer reviews covered controller/HTTP/CLI separately from facade/UI.
Two peer defects were fixed before acceptance: malformed-success response review
validation must preserve the exact unresolved request, and a reserved legacy actor
string cannot establish local-event provenance. The binding check now has its own
review-only route, preserving the legacy invalidate projection. Ledger and event
roots reject mutual containment before initialization.

Failed runs remain retained: an inadmissible test revision sentinel, a fixture
observation-kind error, unsupported inventory fields, a repeated one-off Nx command
across dependency projects, and a browser collector's wrong heading selector.
None is silently relabelled as passing evidence. Corrected exact-source runs and
physical readbacks establish the results above.

## Actual headed browser and durable records

A local HTTP service used the real controller, CLI reconciliation factory,
TaskRuntime, TaskStore and Git observer. Its data was fictional: a temporary Git
repository had one modified tracked file and one untracked note; an actual task
had one bound, **unexecuted** run intent. No harness or model transport was
configured, no receipt locations were attached, and no scheduler or native recipe
was enabled.

The browser required opening the complete host-selected review before enabling
confirmation. It observed a matching binding, recorded one interaction and
displayed historic confirmation after reload. Independent filesystem readback
joined the event's actual 744 bytes, SHA-256, request ID and received time to the
retained confirmation. The task ledger, Git HEAD, status and both source-file
hashes were unchanged by confirmation. The task remained OPEN at version 2 with
null acceptance and no native reference; the candidate remained not ready.

The fixture host then intentionally changed the tracked file's contents while
keeping HEAD and porcelain status identical. The real current-binding check
persisted BLOCKED, disabled confirmation and retained the exact historic event and
confirmation. No task acceptance or source operation followed that check.

Desktop (1440 × 1000) and narrow (390 × 844) screenshots were visually inspected.
The narrow document width equalled the viewport width. The panel appears before
the captured inventory. Browser console inspection reported zero errors and zero
warnings. The Talk draft/task-navigation bridge is verified separately in retained
browser logs; sending remains disabled in this fixture.

## Inventory evidence and remaining boundaries

The separately retained metadata-only capture loads 208 displayable chats and 34
checkouts, including 28 registered Temari worktrees and six explicit isolated
clones. It joins 53 exact local workspace associations. Current thread metadata
was read for 211 older local entries; 67 entries without usable bounded current
titles remain in separate accounting. Internal agent/reviewer metadata is retained
and excluded from user-chat classification. Unknown-source records remain marked
as such.

Three foreign-host Windows workspace paths and ten fractional chat timestamps are
retained in raw evidence and projected as null under the existing POSIX/integer
schema. Two missing registered worktrees retain unknown live counts and were not
pruned. The primary conflicted checkout still has 34 unresolved paths and 8,013
untracked paths; its exact raw status digest matches the earlier observation.

This is partial global chat coverage and sequential observation, not a writer
freeze or source backup. All checkout preservation labels remain unverified;
closure eligibility is not assessed. No chats or worktrees were archived, deleted
or cleaned by this trial. Live model execution, independent human consent,
simultaneous provider workers, broader workspace reconciliation and business
completion require their own evidence.
