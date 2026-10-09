# Operate the local task dashboard

Use this guide to run the dashboard from a local Temari source checkout. It is
for the person configuring the workspace and reviewing its results. The
[continuity guide](task-continuity.md) covers CLI commands and agent handoffs.

## Choose the right journey

For a conversational starting point, configure [Talk to Temari](dashboard-talk.md).
It keeps topic histories separate, shows linked task updates and saves explicitly
accepted task proposals. In schema1, when Talk and controlled mode select the same
canonical workspace and the host configures exactly one planning policy,
acceptance starts that bounded planner idempotently. Talk then shows at most one
admitted **Prepare plan** or **Start implementation** action on the linked card,
alongside that task's actual planning/implementation state and bounded controller
message. Legacy tasks make no planner-progress claim. Lost action responses are
never replayed. For implementation start, Talk needs both the exact retained
intent event and a controller state beyond `PREPARED`; it reports that observed
state rather than treating intent as successful launch. Otherwise the outcome
stays unresolved.
The model cannot select a route or command. Candidate review, acceptance, apply,
publication, merge, cancellation and closeout remain explicit task boundaries.
Schema2 registries and mismatched or ambiguous controller configurations keep
proposal acceptance save-only. The task journeys below provide execution and review.

| Type of work                         | User flow                                                                                                                                      | Result                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **New goal for Temari**              | Enter a title and goal → **Save goal** → **Continue in a chat**.                                                                               | A durable goal awaiting a plan. Saving it does not start an agent.                                                           |
| **Configured verification recipe**   | Select a recipe → **Prepare verification** → **Start verification** → check execution → **Verify evidence** → **Accept result** with a reason. | A verified result for that recipe's fixed goal; eligible local serial work can become **Done**.                              |
| **Investigate with parallel agents** | Enter the investigation goal → choose agents and concurrent workers → **Prepare agents** → **Start agents**.                                   | Independent source-backed findings retained on one task for Temari to review.                                                |
| **Configured implementation plan**   | Select a coding plan → enter the goal → review scopes/checks → **Prepare implementation** → **Start implementers**.                            | An external integration checkout and commit, verification results, and independent reviewer findings for coordinator review. |

The investigation route is read-only. Asking it to implement a feature produces
investigation findings, not an implemented feature. A passing investigation
receipt does not satisfy canonical completion. Successful findings remain
**Needs review**, and the coordinator decides the next action.

The implementation route runs 2–4 coding agents in separate local Git clones,
integrates their accepted patches, verifies the combined candidate, and sends
that exact commit to a separate read-only reviewer. It also ends at **Needs
review**. The source checkout stays unchanged; applying or publishing the result
requires a separate workflow. Start with the
[small coding-plan example](dashboard-implementation-design.md#configure-a-small-coding-plan).

Goal planning, once/recurring scheduling and the separate Registrar map are
covered in [the autonomy guide](dashboard-autonomy.md), including configuration,
recovery, ownership and honest evidence limits.

**Review open work** adds a read-only view of an explicit saved host capture of
chats and worktrees. Use its local search, captured activity labels, observed Git
counts and coverage gaps to locate unfinished work. Reload rereads the approved
capture; preservation and closure remain unverified. See the
[open-work review guide](open-work-review.md) for capture publication, independent
verification and discrepancy handling.

The [reconciliation panel](dashboard-reconciliation.md) on the same page reviews
host-selected retained plans, checks current bindings and records local
confirmation interaction evidence. It preserves blocked/history states and exact
request recovery; source operations and task acceptance remain separate workflows.

## Before you begin

- Use Node.js 22 or newer and pnpm **11.25.0**. From the repository root, run
  `pnpm temari:init` and then `pnpm temari:doctor`. Init installs managed Bun
  and Archon 0.10.1. Bun does not need to be on `PATH`.
- Select the root of a clean Git worktree. Verification and agent preparation
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

To offer only goal intake and agents, set `recipes` to `[]`. Omit `swarm` to
disable investigation agents and omit `implementation` to disable coding plans.
Recipe goals, coding ownership and commands come from the host configuration;
the browser cannot supply shell commands or evidence paths. The
[coding-plan example](dashboard-implementation-design.md#configure-a-small-coding-plan)
generates a complete configuration with `implementation` enabled.

### 3. Launch controlled mode

```sh
pnpm exec nx run runtime:tasks -- serve --root /absolute/dashboard-state/tasks --control-config /absolute/dashboard-state/control.json --archon-home /absolute/dashboard-state/archon --archon-url http://127.0.0.1:3091 --port 3092
```

Open <http://127.0.0.1:3092>. The server prints its URL, task root, and mode; the
browser shows **Local controls** and **New goal**. `--archon-url` is a link to
your existing console; this command does not start that console.

Archon 0.10.1 resolves its **Graph** view from the current workflow catalog.
When execution uses an external workflow source, install the same canonical YAML
in the dedicated `ARCHON_HOME/workflows/temari-nx-canonical.yaml` to make the graph
discoverable. For an existing run, copy its retained
`workflow-source/project/.archon/workflows/temari-nx-canonical.yaml` unchanged and
compare hashes first. Keep historical run captures as the evidence authority;
the graph uses the currently discoverable definition.

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
stdout/stderr is streamed in full to private files and retained when an attempt exits; the UI does not promise a live
token stream. Successful siblings are preserved during the runtime's bounded
mechanical retries. Semantic findings such as Issues or Blocked are not retried
as process failures.

**Cancel agents** records durable cancellation intent and asks the supervisor to
abort running processes. Partial findings remain available. Completion requires
observed worker outcomes; clicking Cancel does not instantly prove termination.
There is no general swarm Resume button or automatic takeover of a lost owner.

### Implementation agents

1. Choose a configured implementation plan in **New goal**. Enter the title and
   overall goal; the request adds context to the prepared assignments without
   expanding their allowed paths or actions.
2. Review the implementers' file/directory scopes, preparation and verification
   commands, and independent reviewer. Choose **Prepare implementation** to pin
   the resolved request and clean source revision.
3. Choose **Start implementers**. Follow worker outcomes, integration, verification
   and review in the task panel. Each implementer edits its own local clone.
4. Review the external integration path, commit, changed paths, verification logs
   and reviewer findings. Use **Continue in a chat** to ask Temari to assess the
   candidate and decide its next action.

The coordinator applies accepted patches to a separate integration clone in the
declared assignment order. An ownership violation, conflicting patch, failed
check, or changed candidate blocks progress. Verification must leave candidate
bytes, staged tree and HEAD unchanged. The read-only reviewer inspects the exact
clean integration commit after the checks pass.

This route allows one attempt per implementer and reviewer. It retains completed
results, but does not automatically retry coding or restart an ambiguous
supervisor. **Cancel implementation** requests cancellation and waits for observed
process drain; retained patches and logs remain available. It does not revert or
apply changes to the source checkout. There is no generic **Accept result**, Apply,
Push, or Publish action for implementation tasks.

## Recover without duplicating work

Stopping or restarting the dashboard does not cancel detached native runs or the
investigation/implementation supervisor. Restart with the same task/preparation roots and configuration.
Use the explicit cancel action when you intend to stop execution.

| Symptom                                   | Next action                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace changed since preparation       | Preserve the existing result. Select a clean candidate and prepare a new task for that revision.                                                                                 |
| Stale version or token error              | Refresh the task/page and inspect current state before issuing another action.                                                                                                   |
| Native dispatch outcome uncertain         | Follow [exact-run reconciliation](task-continuity.md#native-controls); never launch a replacement merely because the response was lost.                                          |
| Agent supervisor missing or stale         | Preserve its launch/identity records and child artifacts. Ask Temari to reconcile ownership; do not remove markers or start a duplicate supervisor.                              |
| Agent transport failed                    | Inspect the retained attempt evidence. Investigation allows at most two mechanical attempts per child; implementation allows one. Start does not reopen a terminal receipt.      |
| Integration or independent review blocked | Inspect the retained patches, verification logs and reviewer findings. Keep the original attempt; Temari must prepare a new plan/attempt rather than editing its pinned request. |
| Findings need review                      | Give Temari the continuation brief and retained findings. Coordinator review determines the next plan; there is no parallel canonical acceptance shortcut.                       |
| Evidence changed or cannot be read        | Preserve the artifacts and investigate the reported mismatch. Do not overwrite evidence to regain a passing status.                                                              |

Back up the task root and the preparation root together, plus the owning Archon
data/artifacts. The task ledger references those records rather than copying them.

## Control configuration reference

The JSON schema is enforced by
[`validateDashboardConfig`](../tools/dashboard-controller.mts). Unknown fields
are rejected.

| Field                                         | Accepted value                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`                                      | `1`                                                                                                                                              |
| `workspaceRoot`                               | Existing absolute directory; execution requires a clean Git root.                                                                                |
| `preparationRoot`                             | Existing absolute directory disjoint from the workspace.                                                                                         |
| `recipes`                                     | Required array, 0–20 recipes. Each has unique `id`, `title`, `goal`, and `stages`.                                                               |
| `stages`                                      | Exactly `investigate`, `plan`, `build`, `review`, `verify`, `deliver`. Each has `executable`, `args`, `timeoutMs`, `summary`.                    |
| Recipe `executable` / `args`                  | Existing absolute executable path and an array of argument strings. Commands run with the selected workspace as cwd, without a shell wrapper.    |
| Recipe `timeoutMs`                            | Integer 1–60,000 per stage. Combined stdout/stderr is bounded to 64 KiB per stage by the canonical bridge.                                       |
| `swarm`                                       | Optional object with exactly `executable`, `maxConcurrency`, `maxWorkers`, `timeoutMs`.                                                          |
| Swarm `executable`                            | Absolute path to the installed Codex executable.                                                                                                 |
| Swarm `maxWorkers`                            | Integer 2–4.                                                                                                                                     |
| Swarm `maxConcurrency`                        | Integer 1–`maxWorkers`; browser selection cannot exceed this bound.                                                                              |
| Swarm `timeoutMs`                             | Integer 1,000–1,800,000 per worker attempt.                                                                                                      |
| `implementation`                              | Optional object with exactly `executable`, `maxConcurrency`, `timeoutMs`, `plans`.                                                               |
| Implementation `executable`                   | Existing absolute path to the authenticated Codex CLI executable.                                                                                |
| Implementation `maxConcurrency` / `timeoutMs` | Concurrency 1–4, capped by plan implementer count; worker timeout 1,000–1,800,000 ms.                                                            |
| Implementation `plans`                        | 1–20 uniquely identified plans; each has `id`, `title`, `description`, `assignments`, `prepare`, `verify`, `reviewer`.                           |
| Plan `assignments`                            | 2–4 required implementers, each `{worker, owns}` with disjoint typed `{kind: "file" \| "directory", path}` scopes relative to the repository.    |
| Assignment `brief`                            | `goal`, `context`, `scope`, nonempty `acceptanceCriteria`, `verificationCommand: null`, `reportFormat: "json"`, and nonempty `forbiddenActions`. |
| Plan `reviewer`                               | Required reviewer assignment with a distinct ID and the same brief shape; it has no write scopes.                                                |
| Plan `prepare` / `verify`                     | Explicit arrays of at most 10 commands each; `prepare: []` is allowed, `verify` must be nonempty.                                                |
| Implementation command                        | Exactly `{program, args, timeoutMs}`. `program` is an existing absolute executable; `args` is a string array; timeout is 1–1,800,000 ms.         |

Swarm and implementation raw stdout/stderr have no retention byte cap. Full
private diagnostics remain available after nonzero exits, timeout and
cancellation; capture/archival failure is explicit. Dashboard inspection
verifies portable and linked artifact identities without loading raw logs into
browser summaries.

Prior failed-attempt references remain verifiable after retry. Ordinary failure
summaries expose a controlled message and hash, with full causes in private
evidence.

The runtime allows at most two mechanical attempts per child; these are implementation limits, not additional
control-file fields. With four workers this permits at most eight attempts.
The timeout is per attempt, not a whole-task deadline or provider spend limit.

Implementation uses one attempt per child: 2–4 implementer attempts followed by
one reviewer attempt if integration succeeds. These process limits do not replace
the configured command timeouts. See the
[implementation design](dashboard-implementation-design.md) for pinned evidence
and ownership requirements.

Use read-only recipe commands: the native bridge rejects checkout drift, and its
six-stage receipt proves only those configured checks. Keep any generated files
outside the selected checkout. Configuration changes apply on server restart;
existing preparations retain their original identities and are not rewritten.

## Scope and verification

The dashboard uses the existing runtime for execution ownership, durable child
state and acceptance. Configured investigation and implementation agents use local
Codex; Archon owns configured native verification workflows. [Bounded goal
planning, runtime schedules and the pinned Registrar map](dashboard-autonomy.md)
are now available through separate configured journeys. Arbitrary dependent coding
waves, unattended OS service management, provider budget telemetry, automatic
source application and automatic semantic feature closeout remain outside this
implementation.

The [dashboard verification record](../evaluations/task-continuity/dashboard-controls-2026-09-30.md)
retains actual macOS browser, native workflow and two-agent model evidence, with
their exact revisions. This does not establish cross-platform process-control proof.
That earlier investigation/native record is not a live implementation-route proof.
The [implementation verification scope](dashboard-implementation-design.md#verification-scope)
states the checks required for the new route; record observed results separately.
