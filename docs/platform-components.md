# Temari platform component guide

This document expands the [Temari workflow platform overview](platform-overview.md).
It is for maintainers who need to understand ownership, decision paths, and
the evidence required to call work complete.

The diagrams distinguish the current Nx slice from planned runtime behavior.
The distinction matters. The repository currently proves a typed plan boundary,
capability gating, a serial stage runner, bounded independent worker fan-out,
bounded knowledge investigation, and a managed Archon-harness port. It does
not yet claim a complete unattended scheduler, durable child-task recovery,
universally proven host capabilities, or canonical Archon receipt parity.

## The ownership model

The platform has three primary authorities.

| Authority          | Owns                                                                                        | Must not own                                                            |
| ------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Temari coordinator | Meaning, classification, research intent, plan, replan, semantic decisions, closeout policy | Provider credentials, host-specific model calls, mechanical retry state |
| Runtime services   | Persistence, dispatch, leases, retries, reconciliation, status, idempotent run control      | The meaning of the request or semantic approval of evidence             |
| Host adapter       | Tools, models, permissions, credentials, worktrees, forge access, host capability reports   | Rewriting the plan or pretending a missing capability exists            |

The same split applies to knowledge.

| Knowledge boundary | Responsibility                                                            |
| ------------------ | ------------------------------------------------------------------------- |
| Temari             | Decide what context is needed and how it affects the plan                 |
| Knowledge provider | Discover and read admitted sources, return evidence, revalidate snapshots |
| Runtime            | Persist checkpoints and resume bounded retrieval                          |
| Consumer           | Assess findings and decide whether semantic review is still required      |

## 1. Temari and the coordinator

### Responsibilities

Temari core performs the semantic work that must remain portable across hosts.

- Normalize the request without losing constraints or forbidden actions.
- Classify the work as investigation, design, bug, feature, QA, or migration.
- Convert obligations into one `ExecutionPlan`.
- Choose delegation, review, evidence, and delivery policies.
- Ask a host adapter for capabilities before starting work that requires them.
- Degrade or stop when the plan cannot be satisfied honestly.
- Replan when evidence changes or a stage reports a structured issue.
- Apply provider-neutral verification-maintenance policy.
- Produce the semantic inputs to closeout without claiming host facts it cannot
  observe.

`libs/temari-core` deliberately keeps the daily verification-maintenance
decision pure. It decides whether `maintain-verification-skill` is due from a
receipt and a clock. The caller remains responsible for persistence,
filesystem access, scheduling, and execution.

### Decision path

```mermaid
flowchart TD
  Request["Request and constraints"] --> Normalize["Normalize intent and forbidden actions"]
  Normalize --> Classify["Classify work type and risk"]
  Classify --> Obligations["Build PlanObligations"]
  Obligations --> Plan["Reconcile one ExecutionPlan"]
  Plan --> Capabilities{ "Required capabilities proven?" }
  Capabilities -->|"No"| Degrade["Choose honest degradation"]
  Degrade --> CanProceed{ "Can serial behavior satisfy the request?" }
  CanProceed -->|"No"| Block["Structured BLOCKED result"]
  CanProceed -->|"Yes"| Run["Start the same workflow engine"]
  Capabilities -->|"Yes"| Run
  Run --> Evidence["Collect stage results and evidence"]
  Evidence --> Change{ "Evidence changed or obligation unmet?" }
  Change -->|"Yes"| Replan["Replan or preserve a resumable stop"]
  Change -->|"No"| Closeout["Apply closeout policy"]
```

### Plan shape

The plan always contains the fixed stages. Policy fields carry the variation.

- `delegation` is `none`, `optional`, or `required`.
- `review` is `self`, `coordinator`, or `independent`.
- `evidence` is `minimal`, `standard`, or `revision-bound`.
- `delivery` is `local`, `commit`, or `pull-request`.
- `requiredCapabilities` is the explicit capability set needed by the plan.

Required delegation or independent review adds the `subagents` capability.
Bounded fan-out above one worker adds the `parallelism` capability.
Pull-request delivery adds the `forge` capability. These are derived plan
requirements rather than hidden scheduler behavior.

## 2. Knowledge intake and retrieval

Knowledge is a bounded evidence service. It is not an implicit context window,
a global crawler, or an authority that silently changes the plan.

### Responsibilities

The provider contract supports `discover`, `read`, and `revalidate`. The
investigation layer composes those operations into a resumable assessment.

- Admit an explicit source scope, query, selection, question set, and budget.
- Discover within page and byte limits.
- Read only selected documents and required dependencies.
- Return exact excerpts, codepoint spans, and SHA-256 identities.
- Revalidate retained evidence before assessment and before finalization.
- Record coverage, limits, gaps, continuations, and pending reads.
- Persist a content-addressed checkpoint before semantic assessment.
- Resume only when task, request, provider, and authority still match.
- Preserve old findings as immutable records when inputs change.

The current local Registrar adapter admits an explicit source root and bounded
UTF-8 text formats. It rejects absolute paths, traversal, symlinks, and
unsupported source modes. Remote sources, semantic recall, automatic dependency
inference, archive retention, and revocation policy are outside this slice.

### Intake and retrieval path

```mermaid
flowchart TD
  Need["Temari investigation need"] --> Brief["Trusted brief and explicit scope"]
  Brief --> Admit{ "Provider and scope admitted?" }
  Admit -->|"No"| Gap["Record unavailable or unsupported gap"]
  Admit -->|"Yes"| Discover["Bounded paginated discovery"]
  Discover --> Select["Apply explicit selections and requires"]
  Select --> Read["Bounded reads with continuation tokens"]
  Read --> Validate["Check exact hash, span, path, and encoding"]
  Validate --> Recheck["Revalidate source state"]
  Recheck --> Stable{ "Evidence unchanged?" }
  Stable -->|"No"| Changed["Mark stale or changed and block semantic completion"]
  Stable -->|"Unknown"| Unknown["Keep unknown gap visible"]
  Stable -->|"Yes"| Checkpoint["Save content-addressed checkpoint"]
  Checkpoint --> Assess["Assess findings and alternatives"]
  Assess --> Questions{ "Every known question accounted for?" }
  Questions -->|"No"| Incomplete["Return ISSUES or BLOCKED"]
  Questions -->|"Yes"| Review["Return findings for semantic review"]
  Gap --> Incomplete
  Changed --> Incomplete
  Unknown --> Incomplete
```

### Knowledge decision rules

The caller chooses which discovered documents to read. Discovery never expands
the read scope by itself. A provider result can be successful, or it can return
a typed gap such as `unsupported`, `scope-refused`, `changed`, `unavailable`,
`unknown`, or `pending`.

The current investigation consumer does not return semantic `PASS`. It returns
`ISSUES` when the evidence is stable but still needs semantic review, and
`BLOCKED` when evidence is incomplete, changed, unavailable, or not safely
revalidated.

## 3. Poteto mode and its knowledge path

Poteto mode is the engineering method and playbook layer. It gives Temari a
deliberate route for engineering work, rather than being a second workflow
runtime.

### Responsibilities

- Classify every engineering request before choosing a route.
- Use lightweight engineering only when its stricter conditions are satisfied.
- Select a full playbook when the task is uncertain, architectural,
  nontrivial, or sensitive.
- Put the required work into explicit stages, acceptance criteria, and
  verification commands.
- Use deliberate delegation when the plan requires it.
- Keep prose and code concise enough to preserve reader and context budgets.
- Preserve evidence and decision trails for long or multi-phase work.
- Route source-heavy investigation through bounded knowledge intake rather than
  treating unverified memory as design authority.

The packaged v4.1 assets contain the Poteto skill, playbooks, orchestration
helpers, and verification skills. In the Nx design, those assets are a
migration and packaging source. The canonical engine remains the Nx workflow
engine.

### Route decision

```mermaid
flowchart TD
  Engineering["Engineering request"] --> External{ "External service, provider, or credential dependency?" }
  External -->|"Yes"| Integration["Resolve integration policy and trust boundary"]
  External -->|"No"| Classify["Classify route"]
  Integration --> Classify
  Classify --> Lightweight{ "All lightweight conditions proven?" }
  Lightweight -->|"Yes"| Light["Lightweight engineering obligations"]
  Lightweight -->|"No or uncertain"| Full["Full Poteto playbook"]
  Light --> Plan["Build PlanObligations"]
  Full --> Plan
  Plan --> Same["Use the same six-stage workflow engine"]
  Same --> Investigate["Investigate when the selected route needs context"]
  Investigate --> Knowledge["Bounded discovery, reads, and revalidation"]
  Knowledge --> Context["Cited context with gaps and freshness"]
  Context --> Build["Plan, build, review, verify, deliver"]
  Same --> Build
```

Poteto decisions are therefore policy inputs. They do not authorize a worker to
skip evidence, a scheduler to make semantic decisions, or a host to fill a
missing capability with a simulation.

## 4. Orchestration and scheduling

Orchestration is the mechanical control plane around a Temari plan. It is
separate from semantic coordination so scheduling failures do not silently
change what the user asked for.

### Responsibilities

The planned runtime boundary owns:

- Durable run records and revision-bound route events.
- Deterministic dispatch of stages or worker briefs.
- Leases and ownership of mutable run state.
- Retry and resume behavior with idempotency rules.
- Reconciliation after host or worker interruption.
- Cancellation, status, and completion notifications.
- The relationship between worker evidence and the active stage.

The current Nx `workflow-engine` implements the serial stage sequence,
capability checks, an in-memory revision-bound `WorkflowReceipt`, and a
bounded independent-worker fan-out with a stable join receipt. The
`@temari/runtime` package consumes that receipt shape and now provides atomic
receipt persistence, immutable content-addressed evidence, basic run leases,
append-only route events, idempotent transitions, a scheduled execution
wrapper, and a local `FileChildTaskStore` with dependency-aware claims,
per-child leases, fencing epochs, result persistence, and idempotent
completion. It now provides durable PASS-stage checkpoints, bounded workspace
manifest capture/verification, child manifest publication during restartable
parallel execution, and serial-stage manifest publication and verification
before checkpoint resume. Callers must provide explicit bindings for the
workspace associated with each child or stage; this local boundary does not
yet provide executor-integrated provider evidence publication,
retry/cancellation policy, or shared-store reconciliation. The
dispatcher should be deterministic. It is not an LLM scheduler agent.

### Scheduling path

```mermaid
flowchart TD
  Plan["ExecutionPlan"] --> Gate{ "Capabilities satisfy plan?" }
  Gate -->|"No"| Honest["Return capability gap or serial degradation"]
  Gate -->|"Yes"| Run["Create or resume revision-bound run"]
  Run --> Stage["Select next fixed stage"]
  Stage --> Delegation{ "Delegation policy" }
  Delegation -->|"none"| Coordinator["Coordinator-owned tools"]
  Delegation -->|"optional or required"| Dispatch["Deterministic dispatcher"]
  Dispatch --> Brief["WorkerBrief with scope and acceptance"]
  Brief --> Worker["Worker"]
  Coordinator --> Result["Stage result and raw evidence"]
  Worker --> Result
  Result --> Persist["Persist event, output, and log references"]
  Persist --> Status{ "PASS, ISSUES, BLOCKED, or DROPPED?" }
  Status -->|"PASS"| Next{ "More stages?" }
  Status -->|"ISSUES"| Replan["Temari review or replan"]
  Status -->|"BLOCKED"| Resume["Preserve blocker and resume handle"]
  Status -->|"DROPPED"| Abandon["Record abandoned route and reason"]
  Next -->|"Yes"| Stage
  Next -->|"No"| Verify["Run final verification and closeout"]
```

Workers receive an explicit brief with the goal, context, scope, acceptance
criteria, verification command, report format, and forbidden actions. They
return a typed status and raw evidence references. The contracts package now
validates the required control fields and rejects evidence-free or malformed
results. A coordinator must not treat a worker summary as the only truth.

The run store should enforce one coordinator writer for shared route state and
one worker writer per assigned stage evidence area. That separation prevents
concurrent actors from serializing shared mutable state into an ambiguous
receipt.

The receipt remains an in-memory semantic boundary in the engine. Persistence,
content-addressed evidence, leases, idempotency, route events, and local
workspace-manifest verification are runtime concerns. Cancellation, durable
notifications, provider evidence capture, and shared store reconciliation
remain open runtime work.

## 5. Execution harnesses and Archon

An execution harness owns native run control: starting a plan entrypoint,
reporting provider-neutral status, and resuming the same native run. This is
separate from a host adapter, which supplies tools, model calls, credentials,
permissions, and host capability evidence. Archon is the managed
implementation of the harness port; another host or harness can replace it at
composition time. It is not the owner of semantic intent, knowledge authority,
or closeout policy.

### Responsibilities

- Install the pinned native executable into Temari's user-local cache.
- Expose runtime dispatch, status, and resume through the selected host,
  configured, or managed implementation.
- Translate the shared run-level port to Archon's workflow start, status, and
  exact-run resume commands using argument arrays, not shell strings.
- Bind the native run ID to Temari run ID, revision, harness version, and plan
  digest.
- Translate known native states to provider-neutral status; preserve unknown
  states as `UNKNOWN` rather than treating them as success.
- Keep host API capability reports and semantic verification outside Archon.
- Preserve the legacy bridge's capture/finalize checks as migration evidence,
  not as an authoritative Nx receipt producer.

### Archon decision path

```mermaid
flowchart TD
  Start["Temari-approved Archon lane"] --> Validate["Validate workflow, repo, profile, and hashes"]
  Validate --> Valid{ "Identity and ownership match?" }
  Valid -->|"No"| Reject["Reject run and preserve validation evidence"]
  Valid -->|"Yes"| Launch["Launch native Archon workflow"]
  Launch --> Nodes["Persist node status and attempt logs"]
  Nodes --> Failed{ "Node fails or host stops?" }
  Failed -->|"Yes"| Resume["Resume exact run when state is reusable"]
  Resume --> Nodes
  Failed -->|"No"| Capture["Bridge captures sealed stage outputs"]
  Capture --> Review{ "Review boundary satisfied?" }
  Review -->|"No"| Hold["Keep run incomplete and resumable"]
  Review -->|"Yes"| Finalize["Bridge finalizes canonical receipt"]
  Finalize --> Publish["Publish evidence last and return closeout facts"]
```

`@temari/archon-harness` is a separate Nx library; `packages/initializer`
downloads the pinned Archon v0.10.1 executable for its published macOS and
Linux architecture variants and Windows x64 into the managed cache. Windows
currently has only an x64 asset. A Windows workflow containing Archon's `bash:` nodes also
requires Git for Windows; the adapter chooses known Git Bash locations or an
explicit `ARCHON_BASH_PATH`, not an arbitrary `bash.exe` found on `PATH`.

The current Nx port proves harness replacement and native run identity, but it
does not yet map Archon's node outcomes into canonical six-stage Temari
receipts. The existing packaged deterministic check proves behavior in the
legacy v4.1 lane; it does not prove this adapter's live model work, Windows
workflow/process-tree behavior, hard-crash recovery, host identity
authentication, sandboxing, or a general production scheduler. Callers choose
the native-harness dispatch API explicitly; ordinary `executeAndPersist`
remains the authoritative serial path. The bridge is not a sandbox, and
current actor identities are host-reported.

Selection order is host-injected harness, explicitly configured alternate,
then managed Archon. No missing explicit implementation is silently replaced.
Promote Archon to the canonical Nx completion path only after the same frozen
plan produces equivalent revision-bound stage receipts in both Archon and
serial conformance journeys.

## 6. Verification

Verification has two related surfaces.

### Product behavior

Does the implemented system behave correctly for the user? This needs focused
tests, live journeys, or domain-specific checks appropriate to the change.

### Procedural conformance

Did this run follow the active route, use the required assignments, preserve
the required evidence, and reach the declared closeout boundary? This is what a
workflow receipt can prove.

The two surfaces must not be conflated. A green typecheck is not a behavioral
verdict. A procedural receipt is not proof that a product feature works.

### Verification path

```mermaid
flowchart TD
  Work["Active revision and execution plan"] --> StageChecks["Stage-specific checks"]
  StageChecks --> Raw["Raw output, logs, and evidence references"]
  Raw --> Identity["Bind revision, producer, requirement, and freshness"]
  Identity --> EvidenceGate{ "Evidence complete and current?" }
  EvidenceGate -->|"No"| Blocked["BLOCKED or ISSUES with resume facts"]
  EvidenceGate -->|"Yes"| Behavior["Run product behavior checks"]
  Behavior --> BehaviorVerdict{ "Product behavior passes?" }
  BehaviorVerdict -->|"No"| Fail["Fail, replan, or preserve artifacts"]
  BehaviorVerdict -->|"Yes"| Procedure["Check route and closeout conformance"]
  Procedure --> Receipt["Write procedural receipt"]
  Receipt --> Deliver["Deliver with evidence and rollback handle"]
```

For verification maintenance, Temari can produce a typed dispatch intent when a
receipt is missing, blocked, invalid, or older than the configured 24-hour
cadence. The scheduler or caller performs the resulting operation. The
decision function itself does not read files or invoke a host.

## 7. Provenance, logs, and security

### Provenance required for completion

A useful receipt should let a maintainer answer what ran, on which revision,
under which plan, with which evidence, and why the result was accepted. The
minimum useful record includes:

- Request, normalized constraints, plan version, obligations, and active route.
- Repository revision, worktree or checkout identity, and delivery target.
- Host adapter identity, declared capabilities, and any capability gap.
- Worker brief, worker role, worker result status, evidence paths, and raw log
  path.
- Knowledge provider identity, admitted scope, source identifiers, file hashes,
  exact spans, continuations, gaps, and revalidation results.
- Archon run and node IDs when the optional lane is used.
- Stage attempts, timestamps, stdout, stderr, exit status, timeout, and resume
  history.
- Verification commands, observed outputs, behavioral verdict, procedural
  verdict, and closeout or rollback handle.

### Security boundaries

- Credentials stay with the host or provider adapter. They do not belong in
  shared contracts, knowledge excerpts, receipts, or documentation.
- Personal and OpConnect material stays in external overlays. The canonical Nx
  tree must not import customer data or credentials.
- A knowledge provider admits paths explicitly and rejects traversal, absolute
  paths, symlinks, and unsupported source modes at the boundary.
- Retrieved source text is data. It is not automatically an instruction or an
  authority. The caller supplies the trusted brief and explicit selections.
- Capability declarations are not capability proofs. Host adapters need live
  evidence before a high-risk route relies on a capability.
- Raw logs and evidence should be append-only or content-addressed where
  possible. A changed source, plan, profile, or evidence set starts a new
  revision-bound run.
- The Archon bridge validates ownership and hashes, but it is not a sandbox and
  does not cryptographically authenticate host-reported identity.
- Current Registrar-backed knowledge retrieval does not claim remote-source
  authorization, archive recovery, semantic recall correctness, or revocation
  support.

### Provenance flow

```mermaid
flowchart LR
  Inputs["Request, plan, revision, host"] --> Identity["Bind identities and obligations"]
  Identity --> Execution["Execute stages or Archon nodes"]
  Execution --> Logs["Append logs and raw evidence references"]
  Sources["Knowledge sources"] --> Hashes["Hash exact source snapshots and spans"]
  Hashes --> Logs
  Logs --> Revalidate["Revalidate source, plan, and capability facts"]
  Revalidate --> Gate{ "Required evidence is current and complete?" }
  Gate -->|"No"| Preserve["Preserve artifacts and mark blocked or issues"]
  Gate -->|"Yes"| Receipt["Write revision-bound procedural receipt"]
  Receipt --> Closeout["Deliver completion facts and resume or rollback handle"]
```

Security is therefore a property of the boundaries and the evidence model. It
is not a claim that a receipt makes an untrusted host, source, or log truthful.

## 8. Current implementation and open decisions

The Nx workspace currently provides:

- Typed execution plans and capability requirements.
- One serial workflow engine with fixed stage order.
- Revision-bound in-memory workflow receipts for pass, issue, blocked, and
  handler-failure outcomes.
- A small runtime package that persists receipts atomically and idempotently,
  stores immutable content-addressed evidence, and records lease/event state.
- Generic and Cursor host adapter capability reports.
- Worker brief and result contracts.
- Bounded knowledge discovery, reads, exact evidence, checkpoints, and
  revalidation through the provider boundary.
- A packaged deterministic Archon integration that exercises capture,
  finalization, review gating, and ordinary resume.

The design still leaves these decisions or gates open:

- Where durable runtime ownership lives when persistence, leases, retries, and
  cancellation become necessary.
- How cross-machine manual takeover will be operated and what would be required
  to promote the [automatic failover draft](decisions/2026-09-23-failover-design.md).
- How live host capability claims are proven rather than declared.
- Whether Archon becomes a host capability, dispatcher, or separate executor.
- How public `temari`, `poteto-mode`, and `closeout` entries install and drift
  check against the Nx packages.
- Which evidence store and retention policy can support unattended journeys.
- Which knowledge providers earn promotion from external overlays into reviewed
  Nx ports.
- What the cutover and rollback evidence must show before legacy v4.1 can be
  retired.

These open items are release gates, not reasons to add parallel semantic
owners. The safe direction is to extend the existing contracts and ports, keep
the engine singular, and promote a boundary only after a real journey proves
the need.

## Related source

- [Architecture decisions](architecture.md)
- [Executable workflow](workflow.md)
- [Knowledge package contract](../libs/knowledge/README.md)
- [Workflow-runtime package](../packages/workflow-runtime/README.md)
- [Nx cutover plan](temari-nx-cutover-plan.md)
- [Platform overview](platform-overview.md)
