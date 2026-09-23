# Draft design: cross-machine failover

**Status:** Manual failover is the current operating choice. Automatic failover
is a future design draft, not an approved implementation plan. The current Nx
runtime does not yet support cross-machine recovery.

## Current choice

- A person initiates takeover on another machine after confirming that the
  previous coordinator has stopped or is prevented from acting.
- Same-machine restart recovery remains in scope.
- Cross-machine recovery requires run state and evidence to be available outside
  the failed machine, either through shared durable storage or a documented
  restore path. Local-only files do not meet this requirement.
- Automatic coordinator election and unattended takeover are deferred.

The runtime currently stores run records and events in separate local files.
Its run lease can be reclaimed after expiry, but the runtime has no task-level
checkpoints. Evidence references contain an absolute local path. These adapters
are not a cross-machine recovery mechanism.

## Automatic failover draft

The future design would run coordinator instances on separate machines. One
instance owns each run at a time. The shared control store determines ownership
and preserves the run independently of either coordinator machine.

Coordinator A and Coordinator B use the shared control store. The active
coordinator sends durable dispatch requests to workers. Workers save outputs in
shared artifact storage.

### Shared control store

Use a highly available transactional store outside the coordinator machines.
The specific database or provider remains undecided. Store:

- The immutable run revision, plan digest, and task dependency graph.
- Task state, each attempt, its owner, lease, result, and retry history.
- Coordinator ownership, append-only events, and durable dispatch requests.
- Portable references to evidence, logs, and workspace checkpoints.

Commit a state transition and its corresponding audit event in one transaction.
The current file store writes those separately, so a crash can leave them out of
sync.

### Coordinator takeover

The active coordinator renews a lease using the shared store's clock. A standby
can claim the run after the lease expires. The claim increments a fencing epoch.
Every later state update and result commit must include the current epoch, so a
paused coordinator cannot resume and overwrite the new owner's work.

### Dispatch and task recovery

Record dispatch intent in the same transaction that makes a task eligible.
An outbox or equivalent dispatcher sends the work and retries safely after a
restart. Dispatch is at-least-once, so each assignment needs a stable
idempotency key.

On takeover, recompute which tasks are ready from the saved dependency graph.
Reuse completed tasks only when their result and evidence still validate.
Retry incomplete or expired attempts according to the task's retry policy.
Required delegation or concurrency must remain required; if the replacement
host lacks a required capability, report BLOCKED. Record both the requested and
actual execution modes. Record serial fallback as a degradation when the
workflow permits it; otherwise report BLOCKED.

### Evidence and workspace recovery

Store evidence in shared durable artifact storage under portable keys and
content hashes, not machine-specific absolute paths. Code-changing tasks also
need a recoverable workspace boundary. Save accepted changes to a shared branch
or checkpoint, or restart an interrupted attempt from its last saved revision.
Uncommitted files that existed only on a lost machine cannot be recovered from
the run database.

### Availability and verification

The database and artifact store need their own redundancy and backups. Two
coordinators do not provide failover if both depend on a single database or
artifact server on the failed machine.

Before enabling automatic takeover, test coordinator loss at every
state/dispatch/result boundary, competing claims, network partitions, a stale
coordinator returning, artifact-store outages, and restoration from backup.
Verify that only the current fencing epoch can commit, committed state survives,
and retries do not duplicate unsafe external side effects.

## Guarantees and open decisions

- Proposed target: no loss of committed run state, subject to the durability
  and replication guarantees of the selected control store. This is not a
  guarantee of the current file store.
- In-flight work may need to run again after a failure. Temari cannot promise
  exactly-once effects for arbitrary external systems; integrations need
  idempotency support or a reconciliation or human-review step.
- Choose an acceptable recovery time objective (RTO) and recovery point
  objective (RPO) before implementation.
- Choose the control-store and artifact-store providers, backup/restore
  procedure, workspace checkpoint policy, and which hosts may take over.

Automatic failover remains a draft until those decisions and failure tests are
accepted.
