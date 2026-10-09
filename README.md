# Temari

Portable, host- and model-agnostic conversational engineering partner.

Temari builds on [P-stack](https://github.com/cursor/plugins/tree/main/pstack)
by Lauren Tan. See [credits and provenance](docs/credits.md) for the imported
workflow, Temari-owned platform, and other component boundaries.

This is the canonical Nx workspace (`randydinh/temari`). Legacy products
are `temari-v1` … `temari-v4.1`. See [docs/lineage.md](docs/lineage.md)
and [docs/architecture.md](docs/architecture.md).
Start with the [system roles and responsibilities matrix](docs/system-roles-and-responsibilities.md)
to see decision owners, worker roles, knowledge boundaries, current status, and
prioritized improvements. Then read the [platform overview](docs/platform-overview.md)
and [component guide](docs/platform-components.md) for the full design. Use the
[verification matrix](docs/verification-matrix.md) to trace claims to
implementation and retained evidence.

**Start with the [local dashboard guide](docs/task-dashboard.md)** to save goals,
plan bounded parallel implementation from a natural goal, launch investigation
agents, run coding agents in isolated clones, or execute verification checks. It covers setup, the UI flow,
cancellation, retained results, and recovery. The
[Talk to Temari guide](docs/dashboard-talk.md) describes a topic-separated
conversation front door, linked task status, attention and explicit task intake,
including transport setup and recovery. The
[implementation design and example](docs/dashboard-implementation-design.md)
explain ownership scopes, integration, independent review, and verification gates.
The [planning, scheduling and knowledge-map guide](docs/dashboard-autonomy.md)
covers retained goal proposals, durable recurring checks, pinned Registrar maps
and their recovery boundaries.
The [open-work review guide](docs/open-work-review.md) covers the read-only saved
inventory of chats/worktrees, local filters, coverage/freshness, independent
capture verification and preservation gaps before reconciliation.
The [reconciliation panel guide](docs/dashboard-reconciliation.md) covers complete
retained metadata review, current-binding checks, local interaction evidence and
recovery. Recorded intent does not merge, preserve, archive or accept work.
The [task continuity guide](docs/task-continuity.md) covers agent pickup, chat links,
handoffs, evidence, and exact-run Archon controls. Successful agent findings need
coordinator review; only eligible canonical evidence plus explicit acceptance can
mark a task done. The [boundary assessment](docs/system-roles-and-responsibilities.md#how-granular-are-the-boundaries-today)
distinguishes documented roles from implemented enforcement.
The [coding dashboard verification record](evaluations/task-continuity/dashboard-implementation-2026-10-01.md)
retains actual agent overlap, integration checks, independent review, and restart evidence.
The [planning, scheduling and map verification record](evaluations/task-continuity/dashboard-autonomy-2026-10-01.md)
records live goal planning, schedule dispatch and recovery, Registrar provenance,
browser journeys, and the remaining configuration limits.
The [workspace dashboard verification record](docs/evidence/2026-10-03-dashboard-workspaces-verification.md)
covers fixed workspace topics in one surface, unavailable captured titles, and
Knowledge refresh recovery. Source verification and activation are separate steps.

Temari owns user intent and route obligations. Poteto owns the engineering method;
the workflow runtime owns durable control and completion. The host (Cursor,
Codex, Claude, Hermes, or serial fallback) owns tools, models, and
credentials. Personal and OpConnect material is an overlay, not this
tree — [docs/overlays.md](docs/overlays.md).

## Agent starting points

- **Operate the dashboard:** [setup and supported journeys](docs/task-dashboard.md).
  Configure [Talk to Temari](docs/dashboard-talk.md) for separate topic histories,
  a shared composer and linked task observations. A host-selected workspace
  registry keeps each topic and its task links bound to the chosen workspace.
  Choose a saved goal, verification recipe, investigation swarm, configured
  implementation plan, or validated natural-goal proposal. Use Schedules for
  fixed recurring checks, Knowledge map for pinned Registrar paths/anchors, and
  Review open work for captured chats/worktrees with explicit coverage and
  preservation gaps. Coding produces an external integration candidate for
  coordinator review; it does not apply changes to the source checkout or publish them.
- **Pick up unfinished work:** [task continuity and recovery](docs/task-continuity.md).
  Use workspace-scoped `pickup` before creating work, explicitly `enter` the matching
  task with the current host conversation, and save a `handoff` before ending a session.
  When pickup returns choices, select the intended goal explicitly.
  For source host execution, the [tracked host entry](docs/migrations/host-session.md#track-the-host-journey-as-a-durable-task)
  saves recovery and outcome handoffs automatically around the existing stage dialogue.
  Rebuilt public bundles support [installed entry tracking](packages/workflow-runtime/public/skills/temari/references/task-tracking.md)
  for lightweight and feature engineering, including worker preparation failures.
- **Route a request:** [Temari coordinator and worker contracts](docs/system-roles-and-responsibilities.md#decision-and-control-owners),
  [one workflow](docs/workflow.md), and the packaged
  [Temari](packages/workflow-runtime/assets/v4.1/skills/temari/SKILL.md) and
  [Poteto](packages/workflow-runtime/assets/v4.1/skills/poteto-mode/SKILL.md)
  entries.
- **Use knowledge:** [archive admission and handoff](libs/knowledge/ARCHIVE.md),
  [intake-to-search journey](libs/knowledge/JOURNEY.md), and the
  [knowledge system design](docs/knowledge-system-design.md). Registrar owns
  source versions; Temari owns the task and its assessment.
- **Run or resume work:** [runtime ownership](docs/system-roles-and-responsibilities.md#decision-and-control-owners),
  [shared-control proof status](libs/shared-control/README.md), and the
  [Archon harness boundary](docs/platform-components.md#5-execution-harnesses-and-archon).
- **Review evidence:** [provenance and logs](docs/platform-components.md#7-provenance-logs-and-security)
  and the [verification matrix](docs/verification-matrix.md). Treat a
  procedural receipt, a source citation, and a product-behavior verdict as
  different claims.

## Layout

```text
libs/contracts         ExecutionPlan, capabilities, worker briefs
libs/workflow-engine   One engine; many plans
libs/host-adapters     Swappable host capability reports
libs/runtime           Receipt persistence and execution wrapper
packages/initializer   Cross-platform dependency bootstrap and doctor
docs/                  Architecture, decisions, workflow
overlays/              Placeholder only — local files are gitignored
```

## Commands

```sh
# Temari requires Node.js 22 or newer and pnpm 11.25.0.
pnpm --version

# Init bootstraps Bun and Archon, then doctor checks the result.
# Do not install Bun separately and do not add it to PATH.
pnpm temari:init
pnpm temari:doctor

# Development checks.
pnpm install
pnpm exec nx run-many -t typecheck
pnpm exec nx graph

# Shareable walkthrough.
pnpm nx run workflow-engine:demo

# Read-only task inbox over an existing store.
pnpm exec nx run runtime:tasks -- list
pnpm exec nx run runtime:tasks -- serve

# Enable local controls; creates the store if needed. Configure using the guide.
pnpm exec nx run runtime:tasks -- serve --control-config /absolute/dashboard-state/control.json --archon-home /absolute/dashboard-state/archon
```

The repository requires pnpm 11.25.0 (declared in `package.json`), which must
be installed before running the commands above. CI installs the same version.

`temari:init` is the OS-agnostic dependency entry point. It uses Node APIs
instead of shell-specific installers. On a clean machine it downloads pinned
Bun 1.4.2 into the user-local Temari cache before the other installs, then
installs the Nx workspace with the frozen pnpm lockfile, installs the packaged
Poteto runtime with that managed Bun, and writes an install receipt under the
platform's user-local Temari state directory. Doctor finds this Bun without a
`PATH` change. On supported architectures, initialization also downloads the
pinned Archon v0.10.1 executable into Temari's versioned user-local cache and
records its source, platform, and SHA-256 in the receipt. `pnpm temari:doctor`
stays read-only: a missing Bun or Archon exits 1 and prints `pnpm temari:init`. The
`@temari/archon-harness` adapter is selected through a replaceable harness port;
hosts and alternate harnesses can replace it without changing the workflow
engine. See the [harness decision](docs/decisions/2026-09-22-archon-harness.md)
for the current Windows and receipt-parity gates.

See the [initializer package README](packages/initializer/README.md) for the
manifest, receipt, and Windows/macOS behavior.

Do not connect Nx Cloud yet. Do not cache live host journeys.

## Workflow

One engine. Classification builds an `ExecutionPlan`; it does not fork
the lifecycle. Chart: [docs/workflow.md](docs/workflow.md).

Temari and Poteto use the bundled [QA verification writer](packages/workflow-runtime/public/skills/qa-review-verification/SKILL.md)
for ticket notes, evidence audits, and release QA reports. It provides compact and
detailed templates, preserves reviewer filters and evidence provenance, and retains
canonical QA dispositions. A draft does not admit a full QA execution route or
satisfy its independent review requirements. Changes to the writer have a versioned
[changelog](packages/workflow-runtime/public/skills/qa-review-verification/CHANGELOG.md)
and retained [trial records](evaluations/qa-review-verification/README.md).

For reported defects or uncertain QA failures, Temari and Poteto use the bundled
[QA Triage skill](packages/workflow-runtime/public/skills/qa-triage/SKILL.md), its
[ordered playbook](packages/workflow-runtime/public/skills/qa-triage/references/issue-triage-v1.md)
and compact analytical handoff. It separates evidence, causal confidence, impact
and next action. This is guidance, not a new executable profile or QA signoff;
the existing writer handles reports and Poteto handles authorized repair.

The [facilities uptime walkthrough](docs/demos/facilities-uptime.md) shows the
same engine applied to a synthetic hospital site-operations incident.
