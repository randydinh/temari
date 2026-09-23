# Temari implementation inventory and parallelism roadmap

Status: merged baseline `95d62d9`; this document records what is actually in
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

### Runtime and scheduling foundation

- `libs/runtime` persists hashed workflow receipts atomically and idempotently.
- `FileWorkflowRunStore` persists queued/running/terminal state, append-only
  route events, owner leases, expiry-based re-claim, idempotent transitions,
  and per-run filesystem locking.
- `executeScheduledAndPersist` composes run creation, claim, dispatch event,
  serial engine execution, receipt persistence, and terminal status transition.
- This is a mechanical foundation, not yet a complete durable scheduler: it
  does not persist child tasks, stage checkpoints, cancellation, notifications,
  retries with policy, reconciliation, or shared-store fencing.

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

It deliberately does not claim durable parallel execution. The runtime still
needs child-task state, dependency/frontier reconstruction, per-child leases,
fencing, retries, cancellation, artifact/workspace isolation, and a semantic
join owned by the coordinator.

## Completion roadmap

1. **Bounded local parallelism — current increment.** Keep the worker batch
   primitive deterministic, capability-gated, bounded, evidence-bearing, and
   serializable at the API boundary. Verify concurrency bounds and stable
   joins.
2. **Durable child-task runtime.** Add parent/child task records, dependency
   edges, attempts, leases, fencing epochs, idempotency keys, status events,
   cancellation, and retry policy to the mechanical runtime. Do not let child
   workers mutate shared semantic state.
3. **Recovery and join proof.** Persist child evidence and workspace manifests;
   rebuild the ready frontier after process/host failure; retry only incomplete
   attempts; join all required results with explicit optional degradation;
   reject stale owners after fencing changes.
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
