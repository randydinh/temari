# Retain engineering task continuity

Use task tracking when Temari has explicitly selected a durable task for an
engineering `start` or `resume`. Keep the actual host conversation identity.
Resolve ambiguous task choices before launching; never infer a task from recency.
Tracking records context and progress. It does not admit a route or accept a result.

Append both flags to the existing trusted public entry command:

```sh
node /absolute/bundle/bin/temari.mjs start --request /absolute/request.json --expected-request-sha256 REQUEST_SHA256 --expected-manifest-sha256 BUNDLE_SHA256 --task-tracking /absolute/tracking.json --expected-task-tracking-sha256 TRACKING_SHA256
```

The same pair works with `poteto-mode.mjs` and engineering `resume`. Select the
tracking file digest independently of that file. Keep tracking outside the
execution request; its original digest and admission obligations remain intact.
Tracking flags are unsupported on QA, `run-workers`, `admit`, policy and closeout.

## Select the task

For lightweight engineering, use this sidecar:

```json
{
  "schemaVersion": 1,
  "taskRoot": "/absolute/tasks",
  "taskId": "selected-goal",
  "actor": "temari-coordinator",
  "session": { "host": "codex", "sessionId": "ACTUAL_CHAT_ID" },
  "expectedVersion": 0,
  "idempotencyKey": "selected-attempt",
  "create": {
    "title": "Continue the selected goal",
    "goal": "Keep the goal, recovery point and evidence together.",
    "workspaceRoot": "/absolute/candidate"
  },
  "expected": {
    "runId": "selected-run",
    "revision": "selected-revision",
    "runDirectory": "/absolute/new-run",
    "candidateRoot": "/absolute/candidate"
  }
}
```

For an existing task, omit `create` and supply its current version. Existing tasks
must have no canonical run history or acceptance; use their established run
controls and trusted closeout otherwise. Task paths must resolve to the selected
scope. The task store must be outside the bundle, candidate, run directory and
feature worker evidence directory. A new task store's parent must already exist.

For full feature engineering, use **schemaVersion 2** and replace `expected` with:

```json
{
  "runId": "selected-run",
  "revision": "selected-revision",
  "runDirectory": "/absolute/new-run",
  "sourceCandidateRoot": "/absolute/original-project",
  "requestSha256": "TRUSTED_PUBLIC_REQUEST_SHA256",
  "manifestSha256": "TRUSTED_BUNDLE_MANIFEST_SHA256"
}
```

Use the original project as the task workspace. The feature host separately
verifies the relationship to the workers' integration checkout. The public entry
records the starting handoff before workers launch. The canonical host reuses
that task entry and starting handoff. Do not substitute the integration checkout
into the sidecar or claim that worker success completes the task.

## Resume and recover

- Lightweight runs pin the task beside their canonical run. Feature runs pin it
  at `<featureWorkers.evidenceRoot>/<runId>-task-binding.json`, before preparation.
  Preserve the binding and referenced evidence. Omitted tracking and changing the
  selected task are refused.
- Completion or a caught execution/preparation failure saves an outcome handoff
  automatically. A hard kill or abrupt transport loss preserves the latest durable
  handoff, which may still be the starting handoff. Read the task's current
  version, checkpoint and evidence before choosing the next action.
- A fresh chat uses the same task with a new idempotency key, the current version
  and its actual conversation identity. An unfinished identical canonical run can
  reuse its original sidecar on `resume` when no outcome or concurrent progress
  has been recorded.
- A tracked feature `start` reserves preparation exclusively. A duplicate start
  refuses before forge or workers, even with identical tracking. A crash after
  reservation but before the initial task handoff does not release that reservation.
  Inspect the binding and worker evidence; use canonical `resume` only if its
  checkpoint exists, otherwise select a new run and evidence scope.
- A feature preparation failure may occur before a canonical run exists. Inspect
  worker evidence and use the existing recovery rules; do not invent a checkpoint
  or relaunch workers automatically. A completed or partial preparation may need
  a new run and new evidence scope.
- A concurrent task edit prevents a late handoff from overwriting it. Preserve
  any completed receipt and reconcile the task context; do not rerun completed
  work just to repair bookkeeping.

Host receipts remain `candidate-stage-evidence-v1` context references pending
trusted closeout. A host `PASS` does not bind a `TaskRun`, accept the task, or make
it `DONE`. The installed closeout command still requires its independently
selected current candidate. Tracking does not intercept unrelated chats or
provide task discovery commands within this bundle.
