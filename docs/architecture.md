# Temari architecture

Temari is a portable, host- and model-agnostic **workflow control plane**.
It is not an agent runtime. Cursor, Codex, Claude Code, Hermes, and a
serial fallback only supply execution primitives.

This repository (`randydinh/temari`) is the canonical Nx-native platform.
`temari-v1` through `temari-v4.1` are historical references. Do not add
canonical behavior there.

## Layers

| Layer                           | Package                   | Owns                                                                                                                                                         |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation and classification | `@temari/temari-core`     | Understand the request, preserve constraints, construct an `ExecutionPlan`, choose skill-dispatch intent, and apply provider-neutral verification policy.    |
| Contracts                       | `@temari/contracts`       | `ExecutionPlan`, host capabilities, worker briefs and results.                                                                                               |
| Workflow engine                 | `@temari/workflow-engine` | One stage sequence: investigate → plan → build → review → verify → deliver.                                                                                  |
| Host adapters                   | `@temari/host-adapters`   | Capability reports and host-specific tools. Never fake a missing API.                                                                                        |
| Execution harnesses             | `@temari/archon-harness`  | Replaceable run-level start/status/resume port; Archon is a managed implementation, not a host capability or semantic coordinator.                           |
| Mechanical runtime              | `@temari/runtime`         | Atomic/idempotent receipt persistence and execution wrapper; durable dispatch, leases, retries, and reconciliation remain incomplete. No semantic decisions. |
| Overlays                        | install-time only         | Personal skills, OpConnect resources, credentials. Not this git tree.                                                                                        |

Knowledge providers are a separate boundary. Content Registrar may be a
provider implementation, but its source registry, extractors, indexes,
credentials, and freshness lifecycle do not belong in the workflow engine.
The Nx project graph remains a code/build graph; it is not a document
knowledge graph.

Public entries remain `temari`, `poteto-mode`, and `closeout` once packaging exists.

## One engine, many plans

Do **not** implement lightweight vs full as two workflows.

The same engine runs every change. Risk and ceremony live on the plan:

- `delegation`: none | optional | required
- `review`: self | coordinator | independent
- `evidence`: minimal | standard | revision-bound
- `delivery`: local | commit | pull-request
- `requiredCapabilities`: subset of the host capability set

A one-line local edit and a risky feature produce the same receipt type.

The first executable slice reconciles semantic `PlanObligations` into this
single `ExecutionPlan` shape. Serial local work is the default. Stronger
obligations derive their host requirements (`subagents` for required
delegation or independent review, `forge` for pull-request delivery) instead
of asking callers to maintain a second risk or host matrix. The slice proves
stage order and honest capability failure; durable dispatch, leases, retries,
watchers, reconciliation, and provider-specific execution remain deferred. The
runtime package now persists the engine's revision-bound receipt shape without
owning semantic decisions. A separate run-level harness port now binds native
run IDs to a Temari run and plan digest; canonical Archon receipt parity is
still a promotion gate.

The coordinator slice also exposes a pure daily verification-maintenance
decision. It can return a typed intent for `maintain-verification-skill` when
the last successful receipt is missing or older than 24 hours. It does not
read files, schedule work, or invoke a host; persistence and execution remain
caller responsibilities.

## Responsibility split

```text
Temari coordinator  →  meaning, research, plan, design, replan, decisions
Runtime services    →  persist, dispatch, lease, retry, reconcile, status
Host adapter        →  tools, models, permissions, credentials, forge
Execution harness   →  native scheduling, status, and resume
```

A dispatcher is deterministic. It is not an LLM “scheduler agent.”

Workers receive an explicit brief (goal, context, scope, acceptance,
verification, forbidden actions) and return `PASS | ISSUES | BLOCKED | DROPPED`
plus raw evidence. The coordinator never treats a worker summary as the
only source of truth.

If a required capability is missing, Temari degrades or stops. It does not
simulate subagents, model diversity, or forge operations.

Host and harness selection are independent. A host can inject its own harness;
otherwise an explicitly configured harness is selected, then the managed
Archon implementation. Archon scheduling never proves that its host provides
subagents, credentials, model diversity, or forge operations. The current
six-stage receipt engine remains authoritative until the Archon adapter can
produce equivalent stage-bound receipts.

## Portability

- Core packages describe intent, not a provider API.
- Host adapters and execution harnesses are independently swappable. Inherit
  the host model by default.
- Serial execution is first-class, not a consolation prize.
- Multi-agent work is a capability, not a requirement.
- Personal and employer material stay in overlays. Coworkers get the
  platform, not Randy’s OpConnect tree.

## Cutover gate

Do not uninstall v4.1 until:

1. `temari`, `poteto-mode`, and `closeout` install from this repository
2. skill metadata and adapter layout validate
3. at least one conversational-to-engineering journey succeeds on that host
4. rollback is explicit

Nx Cloud is out of scope until local affected execution proves a CI benefit.
Do not cache live host journeys.

## Authority

Later decision-ledger entries supersede earlier ones. v4.1
`docs/architecture.md` still describes a two-route Poteto union; that
document is historical once this file is accepted.
