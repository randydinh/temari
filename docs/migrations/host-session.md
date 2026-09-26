# Experimental local host dialogue

This maintainer interface connects a stock Node process to an agent host that
can retain a terminal session and answer stage requests. It is a transport
prerequisite for public-entry migration, not a replacement `temari`,
`poteto-mode`, or `closeout` installation. It does not migrate their policy,
authenticate host capabilities, launch workers or prove distributed operation.

## Usage and ownership

Build and verify a new [canonical artifact](./canonical-packages.md). Keep that
trusted artifact and the two files under `packages/workflow-runtime/host/`
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
manifest digest pins the selected manifest across restarts, not authenticity
of the artifact. Verify the trusted runtime with its existing checker before
use; neither an adjacent manifest nor a parent-written transcript is a signature.

Connected invalid results settle through the engine's error path. A legitimate
`ISSUES`, `BLOCKED` or `DROPPED` result is terminal, not a pause or retry request.
EOF, interruption, lost output or the bounded session wait ending is process
loss: no synthetic PASS or BLOCKED is created to pretend work completed.
Read durable state after such a loss. An acknowledged prefix can resume;
unacknowledged candidate mutation and orphan manifests must be investigated,
not adopted. A terminal receipt is read-only and cannot be resumed, including
when the host missed the final output message.

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
