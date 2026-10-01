# Main compatibility assessment, 2026-09-30

Compared dashboard commit `63485d8` (based on `a2d33b9`) with current main
`8e3ddc4`. Main merged without text conflicts at `62093e8`. Reviewed the incoming
September 30 changes and the September 29 decisions already present in the base.
The original checkout's unfinished work was not changed.

## Decisions and implementation impact

| Main decision / source                                                                                                                              | Required dashboard behavior                                                                                                                                                                                   | Assessment                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Registered-source Jev policy](../../libs/knowledge/src/lib/archive-journey.ts), #108/#114                                                          | New archive intake handoffs allow bounded registered-source excerpts unless local-only or opted out. Old archive intake handoffs retain explicit per-case approval. Keychain lookup follows the sharing gate. | Task source references do not grant disclosure or invoke Jev. Aligned the two stale roles-matrix statements with the pinned archive intake policy.                                          |
| [Sealed retrieval gate](../../docs/evidence/knowledge-system/retrieval-gate-2026-09-30.md), #115                                                    | Exact remains the default; BM25/graph results are candidates. `coverage-blocked` cannot be shown as a passed quality gate.                                                                                    | Task acceptance only verifies its explicitly supported local stage route. Source links are not retrieval proof. Future map/status views must preserve coverage gaps and advisory judgments. |
| [Anchored graph imports and retraction](../../libs/knowledge/JOURNEY.md), #106/#107/#112                                                            | Registrar owns generations; Nx/Graft artifacts are admitted navigation. Call-name candidates are not runtime-call proof. Retraction requires operator review and preserves parent history.                    | Reuse publication/graph IDs; do not copy graph authority into the task ledger. Roles matrix now reflects implemented bounded imports.                                                       |
| [Optional OCR and real pilot](../../docs/evidence/knowledge-system/real-corpus-pilot-2026-09-30.md), #109/#111/#113                                 | OCR is opt-in transcription with gaps; PDF memory-boundary failure remains explicit.                                                                                                                          | No extraction or interpretation claims arise from attaching a task source reference.                                                                                                        |
| [Privacy suggestions](../../docs/privacy-learning.md), #103                                                                                         | Local explicit decisions may suggest policy; suggestions do not activate rules or authorize transcript export.                                                                                                | Pickup/handoff stays local and bounded. No automatic transcript harvesting or provider calls.                                                                                               |
| [Live host doctor](../../libs/host-adapters/src/lib/live-doctor.ts), #104                                                                           | Installation preflight proves only observed capabilities; it cannot admit a full feature route or grant forge/parallelism.                                                                                    | No doctor probe runs when opening the inbox or picking up work; host identity is traceability, not permission.                                                                              |
| pnpm upgrade, `ae8ac86`                                                                                                                             | Use pinned pnpm 11.25.0 and main's lockfile.                                                                                                                                                                  | Isolated worktree dependencies refreshed with frozen lockfile.                                                                                                                              |
| [Knowledge before plugin packaging](../../docs/knowledge-system-design.md#delivery-decision-complete-the-knowledge-journey-before-plugin-packaging) | Complete admitted-source journey before packaging it as a plugin.                                                                                                                                             | Continue the source-workspace host/task interface; do not alter or republish bundled public entries.                                                                                        |

## Ownership check

Temari retains intent, route obligations and acceptance meaning. Poteto chooses
engineering method; runtime owns durable mechanics; Archon remains replaceable.
The local P-stack audit index/graph in the original checkout was consulted for
session-pickup, pause-safely and Orchestrate relationships. It is not present on
the fetched main; its recommended ownership moves were treated as proposals,
not as shipped authority. No legacy Orchestrate store was adopted.

## Implemented continuation increment

Added host conversation references and structured handoff events to the existing
task ledger, plus bounded pickup through runtime/CLI and the read-only inbox.
Explicit task selection and optimistic versions protect concurrent sessions.
One conversation can coordinate several goals. An ambiguous pickup returns
choices. Host links and handoff prose remain context, never capability proof,
Registrar admission, stage evidence or permission to resume native execution.

The new `enter`, `pickup`, and `handoff` commands work from the source workspace.
README and AGENTS link the operating guide and explain explicit task selection.
The read-only browser prepares and copies the selected task's continuation brief.
An unchanged refresh preserves that panel and its copy feedback.

The initial native regression failed because Node's inherited PATH did not
include the installed Bun. The native fixture now resolves and validates Bun
from PATH or standard local installation paths. Both real Archon tests then
passed without changing execution behavior.

## Verification and review

Implementation candidate: `c8386625a3d0b9651c7014e3955065120e897a66`.
Reviewed correction: `8070596c0a35f9038bd027c907b6ee3341341e3c`.
Executed on macOS arm64 with the pinned pnpm 11.25.0.

| Check                                     | Result                                                                                                                         | Evidence                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `runtime:test`                            | 257 passed, no failures or skips, on the implementation candidate                                                              | [Retained output](2026-09-30-host-pickup/runtime-test.log)                              |
| `runtime:task-test`                       | 43 passed after the narrow review correction                                                                                   | [Retained output](2026-09-30-host-pickup/task-checks.log)                               |
| `runtime:task-typecheck` and dependencies | Passed after the correction                                                                                                    | Same retained focused output; three unchanged dependencies used local cache             |
| `runtime:task-native-test`                | Both real Archon tests passed after fixing the fixture's Bun discovery                                                         | Scoped builder execution report; [executable fixture](../../tools/task-native.test.mts) |
| Browser                                   | Retained real task, linked chat, saved handoff, prepared brief, copy confirmation, and unchanged-refresh preservation verified | In-app browser at 1280×720, loopback port 3092; no warning/error logs observed          |

These suites overlap; counts are not additive. Native tests use isolated local
homes and no model calls. The full runtime suite preceded the final narrow path
filter correction; the focused suite covers that correction and the new CLI/HTTP
journey. No additional broad regression was needed for that change.

The independent reviewer reproduced one issue on `c838662`: an unrelated retained
workspace resolving through a file could abort pickup in a healthy workspace.
The correction excludes unavailable historical roots (missing, no longer a
directory, symlink loop, or inaccessible) while keeping errors for the requested
root and unexpected I/O visible. Tests cover recovery and exact-ID access.
Independent re-review of `8070596` reported **resolved, no residual finding**.
The reviewer used source/test inspection and a focused filesystem reproduction;
the reviewer did not run the broad suites or browser checks.

The same review found no conflict with main's knowledge-sharing gate, retrieval
default, ownership boundaries, or packaging sequence. The matrix now names
**archive intake handoffs** explicitly where the knowledge-sharing policy
applies. Task handoffs remain context-only records.

## Remaining boundaries

This is a local source-workspace implementation, not automatic interception of
all host conversations or an installed plugin release. It does not add a model,
knowledge provider, scheduler, map, authentication layer, or second execution
service. The inbox remains read-only. Native status and handoff prose do not
establish canonical Temari completion. This evidence is not a trusted packaged
`feature-v1` PASS receipt. No new mobile or Windows execution claim is made.
