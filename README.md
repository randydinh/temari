# Temari

Portable, host- and model-agnostic conversational engineering partner.

This is the canonical Nx workspace (`randydinh/temari`). Legacy products
are `temari-v1` … `temari-v4.1`. See [docs/lineage.md](docs/lineage.md)
and [docs/architecture.md](docs/architecture.md).

Temari owns routing, plans, evidence, and closeout. The host (Cursor,
Codex, Claude, Hermes, or serial fallback) owns tools, models, and
credentials. Personal and OpConnect material is an overlay, not this
tree — [docs/overlays.md](docs/overlays.md).

## Layout

```text
libs/contracts         ExecutionPlan, capabilities, worker briefs
libs/workflow-engine   One engine; many plans
libs/host-adapters     Swappable host capability reports
docs/                  Architecture, decisions, workflow
overlays/              Placeholder only — local files are gitignored
```

## Commands

```sh
pnpm install
pnpm exec nx run-many -t typecheck
pnpm exec nx graph
```

Do not connect Nx Cloud yet. Do not cache live host journeys.

## Workflow

One engine. Classification builds an `ExecutionPlan`; it does not fork
the lifecycle. Chart: [docs/workflow.md](docs/workflow.md).
