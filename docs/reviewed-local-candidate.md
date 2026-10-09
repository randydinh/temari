# Reviewed local candidate source operation

`reviewed-local-candidate-v1` is an explicit source-only Temari operation for
one coupled builder, read-only architect/planner, a distinct reviewer against
the integration commit, protected external checks and local delivery. It has
no forge or publication action. It never falls back from `feature-v1` and does
not change the installed public policy or conformance bridge.

`createReviewedLocalCandidatePlan()` fixes the six stages, required delegation,
independent review, revision-bound evidence and concurrency of one. The source
host bridge is `packages/workflow-runtime/host/reviewed-local-candidate.mjs`;
`ArchonHarness.startReviewedLocalCandidate()` selects the separate source
native workflow in the host directory. Run host `admit` before native dispatch with independently
computed request, bridge and bridge-runtime hashes. Each native node checks the bridge and runtime hashes,
then calls `capture` with the external request digest and exact native run ID.
Archon retains native control. `TaskRuntime.dispatchReviewedLocalCandidate` retains dispatch intent,
and its exact native reconciliation and cancellation controls remain unchanged.

The pinned Archon 0.10.1 Bash schema uses numeric `timeout` milliseconds; an
omitted value defaults to 120,000 ms. Every node in this source workflow now
declares a finite budget:

| Node        | Native timeout | Composed allowance                                                                |
| ----------- | -------------- | --------------------------------------------------------------------------------- |
| investigate | 30 minutes     | Sum of baseline-check limits + worker limit + 3-minute admission/evidence reserve |
| plan        | 3 minutes      | Admission and proposal/evidence readback                                          |
| build       | 30 minutes     | Worker limit + 15-minute clone/integration/receipt reserve                        |
| review      | 18 minutes     | Worker limit + 3-minute admission/evidence reserve                                |
| verify      | 15 minutes     | Sum of acceptance-check limits + 3-minute admission/evidence reserve              |
| deliver     | 3 minutes      | Admission and retained-candidate/evidence readback                                |
| finalize    | 5 minutes      | Full semantic/canonical readback and persistence                                  |

Admission refuses requests whose summed check/worker limits exceed those
envelopes, and reports their coverage. The existing 900,000-ms worker maximum,
600,000-ms per-check maximum, output limits and one-handler-attempt rule remain
unchanged. The reserves are finite operational allowances, not a guarantee
that arbitrary filesystem/Git delays will fit. The regression parses the actual
native YAML and checks every node against these admitted limits. Node budgets
do not extend the separately supervised 45-minute observation/progression
deadline or prove termination of detached bridge/worker/check processes.

The JSON request fixes profile, task/run identities, clean repository/base,
disjoint existing evidence root, exact plan/policy digest, Codex executable
selection (provider, version and SHA256), three required distinct worker briefs,
sole builder ownership, acceptance outcomes, protected files and baseline /
acceptance command argv with bounded timeouts. Protected executables and input
files are outside the candidate and hashed before execution and closeout.
`{candidate}` and `{evidence}` substitutions are argv strings, never shell code.
The host requires a pinned account-catalog snapshot for the selected CLI version,
plus the actual user-config path, its initial digest and the requested
model/reasoning. It
matches a three-part release catalog version to either the same stable CLI
version or an `alpha.N` CLI build of that release (for example,
`codex-cli 0.162.0-alpha.2` with catalog `0.162.0`). The complete executable
version and SHA256 remain exact pins; the retained catalog observation includes
both versions. Different releases, leading zeros, build metadata, other
prerelease forms and malformed versions are refused. This bounded compatibility
rule establishes a version relationship, not model execution proof. The host
parses that config with a byte-pinned Python TOML parser, refuses unsupported
catalog models or reasoning, and refuses ambiguous profile/provider/project
overrides. The first admission requires the live config digest to equal the
externally pinned initial digest and seals a sanitized baseline receipt under the
run evidence root. That immutable receipt contains only the digest, critical
projection and provider selection. Later admissions verify the receipt. Parsing
uses the exact bytes already read and hashed through the pinned parser's stdin,
so reopening a changed path cannot mix observations. Every stage records separate
admission-time and completion-time observations with initial/current config
digests and a raw-drift flag. Changes to unrelated preferences are diagnostic
when the execution-critical projection is unchanged; changes to model, reasoning,
provider, profile or catalog override fail closed before stage completion. Raw
config contents are not retained. A cached catalog is a prerequisite, not server
execution proof. Pre-native admission verifies that the pinned CLI advertises
`--ignore-user-config`, `--model` and `--config` as well as the structured-output
and sandbox flags. Workers use the admitted executable's resolved path with those
explicit selection flags. Authentication still comes from `CODEX_HOME`; no
credentials are copied. Model and reasoning observations stay null when the
transport does not expose them; explicit CLI selection is not served-model proof.

The existing write-worker controller validates owned changes and integrates
patches into an isolated clone. The read-only reviewer sees that exact commit.
Each operation uses the existing child store with renewable lease and one total
handler attempt. Stage captures retain baseline, integration, plan, policy,
request, native, child and process identities, plus evidence file hashes.
Before child acceptance, the host publishes the exact operation-result bytes
as portable `worker-result` evidence and a `verification` manifest through the
existing evidence store. The manifest freezes the native/request/policy/plan
binding, complete assignment, input and output candidate identity, result-file
digest, and hashes of external worker/receipt/patch evidence. Successful build
publication and readback require the operation's integration and patch to match
the write receipt, its exact assignment and baseline, and the clean candidate.
Stage refs also retain the accepted parallel receipt and both portable artifacts.
Replay opens captures; it cannot rerun a successful builder. An uncertain
intent refuses further dispatch. For a lost build capture after an accepted
child, supply `--intent-sha256` independently; capture reconstructs the result
only through a pre-existing PASS receipt read path. It uses the runtime's
existing replay validation to check group/assignment identity and portable
evidence, matches the receipt outcome to the SUCCEEDED child, and verifies the
frozen operation bytes and external hashes before using the retained result.
It never takes a new evidence snapshot or falls through to worker dispatch.
Missing/inconsistent receipts, artifacts, result files or evidence refuse
recovery; older reduced child results without the manifest are not upgraded.
Unaccepted or ambiguous work stays blocked. Native uncertainty uses the existing
`TaskRuntime.reconcileNative` with exact executor identity; never start again.

After six valid captures, `finalize` independently reads every artifact and
reopens each worker's accepted receipt and portable evidence through that same
read path, comparing the captured operation and refs with the accepted child.
It then
uses `executeAndPersist` and the canonical evidence store. It does not write
a hand-made workflow success receipt. `readReviewedLocalCandidateResult()`
then checks the task's current run, confirmed controls, exact successful native
observation, canonical evidence and the host-selected candidate verifier. It
rechecks task version after verification to reject concurrent control/replan.
This is a separate local-candidate result; generic `TaskRuntime.accept` still
refuses stronger delegation/review/forge profiles. Retain the completion path
and digest in the task handoff; ordinary task snapshots remain NEEDS_REVIEW
rather than claiming generic DONE.

Run `pnpm exec nx run workflow-runtime:managed-candidate-test` for source
fixtures. Source fixtures prove mechanical contracts, not live coding, model
quality, camera hardware, another provider/host, or installed bundle admission.

## Dashboard source launcher

The source dashboard can select a host-owned `managedCandidate` configuration
and a planning policy with `profile: reviewed-local-candidate-v1`. That policy
admits exactly one builder slot; ordinary planning and implementation policies
still require two to four independent slots. The policy's preparation and
verification argv must equal the protected baseline and acceptance checks in
the managed profile. The managed planner uses the pinned executable and explicit
model/provider/reasoning flags. Its proposal supplies bounded goals and criteria,
never executable paths, roots, commands or provider selection.

`tools/dashboard-managed-candidate.mts` validates canonical, disjoint source,
preparation, evidence and task roots and protected input pins. The controller
also requires a separate canonical Archon home. An accepted proposal freezes
the request outside the source tree, records goal/proposal/planning-policy and
managed-policy digests, initializes the exact child store and admits the request
before binding a new run on the same task. Interrupted immutable preparation is
retained for explicit recovery; it is never overwritten with another candidate.

The host profile also fixes `bridgeRuntimeExecutable` and
`bridgeRuntimeSha256`: an absolute canonical Bun executable and its exact bytes.
It must be an external protected input. The immutable request, preparation and
dispatch intent retain that identity. Controller admission/result verification
and Archon admission invoke the absolute pinned runtime. Native capture/finalize
nodes receive the same identity and check its digest before invocation; none
resolves `bun` through PATH. A changed digest, relative executable or path alias
refuses effects. Older frozen launchers/requests need a new binding to adopt
this source contract.

`TaskRuntime.dispatchReviewedLocalCandidate` records the protected inputs as
dispatch intent and calls the managed harness admission port. Generic dispatch
refuses this entrypoint. The managed dispatch reports whether this caller owns
the launch, so concurrent duplicate requests cannot enter the one-shot readiness
gate twice. The controller retains the exact returned reference before readiness,
shares a ten-second abortable readiness window and records its observations.
Lost responses remain uncertain; readiness refusal records a blocker and keeps
the existing reference. Exact reconciliation and cancellation remain host
recovery operations. This controller increment does not provide a new cleanup
supervisor or claim that refusal proves native/process termination.

On explicit exact-run observation of native success, the controller selects
`output_root/artifacts/runs/<native-id>` under the configured Archon home. It
attaches that run's canonical evidence, invokes the pinned bridge's semantic
`verify` command through `readReviewedLocalCandidateResult`, and retains the
candidate root, commit and completion digest in the task handoff. Read-only
dashboard/Talk projection reopens this result and its native identity instead
of trusting the handoff text. The task remains `NEEDS_REVIEW`; no generic
acceptance or `DONE` transition is added.

Run `pnpm exec nx run runtime:dashboard-managed-candidate-test` for the synthetic
Talk intake → planner → preparation → managed launch → native success → reviewed
result journey and refusal/replay cases. These fixtures inject admission and
native ports and publish synthetic canonical stage evidence. They establish
controller composition, not another live execution or real reviewed product
candidate. A host must select a frozen external profile and source checkout
before a separately admitted live run. Automatic observation/sustained dashboard
supervision, installed bundle promotion and publication remain later work.

Cancellation retains failures and terminates owned subprocess groups. A late
cancel after an already completed capture reads that outcome without dispatch;
route closeout still requires current native success and resolved controls.

## Managed ownership and shutdown

The source route uses the existing child store for stage authority and each owned
worker/check operation. Runtime owns launch permission, supervision, cancellation,
lease fencing and result acceptance. The POSIX host adapter owns live IPC handles,
process groups, termination and cleanup evidence. Native status and cleanup are
separate observations; FAILED or CANCELLED alone does not prove that work stopped.

Prepare a **new** externally pinned request and run binding for this source revision.
Add an existing absolute `taskStoreRoot` to the request. Before native dispatch,
initialize the child store at `<evidenceRoot>/<runId>/children` and put that exact
path in the selected `TaskRunBinding.executionStoreRoot`. The task must already
select the request's run, revision and plan, and retain its exact native reference
before useful work. This link lets the ordinary task store
refuse replacement while owned work or cleanup is unresolved, and lets pickup
show the same child records. Inspection reconciles the retained group rosters,
state files, event logs and transaction sidecars under the existing store lock.
Missing or corrupt retained members refuse replacement; valid interrupted
transactions use the ordinary reconciliation path. Do not change a historical
binding to add it.
`startReviewedLocalCandidate` requires the selected instance's absolute
`ARCHON_HOME`; it supplies native executable/hash/home workflow inputs. CLI
capture/finalize independently query that exact native run and retained binding.
Library callers must supply a separately selected `observeSupervisor` port.

Initial investigate can start before the dispatch caller publishes its returned
native reference. It waits at most 10 seconds, polling every 100 milliseconds,
only for the existing matching pending dispatch and selected task/run, revision,
plan and child-store binding. Cancellation, terminal native state, changed
identity or failed observation ends the wait. No stage authority, worker or check
starts before the caller publishes the exact reference and independent native
observation validates it. The bridge never creates or adopts a reference. Replay,
later stages and finalize refuse a missing reference immediately; a previously
published reference cannot reenter the startup wait.

The selected native record can also be published as `pending` with
`working_path: null` after the dispatch reference is returned. For a **new**
source-pinned host launcher, call
`ArchonHarness.waitForRunIdentityInitialization(reference, options)` only after
`TaskRuntime.dispatch` has durably bound the reference and the launcher has retained
its exact reference/readback. The adapter reads only `workflow get <exact ID>
--json` through that selected harness, workspace and dedicated `ARCHON_HOME`.
Every read first verifies the ID, workflow and all eight canonical binding fields.
Only exact `pending` plus an explicitly null workspace may wait. READY requires
`running`/`in_progress` and the existing absolute, real-path-equal workspace
invariant on the same record. Contradictions, missing/malformed fields, unexpected
or terminal states and command failure end the gate without another dispatch.

The named startup default and hard maximum are 10 seconds; polling is 100 ms.
Every read receives at most 2 seconds and the remaining window, and each read,
delay, path validation and observation-retention callback shares the earlier of
that monotonic limit and the caller's `deadlineAtMs`. Abort also interrupts a
pending read; a late response cannot grant readiness. `onObservation` receives
numbered PENDING/READY observations with native ID, status, workspace and elapsed
time. Failure throws `ArchonIdentityInitializationError` retaining the exact
reference and prior observations. The host retains these diagnostics and enters
its existing exact-reference cleanup/fencing path. An uncooperative injected
reader can outlive logical refusal; this gate is not native/process termination
proof.

This gate is one-shot per exact identity in the selected harness instance;
changing `startedAt` does not reopen it. Strict successful verification also
closes the initialization opportunity. `verifyRunIdentity` remains the default
for later observations, recovery and cleanup and rejects a missing workspace
immediately. Never put the initialization wait inside `start`, create a new
harness to retry it or replace a reference after refusal. Runtime and the live
managed bridge retain ownership, cancellation, claims and cleanup authority;
this read-only host gate grants no child or worker rights.

A separately reviewed **new frozen launcher** must wire the gate as follows.
Its existing interruption and stop/deadline handlers must also abort the
`readinessAbort` controller, created before dispatch. Preserve the launcher’s
existing cleanup path and reserved cleanup budget:

```js
// Dispatch has returned, persisted nativeRef, and retained exact reference/readback.
assertProgress();
const remainingMs = Math.floor(budget.workRemaining());
assert(remainingMs > 0);
await workHarness.waitForRunIdentityInitialization(reference, {
  timeoutMs: Math.min(10_000, remainingMs),
  deadlineAtMs: Date.now() + remainingMs,
  signal: readinessAbort.signal,
  onObservation: (event) =>
    retain(`native-readiness-${event.attempt}.json`, event),
});
assertProgress();
verifiedReference = true;
```

On failure, keep `verifiedReference` false and preserve the already persisted
reference for strict exact cleanup/reconciliation. Later observations must call
strict `verifyRunIdentity(reference)` before reading status; recovery and cleanup
continue using that strict port. This source addition does not update a released
launcher or admit another trial. Refresh source manifests and independently pin
new launcher bytes before any separately authorized release. Existing source
TaskRuntime dispatch already persists before returning; its reconciliation and
result readers use strict identity verification and need no startup exemption.

A process is gated behind durable PREPARED ownership and a live stage claim.
The adapter prepares a guardian and an idle group anchor. Runtime retains their
witness against the exact invocation, task, native run, stage, attempt and fencing
epoch before permitting useful work. Known Codex and write-runner subprocesses
inherit that owned group. A guardian IPC disconnect also closes the gate and
cleans the owned group after a bridge SIGKILL, without requiring a signal handler
in the bridge. A live TERM-resistant anchor preserves group ownership throughout
the grace period; no recovered PID or process name is a signalling capability.

| Boundary                      | Finite allowance                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Initial reference publication | At most 10 seconds; poll every 100 milliseconds; cancellation aware                                     |
| Independent supervision       | Poll every 1 second; native read command capped at 2 seconds; runtime observation capped at 3.5 seconds |
| Child/stage lease             | 15 seconds; renew only after current task/native supervision validates                                  |
| Unreleased launch gate        | 5 seconds                                                                                               |
| Graceful group termination    | TERM, then 150 milliseconds before KILL                                                                 |
| Group absence observation     | Up to 1.5 seconds after escalation                                                                      |
| Adapter settlement fallback   | Command timeout plus 10 seconds; unresolved completion stays fenced                                     |

Explicit cancel, terminal native status, changed task binding, parent loss, failed
observation or lease loss revokes new dispatch and late result acceptance. Queued
work is cancelled; active child cancellation propagates into the transport.
Cleanup receipts are hashed into stage evidence and independently reopened on
replay and closeout. Finalize checks supervision for each canonical handler and
before completion publication. These checks do not extend the 45-minute trial
supervision deadline or change the existing native timeout table.

For recovery, select the exact retained stage group from the existing child store
and call `recoverManagedExecutionGroup(store, adapter, groupId)`. It reads matching
nonce/binding/witness receipts, records CLEANED only after confirmed group absence,
and settles the old cancellation under canonical leases. It never signals a
recovered PID. Missing, changed or uncertain cleanup stays blocked; do not retry
with a new owner, clear an intent, delete a store or overwrite evidence. A confirmed
recovery permits a separately admitted replacement binding, while same-invocation
worker replay remains denied. Accepted builder capture reconciliation remains a
read-only R1 path and additionally requires completed ownership/cleanup.

Local store locks now retain a unique owner record. After a crashed owner is
observed absent, recovery claims that exact owner generation before releasing its
lock. A reused live PID, missing owner publication, corrupt metadata or interrupted
lock recovery stays uncertain. This is local-store recovery, not process control.

The proved host is macOS POSIX, with Node and Bun synthetic transport checks.
Windows is refused before any managed process launch. Linux uses the same POSIX
mechanism but has not been exercised here; unreaped group members can correctly
leave cleanup unresolved. Cleanup CONFIRMED means the owned process group is
absent. Arbitrary subprocesses that deliberately daemonize, detach into another
session/group or use another host are outside this capability. Direct launcher
and owned operation subprocesses are forced to inherit the group; this is not a
claim of OS containment for arbitrary Codex tool implementations. Unidentified
native startup descendants, guardian destruction, simultaneous OS failure and
unbounded filesystem stalls are not covered. Preserve uncertainty rather than
promoting this into whole-host shutdown assurance.

Run `pnpm exec nx run workflow-runtime:managed-shutdown-test` for model-free
synthetic process, crash, race and recovery tests, and `managed-shutdown-typecheck`
for the typed fixtures/operation entry. The existing `managed-candidate-test`
retains the timeout, accepted-result binding and no-replay regressions. Set
`WORKER_SHUTDOWN_FIXTURE_EVIDENCE_ROOT` to an absolute scratch directory to retain
fixture ledgers and witnesses; those archived PIDs are evidence only.
