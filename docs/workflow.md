# Workflow

```mermaid
flowchart TD
  U[User request] --> T[Temari conversation]
  T --> G{Credential / integration gate}
  G -->|blocked| H[Ask host or human]
  G --> C[Classify responsibility and risk]
  C --> P[Construct ExecutionPlan]
  P --> Cap{Required capabilities?}
  Cap -->|missing| Deg[Degrade or stop - never fake APIs]
  Cap --> E[One workflow engine]
  E --> I[Investigate]
  I --> Pl[Plan]
  Pl --> B[Build]
  B --> R[Review]
  R --> V[Verify]
  V --> D[Deliver]
  D --> X[Closeout]
  E --> Exec{delegation}
  Exec -->|none| Local[Coordinator tools]
  Exec -->|optional or required| Disp[Deterministic dispatcher]
  Disp --> W[Workers]
  W --> Fan[Bounded fan-out and stable join]
  Fan --> Store
  Local --> Store[(Run store)]
  Store --> E
```

The current vertical slice makes the plan boundary executable: semantic
obligations are reconciled into one `ExecutionPlan`, then the engine runs the
declared stages serially by default or performs bounded fan-out for explicitly
independent worker assignments. It stops before execution when required
capabilities are missing. A generic host is therefore a valid serial fallback,
not a pretend subagent provider. The current fan-out is in-memory; durable
child-task recovery and automatic failover remain roadmap work.

Temari owns the semantic decision to classify a request and dispatch a skill.
The host adapter only translates that typed intent into host-native tools.
Before verification begins, the coordinator may apply the provider-neutral
daily maintenance guard; a scheduler and a host adapter may persist or
execute the resulting intent, but neither decides whether it is due.
