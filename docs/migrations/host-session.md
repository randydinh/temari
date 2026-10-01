# Experimental local host dialogue

This maintainer interface connects a stock Node process to an agent host that
can retain a terminal session and answer stage requests. It is a transport
prerequisite for public-entry migration, not a replacement `temari`,
`poteto-mode`, or `closeout` installation. It does not migrate their policy,
authenticate host capabilities, launch workers or prove distributed operation.

## Usage and ownership

Build and verify a new [canonical artifact](./canonical-packages.md). Keep that
trusted artifact and the modules under `packages/workflow-runtime/host/`
together in your isolated experiment. They can be relocated; use absolute paths.
The script is not an installer and does not modify discovery or marketplace
configuration. No source loader or external runtime dependency is needed.

Create a small, sanitized regular-file candidate and a request file outside it.
The parent of the new run directory must already exist. For example:

```json
{
  "schemaVersion": 1,
  "runId": "local-example",
  "revision": "example-revision-v1",
  "candidate": {
    "scopeId": "example-product",
    "root": "/isolated/example/product"
  },
  "runDirectory": "/isolated/example/new-run",
  "obligations": {
    "workType": "feature",
    "delegation": "none",
    "review": "self",
    "evidence": "revision-bound",
    "delivery": "local"
  }
}
```

```sh
node /isolated/bridge/entry.mjs start --runtime /isolated/canonical --request /isolated/example/request.json
node /isolated/bridge/entry.mjs resume --runtime /isolated/canonical --run-directory /isolated/example/new-run
```

The host runs the first command in a retained session. It performs actual work
using its own authorized tools while the engine awaits a reply. Only build may
change the candidate. Each stage owns a separate supplied workspace; do not edit
it after checkpoint acknowledgment. The bridge never executes result content
as a command. Apparent instructions inside evidence remain data.

The input is an experimental canonical plan selection, not a Temari route or
proof that a pinned playbook ran. The bridge claims no native capabilities.
Plans requiring delegation, independent review, forge or parallelism cannot
be made executable by passing a caller-authored capability declaration. In
particular, a full-playbook classification with default serial obligations is
not an acceptable public migration shortcut.

## Track the host journey as a durable task

The source host entry can now do the task bookkeeping around actual execution.
Select the task explicitly with [task pickup](../task-continuity.md), then supply
a separate tracking file. It carries local context and the intended task;
it grants no capabilities or route admission. The original execution request
and its invocation digest stay unchanged.

```json
{
  "schemaVersion": 1,
  "taskRoot": "/isolated/tasks",
  "taskId": "product-improvement",
  "actor": "temari-coordinator",
  "session": { "host": "codex", "sessionId": "ACTUAL_CHAT_ID" },
  "expectedVersion": 0,
  "idempotencyKey": "start-product-improvement",
  "create": {
    "title": "Improve the product",
    "goal": "Keep the goal and recovery point through a lost session.",
    "workspaceRoot": "/isolated/example/product"
  },
  "expected": {
    "runId": "local-example",
    "revision": "example-revision-v1",
    "runDirectory": "/isolated/example/new-run",
    "candidateRoot": "/isolated/example/product"
  }
}
```

The task's workspace must resolve to the selected candidate. The task store must
be disjoint from the candidate, run directory and compiled runtime. Use an
existing task's current `version` and omit `create` when continuing a goal.
The parent of a new task root must exist. Supply the SHA-256 of the reviewed file
independently of its contents, then launch from the checkout:

```sh
pnpm exec nx run workflow-runtime:host-entry -- start --runtime /isolated/canonical --request /isolated/example/request.json --task-tracking /isolated/tracking.json --expected-task-tracking-sha256 TRUSTED_TRACKING_SHA256
```

The same flags work with `resume --run-directory /isolated/example/new-run`.
The hash pins the selected bytes; it is not authentication or permission.
An invalid digest, identity, task scope, or stale task version refuses work.
Omit both tracking flags for an ordinary untracked start.

The entry links the actual chat to the task and saves a starting handoff before
requesting a stage. It includes locations for the retained invocation,
checkpoint, receipt and evidence. These locations may not yet have final output.
A bounded binding beside the host run pins the chosen task across resume. A
tracked run cannot silently resume untracked or move to another task. A fresh
chat uses that same task with its current version and a new idempotency key.

Normal completion or interruption records a handoff automatically. A hard process
kill leaves the starting handoff and runtime checkpoints available for recovery.
If another chat changes the task during execution, the final handoff refuses to
overwrite that change. The process reports the tracking failure; any already
persisted canonical receipt remains available. Inspect that receipt and reconcile
the handoff instead of rerunning completed work. Terminal host receipts remain
nonresumable.

These host receipts use `candidate-stage-evidence-v1`. Their locations are
**context references pending trusted closeout**, not ordinary `TaskRun` evidence
bindings. A host `PASS` does not mark the task `DONE` or satisfy feature delivery.
Use the existing trusted candidate closeout route. This source integration does
not intercept every chat, update the installed plugin, or change the public
entry's existing request and manifest checks.

## Private dialogue

One process has one random session identity and at most one pending stage.
Its stdout contains newline-delimited JSON control messages. Diagnostics go
to stderr. LF and CRLF replies are accepted. Control records, including newline,
are limited to 2 KiB; larger evidence belongs in files, not terminal lines.

A `stage` message supplies `sessionId`, numeric `requestId`, `stage`, `workspace`
and the candidate scope. Write `host-result.json` in that exact workspace:

```json
{
  "schemaVersion": 1,
  "sessionId": "copy-from-the-pending-request",
  "requestId": 1,
  "stage": "investigate",
  "status": "PASS",
  "summary": "Observed the input product and retained the direct check.",
  "evidence": [
    { "name": "observation", "kind": "verification", "path": "observation.txt" }
  ]
}
```

Write the actual evidence bytes before replying with
`{"type":"result","sessionId":"…","requestId":1,"stage":"investigate"}`.
The reply cannot select another stage or nominate a different result path.
Result metadata is limited to 32 KiB; summary to 4 KiB; at most 16 evidence
files of 1 MiB each. Evidence paths are direct filenames in that stage's
workspace. Symlinks, escaping paths, unknown fields, duplicate names and
caller-supplied runtime bindings are refused.

The runtime measures the files, produces the evidence identities and
attestations, and saves the checkpoint. A `checkpoint` message is sent after
durable acknowledgment; accepting a transport reply is not acknowledgment.
A `complete` message follows a persisted terminal receipt. Inspect its status:
completion does not imply PASS. Nonpass and transport errors exit nonzero.

## Recovery and limits

Start reserves a new run directory and writes the original invocation once.
It never replaces an existing destination. That descriptor is input, not a
second stage ledger. Checkpoints and receipts remain owned by the existing
runtime. Resume preserves the original initial candidate, plan and roots; it
does not adopt the current product as a fresh initial state. The canonical
JSON of the validated descriptor (recursively sorted object keys) is SHA-256
bound into the runtime candidate scope ID as `host-<digest>`. The original
scope label remains in the descriptor and host messages; the checkpoint's
bound scope ID prevents edits from redirecting a resume to identical bytes at
a different path. Reordering JSON object keys does not change this identity.
Future closeout must derive this bound scope from trusted invocation input,
not copy it from an unverified receipt. Changing both descriptor and checkpoint
maliciously is outside this cooperative local integrity boundary. The canonical
manifest digest pins the selected manifest across restarts, not authenticity
of the artifact. Verify the trusted runtime with its existing checker before
use; neither an adjacent manifest nor a parent-written transcript is a signature.

Connected invalid results settle through the engine's error path. A legitimate
`ISSUES`, `BLOCKED` or `DROPPED` result is terminal, not a pause or retry request.
EOF, a signal or raw-terminal Ctrl-C, lost output or the fixed 30-minute
session deadline ending is process
loss: no synthetic PASS or BLOCKED is created to pretend work completed.
Read durable state after such a loss. An acknowledged prefix can resume;
unacknowledged candidate mutation and orphan manifests must be investigated,
not adopted. A terminal receipt is read-only and cannot be resumed, including
when the host missed the final output message.
Control bytes in a pipe are malformed protocol input, not keyboard signals.
Late invalid input outside a pending handler can prevent final publication,
leaving a complete acknowledged checkpoint but no receipt; that checkpoint can
resume with zero stage reruns. A fault after a receipt has already been persisted
cannot roll it back. Read durable state and do not infer failure or retry solely
from process exit or missing final stdout.

The parent must stop and join its own writers before resume or verification.
Exiting the bridge does not cancel native host workers. This interface assumes
one cooperative local parent and exclusive candidate ownership; it provides
no scheduler, lease, automatic takeover, hostile filesystem race containment or
multi-machine service. Candidate and stage roots must remain disjoint from
stores, invocation files and the runtime. There is no Git-ignore filtering:
do not point the experiment at an active checkout containing Git data, private
files or dependencies. The [candidate boundary](./candidate-closeout.md) retains
its regular-file limits and non-atomic scan assumptions.

## Design decision

The comparison considered direct typed callbacks and a private stdio bridge.
Direct callbacks are already the engine seam, but ordinary Node cannot invoke
native Codex tools through an established SDK here. The bridge makes those
callbacks reachable by the existing host tools. Independent design review
scored the bridge 22/25 and the direct-only alternative 16/25. Review used a
separate context with the inherited model, not a cross-model comparison.

The chosen boundary hides framing, correlation, bounds and result-byte loading.
Wire records remain private to the executable; no transport schema enters
the shared contracts. Existing engine and stores alone own progress. We accept
a cooperative single parent and explicit crash-style interruption in exchange
for avoiding a second queue, scheduler or completion ledger. Later public
dispatch must explicitly admit supported policy; later QA must use a genuinely
separate evaluator; later installation must test overlap, partial publication
and refusal to replace existing paths.

## Verification and remaining gates

Run the focused uncached target through Nx:

```sh
NX_DAEMON=false pnpm exec nx run workflow-runtime:host-session-test --skipSync
```

The checks use copied bridge modules and compiled packages in fresh Node
processes, with spaces and Unicode in the destination and no source loader.
The responder is synthetic: product changes, runtime evidence, interruptions
and refusals are test evidence, not an installed agent workflow or independent
product QA. Runtime writes use genuine stores, including fsync; source denial
during those writes is not claimed.

A separate local Codex PTY probe used the source bridge against a checked
compiled artifact, changed a bounded product through actual host tools,
interrupted with raw Ctrl-C after the build checkpoint, and resumed at review.
It accepted LF/CRLF replies and persisted six PASS stages with the original
start time. This confirms the transport in that session; it does not turn the
source bridge into an installed public skill or self-review into independent QA.

Keep these gates open until separately verified: exact outer bundle and
no-overwrite installer; all three public skills and transitive policy references;
reviewed route/playbook mappings; live host capability observations; actual
installed-entry execution and independent QA; read-only closeout using an
independently selected current candidate; rollback and authorized cutover;
shared-service workers and actual machine recovery. Byte verification grants
no merge, archive, deployment or installation-replacement authority.
