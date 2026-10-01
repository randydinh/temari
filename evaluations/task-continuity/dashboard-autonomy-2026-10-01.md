# Dashboard planning, scheduling and Registrar map: local verification

Verified on 2026-10-01, macOS arm64. Feature implementation was committed at
`7ae31d50b8f0af063e37a74b79c1f4717701364c`; the final refresh and schedule-control
fixes are committed at `4918f09`. The live planner/coding journey used the former;
the final schedule controls and response comparison used working-tree changes
later committed at `4918f09`. The final integration/type gates cover those changes.
This follows the [overnight contract](../../docs/dashboard-overnight-contract.md)
and its append-only `.audit/dashboard-overnight.tsv` decision trail.

## Delivered journeys

| View | Implemented behavior | Authority and limits |
| --- | --- | --- |
| Tasks | Natural goal → retained structured proposal → review ownership and checks → prepare isolated implementation → parallel coding → combined verification → independent review | One logical task; 2–4 disjoint host-admitted slots. Fixed host checks, path scopes and reviewer cannot be replaced by model output. Coding leaves a separate candidate for coordinator review. |
| Schedules | Once or recurring fixed checks; UTC anchor, due history, pause/resume/cancel, missed-slot coalescing, overlap prevention and restart reconciliation | Runtime owns the durable clock ledger. Dispatch runs while the dashboard server is online; there is no OS wake or recurring coding authorization. |
| Knowledge map | Pinned source/publication/path/document/graph nodes; selectable relationships with anchors and qualifiers; bounded expansion and explicit gaps | Registrar archive and graph readers remain the source boundary. Read-only metadata projections do not establish current-original or visual/semantic truth. |

Configuration and recovery are documented in the
[operator guide](../../docs/dashboard-autonomy.md). README links that guide, this
record, the [role matrix](../../docs/system-roles-and-responsibilities.md) and the
existing [coding design](../../docs/dashboard-implementation-design.md).

## Executed gates

| Nx target/check | Result | Retained evidence |
| --- | --- | --- |
| `runtime:dashboard-planner-test` | 24 passed; no failures/skips | [Planner subprocess regressions](2026-10-01-dashboard-autonomy/planner-tests.log) |
| `runtime:dashboard-schedule-test` | 23 passed; no failures/skips | [Schedule ledger and adapter checks](2026-10-01-dashboard-autonomy/schedule-tests.log) |
| `runtime:knowledge-map-test` | 12 passed against the actual bundled Registrar adapter; no skips | [Registrar map checks](2026-10-01-dashboard-autonomy/knowledge-tests.log) |
| `runtime:task-test` | 65 passed after final source changes; no failures/skips | [Integrated task, controller and HTTP checks](2026-10-01-dashboard-autonomy/task-integration.log) |
| `runtime:task-typecheck` | Passed after final source changes | [Strict typecheck](2026-10-01-dashboard-autonomy/typecheck.log) |
| Browser JS / Git whitespace | Both browser scripts passed `node --check`; `git diff --check` passed | Coordinator execution; final source review |

Suite counts overlap and are not a unique-case total. Logs have ANSI and trailing
whitespace removed. [Retained file metadata](2026-10-01-dashboard-autonomy/retained-files.json)
binds copied structured proofs to their original locations and hashes.

The failure checks cover malformed/injected/out-of-scope proposals, stale policy
and candidate pins, duplicate Start, published-preparation crash recovery using a
fresh browser request ID, planner supervisor loss without a duplicate model call,
schedule crashes around create/start, uncertain native ownership, clock rollback,
overlap, revoked publications, catalog bounds, graph qualifiers and protected
HTTP mutation routes. The final control regression permits only occurrence
telemetry to advance after a browser snapshot; intervening pause/resume/cancel
decisions and future versions remain conflicts.

## Actual goal planning and parallel implementation

The browser entered a new natural goal in a clean, dependency-free Git fixture
at `8361c0aca326ffbbb9bc8eb55661590f31dcfb7a`. Existing behavior tests failed before
implementation. This is test code, not the user's application.

- Task `task-d86b70e0-2f54-499a-bb14-4678f53ed10e` retained the original goal through
  planning and implementation.
- Actual authenticated Codex planner process **54931** ran in read-only mode for
  **24.245 seconds**, returned a schema-validated proposal and drained normally.
  Proposal SHA-256 is
  `5550b0f568a1bd90e7c7436f1d1e8dc3120d0c32a1dca1f39587720140690416`.
- The browser inspected the assignments and clicked **Prepare this plan**, then
  **Start implementers**. `numbers` owned only `numbers.mjs`; `labels` owned only
  `labels.mjs`. Actual processes **69153** and **69152** overlapped **14.268 seconds**.
- Each owned behavior check passed. The host combined both patches and passed the
  two existing behavior tests. The clean external integration commit was
  `d228f708806a83e3241d132870094e6d92984d07`.
- Distinct reviewer process **71219** inspected that exact commit and returned
  PASS with source references. The browser showed the same commit, both worker
  successes, combined verification and independent review. Task status remained
  **NEEDS_REVIEW**; the original source remained clean at its unchanged base.

See [planner evidence](2026-10-01-dashboard-autonomy/planner-result-proof.json),
[coding, patches and verification](2026-10-01-dashboard-autonomy/coding-result-proof.json)
and the [consolidated live proof](2026-10-01-dashboard-autonomy/live-proof-summary.json).
The [retained process records](2026-10-01-dashboard-autonomy/coding-processes.json)
include actual child PIDs and timestamps used for the overlap calculation.

## Restart while planning was active

A second browser goal, `task-8878cdab-f9cf-44de-884d-3837891abc81`, started actual
Codex process **28347** under supervisor **28278**. While both were alive, the
fixture dashboard listener restarted from **77262** to **28612**. The restarted
dashboard recovered the same launch nonce, manifest, immutable model intent,
supervisor and child PID. Planning reached **READY** with no second launch.

The [active restart proof](2026-10-01-dashboard-autonomy/active-planner-restart-proof.json)
supports listener-restart continuity. It does not establish host reboot recovery
or automatic relaunch after uncertain supervisor/model ownership. The prior
completed-coding restart is separate; it was not mislabeled as an active reviewer
restart.

## Actual scheduled native checks and controls

The browser created a one-minute recurring check anchored at 08:22 UTC and a
separate once check due at 08:35 UTC. The first recurring occurrence coalesced two
older slots. Each due occurrence retained deterministic occurrence, task and start
identities. Actual Archon runs completed successfully, while tasks remained
**NEEDS_REVIEW** and retained no coordinator acceptance.

The browser paused recurrence. A listener restart with the final source preserved
all **11** existing recurring occurrences and the single once occurrence without
redispatch or identity changes. The browser then resumed recurrence: the current
08:37 UTC occurrence coalesced two missed slots and completed. Both fixture
schedules were cancelled through the UI after verification. In total, **13**
scheduled native runs reached **SUCCEEDED**; no recurring test work remains active.

See [restart identity comparison](2026-10-01-dashboard-autonomy/schedule-restart-proof.json)
and [schedule controls, history and exact native snapshots](2026-10-01-dashboard-autonomy/schedule-live-proof.json).
Crash/overlap/rollback behavior beyond this small live journey is covered by the
focused regressions, not claimed as a separate live journey.

An observed Pause conflict originally came from a real STARTING→TERMINAL
transition, not repeated writes of unchanged observations. The final store
tolerates only telemetry drift, and the UI reloads schedule state after conflicts
and waits for writable control readiness. The no-op observation regressions also
confirm that polling does not grow unchanged history.

## Registrar map and browser evidence

The live fixture used an actual bundled Python 3.12 Registrar archive/graph
adapter and **synthetic documents**. The configured publication was pinned to
SHA-256 `951a2965157bd89cb8e47e01693930c9ad297167e8912509a506d966097394a8`,
generation `ce74e9fbc45b45248a482a0c8a3de050`. A later generation and source change
did not silently replace it.

The browser showed **16 nodes and 23 edges**, three retained documents, directory
paths, supported graph records and explicit extraction gaps. Selecting
`docs/map.md` showed pinned generation and manifest identity. Opening an anchored
support relationship showed its historical/inferred qualifiers and supporting
Unicode span. The map did not present directory entries as document contents or
unsupported visual extraction as resolved knowledge.

See the [synthetic Registrar configuration proof](2026-10-01-dashboard-autonomy/knowledge-live-proof.json)
and [browser observations/screenshots](2026-10-01-dashboard-autonomy/browser-proof.json).
The primary dashboard deliberately says **not configured** for knowledge until
the user's Registrar workspace/publication and graph pins are selected. This
proves the implemented adapter and UI, not connection to the user's actual content.

## Refresh performance and local activation

Serial task projections took **12.920 seconds** with 13 fixture tasks. The final
controller projects at most four tasks concurrently and shares one workspace
candidate read within that refresh. It still checks every retained native artifact
and completion binding. The measured response was **3.788 seconds** with 14 tasks;
every previously present task action, candidate flag and issue was unchanged.
This is one local comparison, not a load-test claim. See
[before](2026-10-01-dashboard-autonomy/dashboard-before-performance.json) and
[after](2026-10-01-dashboard-autonomy/dashboard-after-performance.json).

The primary dashboard address is [localhost:3092](http://127.0.0.1:3092). Its planning
policy admits the existing dashboard UI and operator-guide scopes; other
engineering scopes need a separately prepared host policy. Scheduling is enabled
without creating primary recurring work. Existing tasks and the pinned Archon
0.10.1 service are preserved. Use the broad task `temari-task-dashboard` handoff
for final activation provenance: the final clean source commit and local
activation metadata. Activation and that handoff are the last closeout operations.

## Independent review and limits

A different model family independently reviewed the new source, recovery fixes,
schedule control drift rule, bounded refresh work and retained planner/coding
proofs. Final disposition: **no actionable source findings**. The reviewer
distinguished artifact-supported claims from browser/native/map observations and
did not claim to have independently rerun root's commands.

All three requested capabilities are implemented and locally verified. Remaining
configuration is the user's Registrar publication/graph selection. Automatic chat
capture, OS/service supervision, general dependent coding waves, provider spending
limits and source publication are separate capabilities. A recurring autonomous
editing heartbeat remains pending explicit scope/cadence approval after automatic
approval review rejected its creation; no replacement automation was installed.
There is no trusted packaged `feature-v1` closeout or canonical DONE receipt from
this local build. Bundled skills/playbooks and the installed plugin were not changed.
