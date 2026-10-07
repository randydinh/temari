# Same-task systemic repair

Temari decides that a preserved correction or counterexample reveals a systemic
discrepancy and promptly starts bounded repair under the independently selected
existing task authority. Poteto supplies the method. The host launches actual
workers; the task ledger retains the obligation and exclusive launch reservation,
and `FileChildTaskStore` remains the worker lifecycle owner. Compatible parent
work continues after actual repair-worker start. The repair does not create a
canonical run, rebind the parent, create another chat, or authorize publication.

This implements Candidate B from the repair design arena with Candidate A's
actual-worker-start requirement. A supervisor heartbeat alone projects STARTING.
RUNNING requires its exact worker-start observation and a current child lease.
Schema-1 task ledgers replay with `repairs: []` until an additive repair event is
present. Existing task fields and historical parent acceptance stay intact.

## Admission and installed operations

The installed Temari entry supports one bounded support operation, rather than
another unconstrained workflow route:

```sh
node /absolute/installed/bin/temari.mjs repair start \
  --request /absolute/repair-request.json \
  --expected-request-sha256 TRUSTED_REPORT_DIGEST \
  --expected-manifest-sha256 TRUSTED_INSTALLED_MANIFEST_DIGEST \
  --task-selection /absolute/current-task-selection.json \
  --expected-task-selection-sha256 TRUSTED_SELECTION_DIGEST
```

Use the same flag pairs for `repair status`, `repair readmit` and `repair accept`. Expected digests
must be independently selected by the trusted host/coordinator; hashing a
caller-written file does not grant execution permission. Task selection and the
owning invocation remain outside the discrepancy report. Poteto's public entry
does not own these operations.

The start request contains the existing task command (`taskId`, actor,
idempotency key, current expected version) and this bounded report:

```json
{
  "repairId": "repeated-correction",
  "counterexample": "Observed failure retained in the selected evidence file.",
  "affectedSurface": "Installed entry",
  "expectedInvariant": "Repeated reports retain one repair launch.",
  "evidenceRefs": [
    {
      "kind": "counterexample",
      "location": "/absolute/observed.txt",
      "sha256": "INDEPENDENTLY_SELECTED_DIGEST"
    }
  ],
  "requestedScopes": ["EXISTING_OWNING_SCOPE_ID"],
  "regressionContract": "HOST_SELECTED_REGRESSION_ID",
  "requiredRoute": "full-playbook"
}
```

`requiredRoute` expresses the authority Temari determines the repair needs; it
cannot grant that authority. Shared boundaries, migrations, reported defects and
unexplained symptoms cannot be relabeled to fit a lightweight owning invocation.
The host rejects executable, command and verification fields in this report.

The separately pinned selection contains `schemaVersion: 1`, task store root,
task ID, original workspace root, an `authority` profile path/digest, and an
`owningInvocation` with its original request path/digest, installed artifact
root/manifest digest and `hostProofSha256` (null for a qualified lightweight
owner). The existing trusted public engineering classifier is run again.
Full-playbook owners must reopen their actual architect/worker/reviewer/forge
host proof; pending proof, a profile and a handoff cannot admit launch. Repair
uses that proof's exact integration candidate, and its typed file/directory
ownership must fit the original admitted ownership. Lightweight owners retain
their admitted candidate, revision and scope and cannot admit a full-route repair.

The selected existing bounded host profile fixes candidate revision, local Codex
transport and executable digest, typed ownership, timeout, independent builder
and reviewer assignments, verification commands, baseline artifact, artifact
build command and regression commands. Its `commandInputs` pin executable,
helper and input file byte identities independently of command argv. The host
requires direct build/regression helper and file input argv to use absolute pinned
paths; relative file helpers are refused so a changing baseline/fresh working
directory cannot select a different assertion. Artifact-under-test arguments use
the exact `$ARTIFACT` or `$CANDIDATE` placeholders. The trusted host owner includes
all transitive helper/input identities in the selection. The host rechecks these
before and after execution and during evidence reopening; changing an assertion
between baseline and fresh runs cannot produce repair PASS. The local host
resolves its Codex transport independently; the profile cannot substitute another executable.
Requested scopes must fit the owning scope. An earlier `repair-authority`
handoff reference is only a continuity/integrity link: handoff references convey
no execution permission.

Missing authority persists a BLOCKED obligation with the precise boundary and
no launch. After independently obtaining missing authority, use `repair readmit`
with the same immutable report, a fresh command key and current task version.
Its additive admission event retains the refusal history and replaces that one
never-launched obligation. Ordinary `start` remains observational for repeated
reports. A launched or uncertain repair can never be re-admitted; there is no
generic retry or cancellation command.

## One launch and independent review

`repair-bound` atomically retains the report digest, selected admission, child
group and PENDING launch reservation before spawn. Only the writer whose event
was newly applied can ask the host to launch. The host also exclusively reserves
`intent.json` before starting a detached supervisor. Existing intents are never
reclaimed. The one-member child group uses the existing restartable executor
with one attempt and lease renewal; it is independent of the parent run. Admission
freezes the exact clean source into an isolated clone and pins its commit, tree
and prior independently verified authority evidence. Execution and later status
reopen that immutable candidate. Compatible parent source edits outside repair
ownership, including a new original HEAD or untracked files, do not invalidate
the child or replace the logical task/workspace/run.

The supervisor retains its nonce/start identity, heartbeat, actual builder start
observation and terminal drained record. Worker start binds task, repair, launch,
child execution, candidate transport and manifest selection to the independently
observed PID/start time. Repeating the same repair ID and report under another
client key observes the existing obligation. Changed reports are refused; new
obligations compare the task version before mutation. Runtime observations reload
current versions so parent progress is preserved across launch acknowledgment.

A lost acknowledgment, missing/stale heartbeat or expired child lease projects
RECOVERY_REQUIRED. Status inspects the original identity only. Lease fencing is
not evidence that a side-effectful process stopped and never permits relaunch.
No start/status path reexecutes an uncertain reservation.

Worker PASS projects NEEDS_REVIEW. The host reopens the exact integration commit,
builder/reviewer process records and their retained receipts. It executes the
same counterexample against the baseline installed artifact (failure required),
builds a fresh artifact from the integration commit, and runs the same assertion
plus the profile's neighboring checks against the newly installed artifact.
Fresh source inventory must match the clean integration candidate. New command
diagnostics stream to files with backpressure and no retained cap; stdout/stderr
paths, complete byte counts and hashes are rechecked during evidence reopening.

The repair child also requires the runtime's retained failure diagnostics. It
streams available owned command and worker logs into the private failure evidence
store, alongside the full normalized thrown error. Early validation failures
retain the error even when no process log exists; missing logs are never claimed
as captured evidence.
Installed launch/controller failures before child handling also retain the complete
nested cause and available supervisor log through the same streaming evidence API.
The uncertainty ledger pins a typed controller observation; its bounded reason
contains a diagnostic identity. Status reopens the observation and full artifacts
before it can treat a later observation as successful repair evidence.

`repair accept` takes the existing task command, repair ID, substantive review
reason and independently selected candidate/artifact/regression evidence. The
selection fixes candidate root/revision, artifact root/manifest digest, and
regression evidence path/digest. Resolution is appended only after everything
reopens. It neither accepts the parent's canonical run nor satisfies a separate
feature/forge closeout. Pinned counterexample refs reopen on every status and
verification read. Missing or modified counterexample, helper or retained result
evidence invalidates resolution and
prevents the parent from projecting DONE, while historical acceptance remains
auditable.

Ordinary task pickup without a repair verification host truthfully reports
RECOVERY_REQUIRED even for a prior resolution. Use the supported selected
installed `repair status` path to reopen repair evidence and the parent's
canonical acceptance. This read-only recovery path can project parent DONE when
both independently verify; it launches no workers and infers no permission from
handoff context.

## Verification and limits

Run `pnpm exec nx run runtime:repair-test` for schema-1 compatibility, no-run and
active-parent continuity, repeated reports, stale versions, missing/widened
authority and actual installed-entry process tests. These build a relocated
current public bundle, launch real builder/reviewer processes against an owned
durable-product fixture, permit concurrent parent progress, kill the initiating
client before acknowledgment, reopen in another process and prove no duplicate
launch. The same fixture rebuilds/installs its repaired product and executes the
preserved counterexample and neighboring behavior checks. Log tampering/deletion
revokes resolution and canonical parent DONE. Existing task behavior remains
covered by `runtime:task-test` and `runtime:task-typecheck`.

Deterministic worker fixtures prove installed machinery and evidence boundaries.
They do not prove that a live model recognizes a discrepancy or invokes repair,
or establish canonical public Feature/forge completion for this source change.
The runtime verifies Temari's selected `requiredRoute` and the prior owning
admission. It does not classify counterexample prose. A fresh coordinator
evaluation recognized duplicate launches as a reported defect and refused the
supplied lightweight-only authority. That result proves recognition and refusal,
not positive live initiation. Positive initiation requires an actual independently
selected full owning invocation and its reopened host proof.
