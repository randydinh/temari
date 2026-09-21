# Temari architecture

Temari is a portable, host- and model-agnostic **workflow control plane**.
It is not an agent runtime. Cursor, Codex, Claude Code, Hermes, and a
serial fallback only supply execution primitives.

This repository (`randydinh/temari`) is the canonical Nx-native platform.
`temari-v1` through `temari-v4.1` are historical references. Do not add
canonical behavior there.

## Layers

| Layer                           | Package                   | Owns                                                                                            |
| ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| Conversation and classification | future `libs/temari-core` | Understand the request, preserve constraints, construct an `ExecutionPlan`, explain the result. |
| Contracts                       | `@temari/contracts`       | `ExecutionPlan`, host capabilities, worker briefs and results.                                  |
| Workflow engine                 | `@temari/workflow-engine` | One stage sequence: investigate → plan → build → review → verify → deliver.                     |
| Host adapters                   | `@temari/host-adapters`   | Capability reports and host-specific tools. Never fake a missing API.                           |
| Mechanical runtime              | not yet extracted         | Persist runs, dispatch, leases, retries. No semantic decisions.                                 |
| Overlays                        | install-time only         | Personal skills, OpConnect resources, credentials. Not this git tree.                           |

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

## Responsibility split

```text
Temari coordinator  →  meaning, research, plan, design, replan, decisions
Runtime services    →  persist, dispatch, lease, retry, reconcile, status
Host adapter        →  tools, models, permissions, credentials, forge
```

A dispatcher is deterministic. It is not an LLM “scheduler agent.”

Workers receive an explicit brief (goal, context, scope, acceptance,
verification, forbidden actions) and return `PASS | ISSUES | BLOCKED | DROPPED`
plus raw evidence. The coordinator never treats a worker summary as the
only source of truth.

If a required capability is missing, Temari degrades or stops. It does not
simulate subagents, model diversity, or forge operations.

## Portability

### Local conversation drafts

`@temari/plan-draft` owns the bounded conversation-to-draft caller because it already owns the authorized local file effect. `createConversationPlanDraft` connects an admitted source provider and supplied assessment, proposal, and review functions. It preserves knowledge and draft results separately. General language classification, host model dispatch, and authority creation remain outside this operation.

The caller stores five immutable task-local records and reuses the draft engine's checkpoint admission and preparation. A resume replays the original result and proposal. An invocation marker without a saved outcome stops instead of authorizing another judgment. Keeping this recovery protocol inside one start/resume operation avoids separate public preparation and publication APIs or a new orchestration package. The [plan-draft contract](../libs/plan-draft/README.md) describes usage, authority, recovery boundaries, and the trusted local process profile.

### Provider boundaries

- Core packages describe intent, not a provider API.
- Adapters are swappable. Inherit the host model by default.
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
