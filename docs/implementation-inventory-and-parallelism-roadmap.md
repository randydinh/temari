# Temari implementation inventory and parallelism roadmap

Status: parent-recovery working baseline `188e73f`; this document records what is actually in
the canonical Nx repository and separates it from planned behavior.

## Lossless implementation inventory

### Canonical platform

- `dfc90c6` initialized the Nx-native Temari platform boundary.
- `387b149` added the first workflow contracts and host adapters.
- `ce8d792` and the merged platform work completed the Nx projects for
  contracts, core, workflow engine, host adapters, runtime, knowledge,
  plan-draft, Archon harness, initializer, and packaged workflow assets.
- `616c8cd` made CI verification deterministic with the locked pnpm setup.
- `3af6ab5` imported the portable Temari runtime with explicit provenance.
- `9495c23` packaged the runtime into Nx with relocated installation checks.

### Semantic planning and one-engine execution

- `libs/contracts` defines the fixed six-stage lifecycle, work types, plan
  obligations, derived capability requirements, host capability reports,
  worker briefs/results, harness references, and revision-bound workflow
  receipts.
- `libs/temari-core` keeps classification and daily verification-maintenance
  decisions pure. It produces obligations; it does not select a provider or
  execute a host command.
- `libs/workflow-engine` owns the single serial stage engine and receipt
  behavior. Capability gaps become structured `BLOCKED` receipts; handler
  failures retain the stage and failure reason.
- `libs/host-adapters` provides an honest generic serial adapter and a Cursor
  capability declaration. A host adapter does not invent APIs or semantic
  decisions.
- `libs/plan-draft` provides bounded conversation drafting, recovery,
  command-judgment boundaries, Registrar-backed integration points, and a
  bounded pilot. It remains a caller of the common engine.

### Knowledge and evidence

- `a4565f6` added bounded knowledge investigation contracts and provider
  boundaries.
- `libs/knowledge` enforces explicit scope, bounded discovery/read budgets,
  safe paths, source hashes, exact spans, continuations, revalidation, typed
  gaps, checkpoints, and assessments that cannot claim semantic `PASS` without
  review.
- Runtime evidence is immutable and content-addressed through
  `FileEvidenceStore`; receipt and evidence paths are revision-bound.
- `FileWorkspaceManifestStore` captures a bounded, sorted, revision-bound
  snapshot of regular workspace files with SHA-256, size, and mode; it stores
  immutable manifests and verifies a workspace without following symlinks.

### Runtime and scheduling foundation

- `libs/runtime` persists hashed workflow receipts atomically and idempotently.
- `FileWorkflowRunStore` persists queued/running/terminal state, append-only
  route events, owner leases, expiry-based re-claim, idempotent transitions,
  and per-run filesystem locking. Parent state/event transitions now use the
  same private fsynced transaction sidecar and strict reconciliation boundary
  as child tasks; arbitrary route events remain valid, while ambiguous crash
  gaps fail closed.
- `FileChildTaskStore` persists revision-bound child-task records, dependency
  edges, attempts, per-child leases, fencing epochs, append-only task events,
  worker results, and idempotent terminal completion. Claims are dependency
  aware, and `listReady` reconstructs a stable ready frontier from disk. A
  durable immutable child-task group records the exact ordered membership, and
  mechanical `FAILED` completion keeps handler errors distinct from semantic
  worker `BLOCKED` results. Each child transition is staged in a private,
  fsynced transaction sidecar containing base digests and the complete next
  state/event history. Lock-safe reconciliation repairs only a transaction
  whose base or next state is proven; ambiguous, partial, event-ahead, and
  missing-state histories fail closed. Complete legacy schema-1 histories
  without a sidecar remain readable; an ambiguous pre-sidecar crash gap has no
  safe implicit migration and is an explicit incompatibility boundary.
- `executeRestartableParallelWorkers` runs one bounded local claim/execute
  pass, reuses terminal children, refuses incomplete joins, records explicit
  pending reasons, and persists a content-addressed joined parallel receipt.
  Its handler delivery remains at-least-once and its scope is intentionally
  independent of the parent run lease.
- `executeScheduledAndPersist` composes run creation, claim, dispatch event,
  serial engine execution, receipt persistence, and terminal status transition.
- `FileWorkflowCheckpointStore` persists a verified PASS-stage prefix with the
  run, revision, plan, capability report, and original start time. The engine
  resumes only from a declared checkpoint prefix and rejects changed identity;
  final receipt publication can therefore resume without replaying completed
  stages.
- This is a mechanical foundation, not yet a complete durable scheduler: it
  does not yet apply retry/cancellation policy, send notifications, renew
  parent leases, or provide shared-store fencing. Serial and restartable child
  execution now bind completed work to local workspace manifests when callers
  provide explicit workspace bindings; shared artifact recovery remains open.

### Archon and cross-platform delivery

- `e1abe86` added the replaceable managed Archon harness.
- `f1db473`, `9a666f4`, `f4767e6`, `6a62918`, and `da42dfb` hardened native
  paths, cache behavior, lock contention, package-manager wrappers, and Windows
  command quoting.
- `libs/archon-harness` pins Archon v0.10.1 and commit `9820785c`, validates
  release assets and hashes, maps native status, binds native run IDs to a
  Temari run and plan digest, and supports status/resume through the selected
  harness port.
- `packages/initializer` performs cross-platform dependency discovery,
  installation, receipts, doctor checks, and Windows executable resolution.
- `72b5024`, `33c1099`, `191a49d`, `cb454e3`, and `c7df442` are the verified
  Windows runtime, shell, diagnostic, executable-extension, and Archon-smoke
  fixes.
- PR #10 merged this baseline as `95d62d9`. Linux CI and the Windows Archon
  harness checks passed at the merged head.

### Packaged workflow and legacy boundary

- `9bb0874` imported the portable v4.1 workflow runtime, skills, host
  projections, verification assets, and optional Archon integration under
  `packages/workflow-runtime/assets/v4.1/` with provenance.
- Personal, OpConnect, provider, credential, and knowledge-specific material
  remains an external overlay. The Nx repository must not absorb those private
  boundaries.
- The public install surface, clean host journey, compatibility matrix, drift
  checks, rollback evidence, and v4.1 retirement gate remain incomplete.

### Temporal proof in the old repository

- PR #46 merged the opt-in local `@temari/temporal-stage1-proof` package into
  old Temari as `f893922`.
- Its two proofs cover durable waiting across builder/coordinator worker
  restarts and fail-closed required delegation without coordinator
  substitution.
- Typecheck, tests, and the deterministic repository gate passed.
- It does not yet prove a shared Temporal service, shared artifact store,
  approval recovery, branch/join concurrency, or automatic failover.

## Current parallelism boundary

The merged baseline had a `parallelism` capability but no executable fan-out.
This roadmap increment adds an explicit bounded `parallelism.maxConcurrency`
plan policy, typed worker assignments, and `runParallelWorkers` in the
workflow engine. The executor validates briefs and results, never starts work
when the capability is missing, bounds active workers, collects sibling
outcomes, and returns a stable declaration-order join.

The current increments provide a local restartable executor boundary. They
persist an immutable ordered child group, claim only up to the declared bound,
reuse terminal children after restart, fence stale completion, reconcile every
expected child before claim, join, or receipt replay, and emit a receipt only
after every expected child is terminal and valid. Crash-boundary tests prove
that a repaired terminal child is not rerun and that stale receipts are not
replayed when expected state is missing. This remains a local child-task proof:
it deliberately does not claim parent-run lease renewal, automatic failover,
shared control or artifact storage, retry/cancellation policy, workspace
manifests integrated with serial stage completion, or cross-machine execution.

The parent control plane now has the corresponding local recovery boundary.
Create, claim, route-event append, transition, load, and event observation all
reconcile a private per-run sidecar before proceeding. The sidecar repairs
state/event publication gaps only when the base or complete next history is
proven. This does not imply parent lease renewal, shared control storage, or
automatic failover.

## Completion roadmap

1. **Bounded local parallelism — implemented.** The worker batch primitive is
   deterministic, capability-gated, bounded, evidence-bearing, and joined in
   declaration order.
2. **Restartable local child-task execution — implemented in this increment.**
   The runtime has immutable expected membership, bounded claim/execute passes,
   terminal replay, fenced leases, mechanical failure preservation, explicit
   incomplete-join refusal, and a durable joined receipt. Do not let child
   workers mutate shared semantic state.
3. **Recovery and join proof — local child and parent control boundaries
   implemented.** The private transaction sidecars, strict digest/history
   proofs, lock-safe reconciliation, crash-boundary tests, no-rerun recovery,
   receipt replay refusal, and PASS-stage checkpoint/resume are now implemented
   for child tasks, the parent run store, and the serial stage engine. A local
   workspace manifest capture/verification boundary is also implemented for
   restartable child completion and serial PASS-stage checkpoint resume;
   retry/cancellation policy, run-level concurrency evidence, provider
   evidence publication, artifact recovery, shared storage, and cross-machine
   failover remain explicit follow-on gates.
4. **Temporal/shared-service proof.** Move the local Stage 1 proof to a shared
   Temporal service and artifact store. Prove builder/coordinator replacement,
   approval recovery, required-concurrency failure, serial fallback only when
   the plan permits it, and duplicate-delivery safety.
5. **Packaging and cutover.** Expose the same parallel contract through the
   public packages, prove clean host installation and compatibility, record
   rollback/drift evidence, then consider v4.1 retirement.
6. **Automatic failover last.** Automatic takeover is not a prerequisite for
   local parallelism. It becomes eligible only after shared control storage,
   fencing, idempotency, reconciliation, and failure-injection evidence pass.

## Explicit non-goals

- No second workflow engine for parallel routes.
- No hidden provider-specific scheduler in the contracts or coordinator.
- No automatic failover based only on an expired local lease.
- No treating a worker summary as proof without retained evidence.
- No deletion of legacy repositories or private overlays as part of this
  implementation increment.
