# Review reconciliation intent in the dashboard

Use **Review open work → Reconciliation attempts** to inspect a retained plan,
check whether its task, run, candidate and Git source still match, and record a
local confirmation interaction. The panel appears before the captured inventory
so a large chat list does not hide it.

Temari carries the user's intent. Poteto supplies the engineering method. The
runtime owns durable task and reconciliation records; the selected native harness
owns execution. This panel records intent. Merging, preserving source contents,
archiving work and accepting a task require their owning workflows and evidence.
An Archon status does not substitute for a canonical completion receipt.

## Operator flow

1. Read the selected attempt's state and candidate status. The list shows the
   latest 50 retained attempts and reports omissions. Use **Exact retained attempt
   ID** to find an older record; browser input does not create a plan or select a
   source directory.
2. Open **Complete host-selected metadata review**. It includes the plan summary,
   proposed actions, affected paths, task/run/revision identities, scope and
   review digests, declared checks, and evidence references. Check definitions
   and expected comparison references describe requirements; they are not
   successful results. Raw source, diffs and executable command definitions are
   excluded.
3. Select **Check current binding**. A match is a timed observation, not a writer
   lock. A changed binding persists a blocked attempt. Unavailable readers refuse
   confirmation without manufacturing a match.
4. Select **Record confirmation intent** only after reviewing the complete
   selected metadata. The host checks the binding again, publishes an immutable
   local interaction event, reads and hashes its actual bytes, then checks the
   binding again before retaining confirmation.
5. Inspect the historic confirmation and use **Open task** for task details.
   Task navigation preserves the selected Talk topic and its in-memory draft.
   The candidate remains **not ready** and the task is not accepted by this action.

The actor label **local dashboard interaction** describes a verified event from
this local endpoint. It does not independently verify that a human clicked the
button or authorize source operations. A legacy record with that string is
classified as an external retained record unless its actual local event validates.

## When a response or binding changes

| State | Action |
| --- | --- |
| Review is incomplete, unselected or too large | Ask the owning host workflow to prepare and select a complete bounded review. The browser cannot add a selection pin. |
| Confirmation response is lost or malformed | Reload retained state. While the unresolved request remains in this page's memory, deliberately retry the exact same request if needed. Nothing is automatically resent. |
| Page or service restarted with an unresolved request | Inspect retained records and host interaction evidence before issuing another request. In-memory recovery is not a general process-crash recovery guarantee. |
| Binding changed | The blocked attempt stays blocked; prepare a fresh attempt through the owning workflow. Earlier confirmation history remains visible. |
| Local event is missing or corrupt | Retained confirmation history stays available, but the browser cannot claim a validated local actor/request identity. Investigate the evidence; do not fabricate a replacement. |

Reloading attempts and reviews reads retained state. It does not recapture the
open-work inventory, run checks, merge source, archive chats or accept a task.

## Enable the panel through the host

Use the established [dashboard setup](task-dashboard.md) and retain its task,
preparation, workspace and harness roots. Reconciliation is opt-in through the
host-owned control file's `reconciliation` settings:

| Field | Meaning |
| --- | --- |
| `storeRoot`, `sourceRoot` | Explicit reconciliation ledger and Git source roots. Task, source, preparation and interaction stores must satisfy physical path admission and separation checks. |
| `candidate` | The host-selected candidate ID, digest and portable root identity. These are declared bindings, not successful verification. |
| `resolutionIntent`, `requiredChecks`, `expectedComparison` | The retained plan's exact portable requirements and comparison references. |
| `browserReview.selectedAttempts` | At most 128 distinct `{attemptId, reviewSha256}` pins selected by the host from retained complete reviews. |

The current-binding reader obtains the current task/run from the real TaskRuntime,
candidate requirements from the host configuration, and source state from the Git
observer. The task must belong to the configured workspace and have a current
bound run. No browser-supplied task version, root, operator identity, timestamp,
check definition or evidence file is admitted as current authority.

Store and interaction roots are validated before initialization, including raw
parent traversal, physical directory identity and mutual containment. Interaction
publication uses exclusive immutable files and bounded regular-file readback.
These controls assume a trusted host with one coordinator; they do not establish
hostile concurrent-writer containment or general power-loss recovery.

## HTTP reference

| Endpoint | Result |
| --- | --- |
| `GET /api/reconciliation` | Latest retained list, total and omission count. |
| `GET /api/reconciliation/{attemptId}/review` | One bounded review projection and retained confirmation history. |
| `POST /api/reconciliation/{attemptId}/check-current-binding` with `{}` | One current-binding review result; changed bindings may persist a blocked record. |
| `POST /api/reconciliation/{attemptId}/confirm-reviewed` with `{requestId, reviewSha256}` | Record or replay the exact reviewed local interaction, or return a refusal/block. |

Encode attempt IDs in URLs. Mutations require the exact local Origin and session
token, JSON bodies and query-free routes. Complete reviews are bounded to 64 KiB
and 128 affected paths. Older create/view/invalidate/confirm endpoints retain
their existing contracts; the new binding-check endpoint returns only the new
review projection.

See the [verification record](evidence/2026-10-03-dashboard-reconciliation-verification.md)
for actual local gates and browser evidence, and the
[open-work guide](open-work-review.md) for inventory coverage and preservation
limits. Neither a fresh capture nor recorded intent makes a chat safe to close.
