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

## Remaining release gates

### 1. Stable operator lifecycle

Provide `configure`, `start`, `status`, `stop`, and `doctor` commands around the
artifact. Store the selected profile, PID, port, URL, logs, and task state under
the Temari data directory. A repeated start must converge on one healthy local
instance, and restart must preserve the task ledger.

### 2. Project profile materialization

Replace hand-written feature-specific control JSON with a versioned project
profile. The profile pins the project root, preparation and evidence roots,
Codex executable and model selection, workflow assets, ownership scopes, and
verification commands. Validate every path and executable at configuration time
and report missing capabilities through `doctor`.

### 3. Coordinator closeout

Add the coordinator action that selects the reviewed integration candidate,
checks that its retained hashes and protected verification still match, applies
it to the intended project checkout, and records the resulting task handoff or
acceptance. Keep publication and destructive source operations outside automatic
worker authority.

### 4. Release proof

Build the artifact from a clean checkout and run an end-to-end local journey:
configure a disposable project, start the dashboard, submit a small goal, allow
planning and implementation to finish, review and apply the exact candidate,
restart the service, and confirm the task and evidence remain available. Retain
the build digest, profile, candidate receipt, checks, and restart observation.

## Deferred work

- Wispr Flow and the protected Talk transport adapter
- Windows packaging and multi-host distribution
- provider budget telemetry
- public unattended service installation
- arbitrary multi-wave product programs
