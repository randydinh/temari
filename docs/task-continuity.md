# Task continuity and the local inbox

Temari keeps a durable task above individual execution runs. Return to the same
goal after a new chat, restart, failed attempt, or replan, with its next action and
history intact. Archon remains the native execution and log owner.

This guide is for the agent operating a local Temari checkout. It implements the
[approved first increment](system-roles-and-responsibilities.md#final-recommendation-and-first-proof).
The browser is a read-only inbox; the agent uses the task CLI or runtime API to
record work. Automatic capture of every chat, a conversational web frontend,
schedules, and the Registrar graph view remain follow-up work.

## Current continuation: host pickup and handoff

Main through `8e3ddc4` was integrated on 2026-09-30. Its knowledge and privacy
decisions are assessed in the [compatibility review](../evaluations/task-continuity/main-compatibility-2026-09-30.md).
The host entry increment connects conversations to durable tasks without
changing the native executor or knowledge authority.

The journey is to discover retained tasks in the selected workspace,
explicitly attach the current host conversation to a task, and save a bounded
handoff with its next action. One conversation may coordinate multiple goals;
one goal may span multiple conversations. Ambiguous pickup returns choices.
A pickup brief is context for the agent, not execution permission or completion
evidence. The browser exposes the same brief read-only.

The API preserves old ledgers and uses the same version/idempotency checks for
entry and handoff. Pickup scopes task discovery before reading selected evidence.
It returns choices when several tasks match, even with a choice limit of one.
It does not execute a workflow, query Registrar, read credentials, or call a model.
This is source-workspace integration. The
knowledge journey remains ahead of plugin packaging, as decided on main.

## Start or pick up a task

Run commands from a checkout with `pnpm install` completed. A fresh session should
discover retained work before creating a task. Reuse a matching task; give a replan a
new run ID under that task.

```sh
pnpm exec nx run runtime:tasks -- pickup --workspace /absolute/path/to/temari
pnpm exec nx run runtime:tasks -- pickup --task YOUR_TASK_ID
```

Storage defaults to `TEMARI_TASK_ROOT`, or `tasks` under the platform's Temari
data directory. On macOS the default is
`~/Library/Application Support/Temari/tasks`. All commands also accept
`--root /absolute/task-store`. Use one root consistently across sessions. This
is a local file store, not a shared network database.

If no store exists yet, save a command file such as `/absolute/create-task.json`:

```json
{
  "taskId": "dashboard-buildout",
  "title": "Build the Temari task dashboard",
  "goal": "Return to unfinished work without searching through chats.",
  "workspaceRoot": "/absolute/path/to/temari",
  "actor": "temari-coordinator",
  "idempotencyKey": "create-dashboard-buildout"
}
```

Then create the task and open its inbox:

```sh
pnpm exec nx run runtime:tasks -- create --input /absolute/create-task.json
pnpm exec nx run runtime:tasks -- serve --port 3092 --archon-url http://127.0.0.1:3091
```

Open <http://127.0.0.1:3092>. Stop the server with Ctrl-C; the task remains on disk.
Configure `--archon-url` for the console instance that owns the linked runs.
The view listens on loopback, has no mutation endpoints, and refreshes every ten
seconds while visible. A refresh failure leaves the prior view visible with an
error. The browser refresh reads persisted observations; it does not poll Archon
or start work.

### Connect the current chat and leave a handoff

Use the real host and conversation identity supplied by the host. This reference
does not read the conversation or give the task control over it. Save an entry
command as `/absolute/enter-task.json`:

```json
{
  "taskId": "dashboard-buildout",
  "actor": "temari-coordinator",
  "idempotencyKey": "enter-dashboard-chat-1",
  "expectedVersion": 1,
  "session": { "host": "codex", "sessionId": "ACTUAL_CHAT_ID" }
}
```

```sh
pnpm exec nx run runtime:tasks -- enter --input /absolute/enter-task.json
pnpm exec nx run runtime:tasks -- pickup --workspace /absolute/path/to/temari --host codex --session ACTUAL_CHAT_ID
```

For a new task, `enter` can create and link it in a single write: use
`expectedVersion: 0` and add `create: {title, goal, workspaceRoot}`. For an existing
task, omit `create` and use the version returned by pickup. The conversation
reference is many-to-many: entering a second goal does not detach the first.

Pickup returns `selected`, `choices`, or `empty`. It requires an exact `--task`
or an absolute `--workspace`; a paired `--host` and `--session` narrows either
scope. Workspace matching resolves filesystem aliases. All supplied filters must
match. Multiple matches always return choices; `--limit` controls only how many
are shown (1–50, default 20), with `hasMore` indicating omissions. Choice statuses
are stored hints, including `ACCEPTED_UNVERIFIED`; selected-task evidence is
rechecked before a brief can report `DONE`. Use `show` for complete retained
history and `list` for the full inbox.

Before leaving, save `/absolute/handoff-task.json` using the latest version:

```json
{
  "taskId": "dashboard-buildout",
  "actor": "temari-coordinator",
  "idempotencyKey": "handoff-candidate-review",
  "expectedVersion": 2,
  "handoff": {
    "summary": "The candidate implements task pickup and retains prior run history.",
    "decisions": ["Archon remains the replaceable native execution harness."],
    "nextAction": "Review the candidate and its retained verification results.",
    "blocker": null,
    "contextRefs": [
      { "kind": "design", "location": "/absolute/path/to/design.md" }
    ]
  }
}
```

```sh
pnpm exec nx run runtime:tasks -- handoff --input /absolute/handoff-task.json
```

The handoff updates the next action and blocker atomically. Its author, timestamp,
task version, and current run identity remain in history. Context references can
include an optional `sha256`; the task store does not open or verify them.
Handoff prose cannot accept a result or clear a pending native operation.

The brief includes the current run identity, refreshed evidence, latest handoff,
and 12 recent event summaries. It omits full dispatch inputs, native logs, and old
run details. Output is bounded to 128 KiB with explicit truncation and history
counts; use the full task/run views when more detail is needed. The browser's
**Continue in a chat** panel prepares the same brief. **Copy current brief**
rechecks it before copying; if clipboard access is unavailable, the text is
selected for manual copying. This is an explicit handoff, not automatic chat
interception or packaged host integration.

### Layout and everyday flow

- **Left inbox:** search, open/all/done filters, task title, next action, run count,
  and time of the latest retained event. Cancelled tasks stay in the open filter
  so the unfinished goal remains discoverable.
- **Task details:** goal, next action and blocker, followed by six workflow stages.
- **Continuation:** a brief for the next chat, plus the last handoff and decisions.
- **Runs:** immutable run/revision identity, native or receipt status, evidence
  completeness, unresolved controls, and a link to the original Archon run.
- **Evidence and delegation:** retained child outcomes and source/publication
  references. Source references identify locations; attaching one does not verify
  its contents or prove Registrar admission.
- **Activity:** timestamped actor, decisions, handoffs, observations, and controls.

The agent records a next action before leaving work. Save an update command using
the `version` returned by `show`:

```json
{
  "taskId": "dashboard-buildout",
  "actor": "temari-coordinator",
  "idempotencyKey": "await-candidate-review",
  "expectedVersion": 1,
  "nextAction": "Review the candidate and its verification results.",
  "blocker": null
}
```

```sh
pnpm exec nx run runtime:tasks -- update --input /absolute/update-task.json
```

Each mutation requires an actor and idempotency key. Repeating the same command
is safe; changing its payload under the same key is rejected. A stale version
requires reading current state and reconciling the new information before
issuing a new command. Native controls can record several events, so always
reload the returned version instead of assuming it increased by one.

## Bind execution and evidence

`bind` accepts a command envelope with a `run` object:

```text
taskId, actor, idempotencyKey, expectedVersion,
run: {
  runId, revision, plan,
  receiptRoot?, evidenceRoot?,
  sourceRefs?: [{ sourceId, publicationId, location }],
  childRefs?: [{ storeRoot, groupId }]
}
```

Use the admitted [`ExecutionPlan`](../libs/contracts/src/lib/execution-plan.ts),
the selected candidate revision, and absolute evidence paths. The plan must retain
all six canonical stages. Receipt and evidence roots are a pair. Bindings are
immutable; do not edit the ledger to point an old run at a new candidate.

Each Temari run and native run has one owner in the store. A new run stays under
the same task, retaining prior runs and resetting acceptance. An unresolved
dispatch/control, or a native run that has not reached a terminal state, prevents
replacement with another run.

The [native smoke test](../tools/task-native.test.mts) is an executable example
of binding an admitted local fixture plan, launching the canonical bridge,
discovering evidence, and accepting its narrow result. The CLI `start` launches
an existing Archon workflow; canonical bridge setup uses the harness
`startCanonical` API shown in that test. An arbitrary workflow is not guaranteed
to produce Temari stage evidence.

### Native controls

Commands `start`, `observe`, `reconcile`, `resume`, and `cancel` require
`--archon-home /absolute/archon-home`. This must be the instance owning the run.
The adapter verifies the pinned Archon 0.10.1 executable before issuing commands.
Use `--workflow-source /absolute/workflow-project` when starting from a separate
workflow definition directory; `--archon-cache` optionally overrides the binary
cache.

Task dispatch requires a harness with independent run-identity verification.
For Archon workflows, declare the optional reserved input below. Temari fills it
with the admitted run, revision, plan digest, workspace and harness identity;
callers must not supply or overwrite it. Existing direct harness launches remain
compatible, but untagged old runs cannot be adopted through task reconciliation.

```yaml
inputs:
  temari_binding:
    required: false
```

Every run command uses `taskId`, `runId`, `actor`, `idempotencyKey`, and
`expectedVersion`. Additional fields:

| Command     | Additional fields                      | Observable result                                                                 |
| ----------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `start`     | `entrypoint`, `inputs` (string values) | Intent is persisted before dispatch; an exact native reference is retained.       |
| `observe`   | None                                   | Records the bound native run's status.                                            |
| `reconcile` | `reference` (`HarnessRunRef`)          | Validates an exact reference after interrupted dispatch; never resolves `latest`. |
| `resume`    | None                                   | Resumes that same native run. Archon 0.10.1 requires at least one completed node. |
| `cancel`    | None                                   | Requests native cancellation; only observed `CANCELLED` confirms cancellation.    |

```sh
pnpm exec nx run runtime:tasks -- observe --input /absolute/observe.json --archon-home /absolute/archon-home
```

A crash between intent and result remains unresolved. Inspect Archon's actual run
record, including its Temari run ID, revision, plan digest and entrypoint, then
reconcile its exact reference. Never retry dispatch under a new task to hide the
uncertainty. An accepted local task cannot be resumed or cancelled.
Reconciliation verifies `metadata.inputs.temari_binding` and the native workflow
and working path before binding the recovered ID. A native status alone does not
establish ownership. If cancellation races normal completion, its intent resolves
as `finished-before-cancel` and preserves `SUCCEEDED` or `FAILED`; it does not
claim cancellation. Nonterminal observations keep the cancellation uncertain.

### Evidence and acceptance

Native output paths may become available only after dispatch. `link-evidence`
accepts the command envelope plus `runId`, `receiptRoot` and `evidenceRoot` and
attaches those paths once. For the canonical bridge, inspect the exact native
record's `output_root`; its bundle is under
`artifacts/runs/<native-run-id>/temari-nx-canonical`, with `receipts`, `evidence`,
and a `completion.json` identity marker.

`verify` reopens the canonical receipt and stage artifacts. Every task snapshot
also rechecks them, including plan, run, revision, ordering, hashes and child
outcomes. Missing or changed evidence prevents a completed task from remaining
`DONE`. `SUCCEEDED` in Archon alone is insufficient.

`accept` takes a command envelope, `runId` and a substantive `reason`. It supports
**local serial work only**, after verified stage evidence and coordinator review.
For a native-backed task, supply `--archon-home` so acceptance can recheck the
actual executor state. Pure local tasks do not require an Archon installation.
Plans requiring delegation, independent review, parallel execution, or forge
delivery need their route-specific closeout verifier. This increment shows their
evidence and review needs but does not mark them done. Actor strings provide
traceability inside a trusted local process; they are not authenticated identities
or a role permission system.

## Recovery

| Symptom                        | Inspect and recover                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store does not exist           | Confirm the configured root. Use `create` only for a new task/store.                                                                                                                                          |
| Missing or corrupt ledger      | Stop writers, preserve the directory, and restore a known-good backup. The inbox must show an error instead of reporting zero tasks.                                                                          |
| Version conflict               | `show` the task, reconcile current changes, then issue a new command with its current version.                                                                                                                |
| Dispatch/control uncertain     | Inspect the exact Archon run and reconcile or observe. A timeout is not proof that execution stopped.                                                                                                         |
| Ledger locked                  | Inspect `.tasks.lock/owner.json` for hostname, PID, start time and nonce. Confirm all writers on that host have stopped before manually removing the stale lock directory. No automatic lock takeover occurs. |
| Run opens in the wrong console | Correct `--archon-url` to match the owning `--archon-home`; the inbox does not move native logs between instances.                                                                                            |
| Native resume refused          | Check that the run has a completed node. Preserve the failed run; a new attempt needs a new run binding after confirmed termination.                                                                          |

Keep the whole task-store directory when backing up, together with referenced
receipt, evidence and child stores. The ledger is atomically replaced and bounded
to 32 MiB / 50,000 events. It is intended for a small local project; compaction,
multi-host access, and unattended service management are not part of this increment.
Do not put secrets in titles, goals, inputs, or notes; local task readers can see
these retained fields.

## Verification and current limits

The [2026-09-30 evaluation](../evaluations/task-continuity/README.md) records the
reviewed candidate, observed checks, retained logs, and proof boundaries.

```sh
pnpm exec nx run runtime:task-test
pnpm exec nx run runtime:task-typecheck
pnpm exec nx run runtime:task-native-test
```

| Check                       | What it establishes                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task store/runtime tests    | Fresh-session continuity, idempotency, stale writes, immutable identities, dispatch uncertainty, evidence invalidation, and retained sibling outcomes.                     |
| CLI process test            | Separate processes find the same task, next action, events and version.                                                                                                    |
| HTTP tests                  | Read-only methods, loopback host validation, safe static assets, missing task handling, and visible storage errors.                                                        |
| Native smoke on macOS arm64 | Pinned model-free Archon execution joins canonical evidence; exact-run resume preserves a completed node; cancellation is observed; a fresh task store reopens the result. |

The native checks consume no model calls. They do not prove Windows process
control, paid-provider budgets, a live two-agent Archon swarm, installed-plugin
chat capture, or full feature closeout. Those remain explicit follow-up gates.
The worker failure test projects existing durable child records; it does not
claim a new scheduler or native swarm implementation.

Next increments are host entry integration and route-specific closeout, then
bounded live parallel execution and limits, the pinned scheduler upgrade, and
the Registrar knowledge map. See the [roles matrix](system-roles-and-responsibilities.md)
for ownership and the full sequence.
