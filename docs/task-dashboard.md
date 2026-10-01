# Operate the local task dashboard

Use this guide to run the dashboard from a local Temari source checkout. It is
for the person configuring the workspace and reviewing its results. The
[continuity guide](task-continuity.md) covers CLI commands and agent handoffs.

## Choose the right journey

| Type of work                         | User flow                                                                                                                                      | Result                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **New goal for Temari**              | Enter a title and goal → **Save goal** → **Continue in a chat**.                                                                               | A durable goal awaiting a plan. Saving it does not start an agent.                              |
| **Configured verification recipe**   | Select a recipe → **Prepare verification** → **Start verification** → check execution → **Verify evidence** → **Accept result** with a reason. | A verified result for that recipe's fixed goal; eligible local serial work can become **Done**. |
| **Investigate with parallel agents** | Enter the investigation goal → choose agents and concurrent workers → **Prepare agents** → **Start agents**.                                   | Independent source-backed findings retained on one task for Temari to review.                   |

The investigation route is read-only. Asking it to implement a feature produces
investigation findings, not an implemented feature. A passing investigation
receipt does not satisfy canonical completion. Successful findings remain
**Needs review**, and the coordinator decides the next action.

## Before you begin

- Use the repository's supported Node/Bun environment and pnpm **11.25.0**.
  Complete `pnpm temari:init` and `pnpm temari:doctor` from the repository root.
  The source checkout's dependencies must be installed and `bun` must be on PATH.
- Select the root of a clean Git worktree. Verification and swarm preparation
  pin its HEAD; uncommitted or untracked changes prevent preparation/start.
  Save your work through the usual workflow before selecting that candidate.
- Keep the task store, preparation directory, control file, and Archon data
  outside the selected worktree. The preparation directory must already exist
  and must neither contain nor be contained by the worktree.
- For agents, supply an installed, authenticated Codex CLI executable.
  Starting agents makes model calls. This dashboard does not configure
  credentials or enforce a currency budget.
- Controlled mode currently requires an `--archon-home` even when using only
  goal intake or agents. Use the same Archon home as the console linked by
  `--archon-url`. The managed adapter verifies Archon **0.10.1**.

Run the commands below from the Temari repository root. Replace every
`/absolute/...` placeholder with a real absolute path. Locate executable paths
with `command -v git` and `command -v codex`; the JSON file does not expand shell
variables or `~`.

## Start the dashboard

### 1. Prepare local state

```sh
mkdir -p /absolute/dashboard-state/prepared /absolute/dashboard-state/archon
```

Reuse your existing task store if you have one. Controlled mode creates a new
store automatically when needed; no bootstrap task is required. Keep the same
`--root` on later starts so earlier tasks remain visible.

### 2. Save the control configuration

Save the following as `/absolute/dashboard-state/control.json`. This example
enables investigation agents and one model-free recipe that checks the selected
checkout. The recipe does not test application behavior. Replace its executable
paths with the absolute paths found above.

```json
{
  "schema": 1,
  "workspaceRoot": "/absolute/path/to/temari-next",
  "preparationRoot": "/absolute/dashboard-state/prepared",
  "recipes": [
    {
      "id": "check-clean-checkout",
      "title": "Verify the selected checkout",
      "goal": "Retain the selected Git revision and confirm its clean checkout remains unchanged during these checks.",
      "stages": {
        "investigate": {
          "executable": "/absolute/path/to/git",
          "args": ["rev-parse", "--show-toplevel"],
          "timeoutMs": 10000,
          "summary": "Recorded the selected repository root."
        },
        "plan": {
          "executable": "/absolute/path/to/git",
          "args": ["rev-parse", "--verify", "HEAD"],
          "timeoutMs": 10000,
          "summary": "Resolved the selected commit."
        },
        "build": {
          "executable": "/absolute/path/to/git",
          "args": ["diff", "--exit-code", "HEAD", "--"],
          "timeoutMs": 10000,
          "summary": "Checked for tracked changes against the selected commit."
        },
        "review": {
          "executable": "/absolute/path/to/git",
          "args": ["diff", "--check", "HEAD", "--"],
          "timeoutMs": 10000,
          "summary": "Checked the current diff for whitespace errors."
        },
        "verify": {
          "executable": "/absolute/path/to/git",
          "args": ["status", "--porcelain=v1", "--untracked-files=all"],
          "timeoutMs": 10000,
          "summary": "Recorded the checkout status."
        },
        "deliver": {
          "executable": "/absolute/path/to/git",
          "args": ["log", "-1", "--format=%H"],
          "timeoutMs": 10000,
          "summary": "Recorded the revision associated with the result."
        }
      }
    }
  ],
  "swarm": {
    "executable": "/absolute/path/to/codex",
    "maxConcurrency": 2,
    "maxWorkers": 2,
    "timeoutMs": 180000
  }
}
```

To offer only goal intake and agents, set `recipes` to `[]`. To disable agent
execution, omit `swarm`. Recipe goals and commands are selected by the host
configuration; the browser cannot supply shell commands or evidence paths.

### 3. Launch controlled mode

```sh
pnpm exec nx run runtime:tasks -- serve --root /absolute/dashboard-state/tasks --control-config /absolute/dashboard-state/control.json --archon-home /absolute/dashboard-state/archon --archon-url http://127.0.0.1:3091 --port 3092
```

Open <http://127.0.0.1:3092>. The server prints its URL, task root, and mode; the
browser shows **Local controls** and **New goal**. `--archon-url` is a link to
your existing console; this command does not start that console.

For a read-only inbox over an existing store, omit `--control-config` and the
native execution options:

```sh
pnpm exec nx run runtime:tasks -- serve --root /absolute/dashboard-state/tasks --port 3092
```

## Follow work and review results

The left column lists open tasks, with search and Open/All/Done filters. Select a
task to see its goal, next action, blockers, controls, runs, evidence and activity.
Use **Continue in a chat** to copy a refreshed continuation brief to Temari.

### Verification recipes

Preparation freezes the recipe, revision, and bridge identities. Starting retains
dispatch intent before requesting native execution. **Check execution** observes
the exact bound Archon run and discovers its retained artifacts. Early native
stage captures are progress, not a final canonical receipt.

When the run succeeds, **Verify evidence** checks the retained receipt/artifacts.
**Accept result** additionally requires a reason and eligible local serial
evidence. Archon success alone never means Done. Acceptance applies to the
recipe's fixed goal and recorded revision, not to an unrelated engineering goal.

Use **Resume run** only when offered for that exact failed native run. Archon
requires a completed node to resume. **Cancel run** requests cancellation;
observed termination confirms it. There is no Pause control.

### Investigation agents

The first agent traces implementation; the second independently challenges
assumptions. When enabled, a third examines verification coverage and a fourth
examines integration boundaries. All are required, read-only assignments. They
do not edit, publish, send messages or launch additional agents.

Choose 2–4 agents within the configured maximum. **Run at once** controls
concurrency within the host's limit. A setting of 1 runs the batch serially;
settings above 1 permit actual parallel processes.

The task retains each agent's status, attempt, findings and evidence. Process
stdout/stderr is retained when an attempt exits; the UI does not promise a live
token stream. Successful siblings are preserved during the runtime's bounded
mechanical retries. Semantic findings such as Issues or Blocked are not retried
as process failures.

**Cancel agents** records durable cancellation intent and asks the supervisor to
abort running processes. Partial findings remain available. Completion requires
observed worker outcomes; clicking Cancel does not instantly prove termination.
There is no general swarm Resume button or automatic takeover of a lost owner.

## Recover without duplicating work

Stopping or restarting the dashboard does not cancel detached native runs or the
swarm supervisor. Restart with the same task/preparation roots and configuration.
Use the explicit cancel action when you intend to stop execution.

| Symptom                             | Next action                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace changed since preparation | Preserve the existing result. Select a clean candidate and prepare a new task for that revision.                                                                            |
| Stale version or token error        | Refresh the task/page and inspect current state before issuing another action.                                                                                              |
| Native dispatch outcome uncertain   | Follow [exact-run reconciliation](task-continuity.md#native-controls); never launch a replacement merely because the response was lost.                                     |
| Agent supervisor missing or stale   | Preserve its launch/identity records and child artifacts. Ask Temari to reconcile ownership; do not remove markers or start a duplicate supervisor.                         |
| Agent transport failed              | Inspect the retained attempt evidence. The runtime allows at most two mechanical attempts per child; an exhausted/terminal receipt is not reopened by pressing Start again. |
| Findings need review                | Give Temari the continuation brief and retained findings. Coordinator review determines the next plan; there is no parallel canonical acceptance shortcut.                  |
| Evidence changed or cannot be read  | Preserve the artifacts and investigate the reported mismatch. Do not overwrite evidence to regain a passing status.                                                         |

Back up the task root and the preparation root together, plus the owning Archon
data/artifacts. The task ledger references those records rather than copying them.

## Control configuration reference

The JSON schema is enforced by
[`validateDashboardConfig`](../tools/dashboard-controller.mts). Unknown fields
are rejected.

| Field                        | Accepted value                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                     | `1`                                                                                                                                           |
| `workspaceRoot`              | Existing absolute directory; execution requires a clean Git root.                                                                             |
| `preparationRoot`            | Existing absolute directory disjoint from the workspace.                                                                                      |
| `recipes`                    | Required array, 0–20 recipes. Each has unique `id`, `title`, `goal`, and `stages`.                                                            |
| `stages`                     | Exactly `investigate`, `plan`, `build`, `review`, `verify`, `deliver`. Each has `executable`, `args`, `timeoutMs`, `summary`.                 |
| Recipe `executable` / `args` | Existing absolute executable path and an array of argument strings. Commands run with the selected workspace as cwd, without a shell wrapper. |
| Recipe `timeoutMs`           | Integer 1–60,000 per stage. Combined stdout/stderr is bounded to 64 KiB per stage by the canonical bridge.                                    |
| `swarm`                      | Optional object with exactly `executable`, `maxConcurrency`, `maxWorkers`, `timeoutMs`.                                                       |
| Swarm `executable`           | Absolute path to the installed Codex executable.                                                                                              |
| Swarm `maxWorkers`           | Integer 2–4.                                                                                                                                  |
| Swarm `maxConcurrency`       | Integer 1–`maxWorkers`; browser selection cannot exceed this bound.                                                                           |
| Swarm `timeoutMs`            | Integer 1,000–1,800,000 per worker attempt.                                                                                                   |

Combined swarm stdout/stderr is bounded to 1 MiB per worker attempt. The runtime allows at most two
mechanical attempts per child; these are implementation limits, not additional
control-file fields. With four workers this permits at most eight attempts.
The timeout is per attempt, not a whole-task deadline or provider spend limit.

Use read-only recipe commands: the native bridge rejects checkout drift, and its
six-stage receipt proves only those configured checks. Keep any generated files
outside the selected checkout. Configuration changes apply on server restart;
existing preparations retain their original identities and are not rewritten.

## Scope and verification

The dashboard uses the existing runtime for execution ownership, durable child
state and acceptance. It adds no scheduler, unattended service manager, Registrar
map, budget telemetry, or autonomous implementation swarm. The investigation
transport is local Codex; Archon owns configured native verification workflows.

Consult the [retained evaluation](../evaluations/task-continuity/README.md) for
executed checks and their revision. This guide describes supported behavior; it
does not certify a live model run or cross-platform process-control proof.
