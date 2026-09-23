# Temari

Portable, host- and model-agnostic conversational engineering partner.

This is the canonical Nx workspace (`randydinh/temari`). Legacy products
are `temari-v1` … `temari-v4.1`. See [docs/lineage.md](docs/lineage.md)
and [docs/architecture.md](docs/architecture.md).
Start with the [Temari platform overview](docs/platform-overview.md), then
read the [component guide](docs/platform-components.md) for responsibilities,
decision paths, verification, and provenance. Use the [verification matrix](docs/verification-matrix.md)
to trace design claims to implementation and retained evidence.

Temari owns routing, plans, evidence, and closeout. The host (Cursor,
Codex, Claude, Hermes, or serial fallback) owns tools, models, and
credentials. Personal and OpConnect material is an overlay, not this
tree — [docs/overlays.md](docs/overlays.md).

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
# From a clean checkout: verify tools and lockfiles, then install everything.
pnpm temari:init
pnpm temari:doctor

# Development checks.
pnpm install
pnpm exec nx run-many -t typecheck
pnpm exec nx graph
```

`temari:init` is the OS-agnostic dependency entry point. It uses Node APIs
instead of shell-specific installers, installs the Nx workspace with the
frozen pnpm lockfile, installs the packaged Poteto runtime with its frozen Bun
lockfile, and writes an install receipt under the platform's user-local Temari
state directory. On supported architectures, initialization also downloads
the pinned Archon v0.10.1 executable into Temari's versioned user-local cache
and records its source, platform, and SHA-256 in the receipt. The
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
