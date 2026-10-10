# Temari dashboard local release

## Release outcome

Ship the dashboard as a local macOS control surface for Temari. One main Codex
conversation coordinates the work. Planning, implementation, review, and
observation run behind the dashboard without requiring the operator to manage
worker conversations.

The first release is complete when a clean machine can install one artifact,
select a project profile, start the loopback dashboard, recover its durable state
after restart, execute the reviewed local candidate route, and close out the
exact accepted candidate.

The Talk transport adapter is deferred until the Wispr Flow investigation. It is
not a release dependency.

## Current foundation

- The durable task model, dashboard controls, planning, isolated implementers,
  independent review, protected checks, managed observation, and exact-run
  resume exist in the Nx workspace.
- The real Codex-host feature journey passed and the single-chat managed route
  was merged in PR 225.
- `dashboard:build` now produces a bundled Node artifact with its browser assets
  and owned-process helpers. A smoke run proved the artifact can read a durable
  task store and serve both the UI and task API outside the source command path.

## Completed release gates

### 1. Stable operator lifecycle

The artifact provides `configure`, `start`, `status`, `stop`, and `doctor`
commands. It stores the selected profile, PID, port, URL, logs, and task state under
the Temari data directory. A repeated start must converge on one healthy local
instance, and restart must preserve the task ledger.

### 2. Project profile materialization

The versioned project profile replaces hand-written feature-specific control
JSON. The profile pins the project root, preparation and evidence roots,
Codex executable and model selection, workflow assets, ownership scopes, and
verification commands. Validate every path and executable at configuration time
and report missing capabilities through `doctor`.

### 3. Coordinator closeout

The coordinator `apply --task` action selects the reviewed integration candidate,
checks that its retained hashes and protected verification still match, applies
it to the intended project checkout, and records the resulting task handoff or
acceptance. Keep publication and destructive source operations outside automatic
worker authority.

### 4. Release proof

`dashboard:release-smoke` builds and relocates the artifact, configures a
disposable project, starts the dashboard, submits a small goal through a
deterministic Codex transport, runs the real native managed workflow, restarts
the service while that workflow is active, recovers its reviewed result, refuses
a dirty source checkout, applies the exact candidate, and verifies idempotent
closeout. The command and operator contract are in
[the local release guide](../dashboard-local-release.md).

## Deferred work

- Wispr Flow and the protected Talk transport adapter
- Windows packaging and multi-host distribution
- provider budget telemetry
- public unattended service installation
- arbitrary multi-wave product programs
