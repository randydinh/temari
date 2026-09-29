# Temari implementation inventory and parallelism roadmap

Status: local parallelism is implemented through PR #47. Subsequent migration
and packaging evidence is recorded below, separately from remaining host and
distributed acceptance gates.

The next development owner is
[Choose temari build source (3)](codex://threads/01a0dcca-d913-7d52-9f1b-16e47b5bd90a),
working from current `randydinh/temari` main in the **temari-next Nx monorepo**,
not v4.1. Follow the [current handoff](./migrations/continuation.md#current-handoff--2026-09-26).
Finish isolated public-entry installation and actual host/independent-QA
acceptance before shared-service integration; local proof is not multi-machine
acceptance. Historical milestone numbering below does not change that priority.

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
  idempotent lease-renewal witnesses, worker results, and idempotent terminal
  completion. Claims are dependency
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
  does not yet apply a complete cancellation policy, send notifications, or
  provide shared-store fencing. Serial and restartable child
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

- PR #48 added six fresh-process recovery acceptance scenarios through the
  canonical coordinator and persisted runtime, with literal artifact bytes
  and rejection of changed workspaces, revisions, and evidence. PR #49 fixed
  native Windows smoke JSON parsing without suppressing stderr or assertions.
- PR #50 merged a separate compiled canonical library artifact with ordinary ESM
  package exports, declaration files, exact content inventory, and no source
  loader or dependency-install step at runtime. Six packaging checks exercise
  relocation, durable checkpoint recovery, fresh-process evidence readback,
  dependency tampering, unsafe inventory paths, and existing-output refusal.
  Source candidate `2407705` and final documentation head `369a092` passed
  independent review and Linux/Windows CI. The merge is `5c5a66e`.
  Restricted readback does
  not imply restricted recovery writes, installed-host migration, or remote
  workers. See [canonical package verification](./migrations/canonical-packages.md).
- The serial runtime now has opt-in `stage-evidence-v1` attestations and
  `verifyPersistedStageEvidence`. It verifies complete persisted stage coverage
  and payload bytes, rejects profile changes on resume, and rechecks evidence
  before final receipt publication. The compiled-package journey includes
  missing/tampered evidence and restoration. Success is explicitly evidence-only;
  it does not establish candidate identity or independent reviewer provenance.
  See [stage evidence](./migrations/stage-evidence.md).
- Candidate-bound local execution adds `candidate-stage-evidence-v1`, runtime
  observations, and `verifyCandidateCloseout`. Initial intent uses the existing
  empty checkpoint; build may change A to B, while other stages preserve identity.
  The compiled consumer covers empty/build/complete-prefix recovery, pre-ack build
  mutation, orphan manifests, and stale expected/current candidates. This is a
  cooperative local-filesystem boundary, not atomic snapshots or independent QA.
  Public-entry installation and actual host closeout remain open. See
  [candidate verification](./migrations/candidate-closeout.md).
- PR #53 merged experimental local host dialogue as `4d316e3`. The stock-Node
  bridge binds invocation identity to existing checkpoints, confines evidence,
  distinguishes interrupted sessions from terminal refusals, and resumes verified
  prefixes without a second lifecycle. All 39 focused checks and eleven compiled
  checks passed; independent review and exact-head Linux/Windows CI passed.
  It reports no available host capabilities and is not an installed public
  policy adapter, independent QA proof or distributed worker. See
  [host dialogue](./migrations/host-session.md) and the
  [final review/merge record](./migrations/continuation.md).
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
after every expected child is terminal and valid. Child handlers may opt into
fenced lease-heartbeat renewal for work that exceeds the initial lease.
Crash-boundary tests prove
that a repaired terminal child is not rerun and that stale receipts are not
replayed when expected state is missing. This remains a local child-task proof:
it deliberately does not claim automatic failover,
shared control or artifact storage, a complete cancellation policy, or cross-machine
execution. Parent lease renewal is available through an explicit scheduler
heartbeat, but it does not imply automatic failover. Local
mechanical retry and cancellation gating are implemented for explicitly
configured child attempts/assignments; they do not imply automatic failover,
semantic retry decisions, or a complete cancellation policy.

Two independently opened local coordinators now have an integration proof for
expired-child takeover: the replacement reuses the completed sibling,
publishes the resumed child workspace/evidence, converges on one receipt, and
the stale coordinator cannot complete the fenced child. This is still a local
filesystem proof, not evidence for a shared remote control service.

A larger local batch guard also compares observed handler concurrency with the
durable receipt peak and the declared bound. It protects against unbounded
local fan-out; it is not a remote load or shared-service race proof.

The executor can also publish callback-supplied worker evidence through the
immutable content-addressed store. Child results retain revision-bound,
portable SHA-256 identities rather than local artifact paths, and replay
verifies each retained artifact before reusing a terminal child. This is a
provider-neutral publication boundary; provider-specific log capture and
shared artifact storage remain outside this local proof.

The local join rejects an outcome whose assignment differs from the declared
assignment, including its required flag or brief. Required handler errors and
`BLOCKED` results take precedence over `ISSUES`, then `DROPPED`; the reported
failure identifies a worker with the decisive status. Optional non-PASS work
is retained as a degradation. This policy does not prove shared delivery.

Completed parallel receipts also retain a portable execution-evidence envelope
with the child group identity, declared assignment IDs, and the measured
maximum and peak concurrency. Restartable replay checks that envelope against
the current immutable task identity before reusing the receipt. Older receipts
without the envelope are readable by the store but are not eligible for
restartable replay.

The parent control plane now has the corresponding local recovery boundary.
Create, claim, route-event append, transition, load, and event observation all
reconcile a private per-run sidecar before proceeding. The sidecar repairs
state/event publication gaps only when the base or complete next history is
proven. Parent lease renewal is separately available through the scheduler
heartbeat. Neither mechanism proves shared control storage or automatic
failover.

## Completion roadmap

1. **Bounded local parallelism — implemented.** The worker batch primitive is
   deterministic, capability-gated, bounded, evidence-bearing, and joined in
   declaration order.
2. **Restartable local child-task execution — implemented in this increment.**
   The runtime has immutable expected membership, bounded claim/execute passes,
   terminal replay, fenced leases, mechanical failure preservation, explicit
   incomplete-join refusal, lease renewal for long-running handlers, and a
   durable joined receipt. Do not let child
   workers mutate shared semantic state.
3. **Recovery and join proof — local child and parent control boundaries
   implemented.** The private transaction sidecars, strict digest/history
   proofs, lock-safe reconciliation, crash-boundary tests, no-rerun recovery,
   receipt replay refusal, and PASS-stage checkpoint/resume are now implemented
   for child tasks, the parent run store, and the serial stage engine. A local
   workspace manifest capture/verification boundary is also implemented for
   restartable child completion and serial PASS-stage checkpoint resume;
   bounded local retry and executor-integrated provider-neutral evidence
   publication/replay verification and durable run-level concurrency evidence
   are implemented; durable parent cancellation requests now have an explicit
   completion-boundary policy. Complete cancellation policy, notifications,
   provider-specific capture, shared artifact storage, and cross-machine
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

### Retained local failure-reporting gap

PR #52's CI investigation independently reproduced a pre-existing boundary gap:
`executeClaimed` forwards arbitrary handler error messages to a child store that
requires nonempty text of at most 4096 characters. A 4097-character message or
an empty `Error` message is replaced by the store's validation error; the child
remains RUNNING with no receipt. This is separate from the takeover fixture's
premature clock advancement, and the original Windows error payload was not
retained. The exact Windows causal chain is therefore not established.

The local runtime candidate now converts blank diagnostics to a fixed message and
bounds oversized diagnostics to the store limit with a SHA-256 suffix identifying
the original text. The store retains its nonempty, 4096-character invariant.
Focused tests cover empty, whitespace-only, oversized, combined, and unprintable
errors; they verify durable `FAILED` mechanics, a blocked semantic receipt, and
retry within the declared attempt bound. The existing lease-loss and stale-owner
tests remain part of `runtime:test`. This candidate passed uncached `runtime:test`
and the runtime/dependency typechecks on its development branch.

The complete original diagnostic is not retained in a separate evidence record;
only the bounded text and digest are durable. This local repair does not establish
shared-service failure recovery, explain the historical Windows payload, or
authorize multi-machine claims.

## Explicit non-goals

- No second workflow engine for parallel routes.
- No hidden provider-specific scheduler in the contracts or coordinator.
- No automatic failover based only on an expired local lease.
- No treating a worker summary as proof without retained evidence.
- No deletion of legacy repositories or private overlays as part of this
  implementation increment.
