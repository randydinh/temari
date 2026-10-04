# Plan goals, schedule checks, and explore knowledge

This extends the [local dashboard](task-dashboard.md). Temari retains one logical
task across planning and execution. The runtime owns process control and schedule
occurrences; Registrar owns source admission. Archon remains pinned at **0.10.1**.

## Layout and journeys

| View          | Flow                                                                                                                                              | What is retained                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks         | **New goal** → **Let Temari plan** → describe the goal → **Plan my goal** → inspect the proposal → **Prepare this plan** → **Start implementers** | Original goal, pinned source, planner process/output evidence, validated assignments, isolated patches, combined verification and independent review |
| Schedules     | **New schedule** → select a configured check → once or recurring → create → inspect its occurrence history                                        | Pinned recipe, UTC cadence, pause/resume/cancel events, exact task/start identities, missed and overlapping occurrences                              |
| Knowledge map | Filter nodes → select a path, document or relationship → inspect provenance → **Expand connected records**                                        | Read-only projections from explicitly configured pinned publications; source anchors, historical/inferred qualifiers and coverage gaps               |

A ready proposal has not run its implementation. Coding results still require
coordinator review; planning and schedule delivery cannot mark arbitrary goals
Done. Scheduled verification can become eligible for the usual explicit evidence
verification and acceptance journey.

## Configure goal planning

Add `planning` to the control JSON. It requires the existing `implementation`
transport limits; its `plans` array may be empty when only goal planning is used.
The planner executable is an installed, authenticated Codex CLI. Planning makes
one read-only model call with a 1–300 second timeout.

```json
{
  "planning": {
    "executable": "/absolute/path/to/codex",
    "timeoutMs": 180000,
    "policies": [
      {
        "id": "dashboard-ui-and-guide",
        "title": "Dashboard UI and guide",
        "description": "Plan independent UI and operator-guide changes.",
        "slots": [
          {
            "id": "ui",
            "title": "Dashboard UI",
            "description": "Implement the requested browser behavior within these files.",
            "owns": [
              { "kind": "file", "path": "tools/task-view.html" },
              { "kind": "file", "path": "tools/task-view.js" },
              { "kind": "file", "path": "tools/task-view.css" },
              { "kind": "file", "path": "tools/dashboard-pages.js" }
            ],
            "mandatoryCriteria": [
              "Retain accessible controls and working task navigation."
            ]
          },
          {
            "id": "guide",
            "title": "Operator guide",
            "description": "Describe the requested behavior and its limits.",
            "owns": [{ "kind": "file", "path": "docs/task-dashboard.md" }],
            "mandatoryCriteria": [
              "Match the current UI and execution boundaries."
            ]
          }
        ],
        "prepare": [],
        "verify": [
          {
            "program": "/absolute/path/to/node",
            "args": ["--check", "tools/task-view.js"],
            "timeoutMs": 10000
          }
        ],
        "reviewer": {
          "id": "independent-review",
          "role": "reviewer",
          "required": true,
          "brief": {
            "goal": "Review the exact integrated candidate against the original goal.",
            "context": "Inspect the combined changes and retained verification.",
            "scope": "The integration checkout.",
            "acceptanceCriteria": [
              "Report concrete findings or unresolved evidence."
            ],
            "verificationCommand": null,
            "reportFormat": "json",
            "forbiddenActions": ["Do not edit files or publish changes."]
          }
        }
      }
    ]
  }
}
```

Choose fixed preparation and verification commands appropriate to your project;
the example syntax check is not sufficient proof of product behavior. Commands
and ownership come from host configuration, never model output or browser input.
Configure 2–4 disjoint slots. The model chooses bounded goals/criteria and known
slot IDs. Mandatory criteria remain attached.

The admitted dependency sequence is **independent implementers → integration →
verification → independent review**. Implementer-to-implementer dependencies are
rejected: downstream clones currently start from the original base. Dependent
coding waves require a separate intermediate-commit protocol.

A changed source, goal, policy or proposal prevents preparation. A retained
proposal determines the implementation admission ID, so an interrupted
preparation can be retried without creating a second run. Planner intent is
written before launch. An uncertain/stale supervisor never silently starts
another paid call; inspect its retained identity and artifacts before recovery.

## Configure scheduling

```json
{ "scheduling": { "tickMs": 5000 } }
```

This enables the clock while `runtime:tasks serve` is running. Each schedule
selects a fixed verification recipe from `recipes`; recurring coding is not
admitted. Once schedules use one UTC instant. Recurring schedules use an anchored
elapsed interval of at least one minute, rather than calendar/cron expressions.
The browser converts the displayed local first-run time to an exact UTC instant.

- Missed intervals coalesce into one latest occurrence and record the number
  skipped. A backward clock does not repeat an already claimed time.
- An active, cancelling, pending or uncertain occurrence prevents another one
  for that schedule. Skipped overlap remains visible in history.
- **Pause** stops future dispatch; **Resume** coalesces missed time. **Cancel
  schedule** permanently stops future dispatch. These do not stop an active
  task; open that task and use its exact-run cancellation control.
- Restart uses the same occurrence, task and start request. Intent is durable
  before external effects. Unknown dispatch ownership requires recovery, not
  another launch.
- A changed/removed recipe pin blocks future dispatch. Create a new schedule
  for the reviewed recipe. Schedules do not accept evidence automatically.

The UI shows last tick, next due time and actual occurrence/task state. A stopped
server or sleeping host does not execute work. An OS wake/service is a separate
installation. Ledger limits are 128 schedules, 2048 occurrences per schedule and
8192 events per schedule; reaching a bound reports an error without discarding
history. Unknown/corrupt lock ownership requires manual reconciliation; timeout
alone never steals ownership.

## Configure the Registrar map

Use an existing operator-published archive handoff from the
[Registrar journey](../libs/knowledge/JOURNEY.md). Add its exact publication path
and file SHA-256. Add graph IDs only when the archived graph is available for the
same explicitly pinned publication set.

```json
{
  "knowledge": {
    "readScope": "source-root",
    "publications": [
      {
        "id": "project-docs",
        "publicationPath": "/absolute/private-task/archive-publication-HASH.json",
        "sha256": "EXACT_64_CHARACTER_SHA256"
      }
    ],
    "graphs": [
      {
        "id": "document-links",
        "graphId": "EXACT_ARCHIVED_GRAPH_ID",
        "publicationIds": ["project-docs"]
      }
    ],
    "limits": {
      "documentsPerPublication": 30,
      "graphRecords": 40,
      "nodes": 200,
      "edges": 400,
      "responseBytes": 262144
    }
  }
}
```

The dashboard does not register, capture, refresh or rebuild sources. It checks
current registration/permissions and immutable publication/implementation pins.
It reads historical archives, not current-original truth. Removed/revoked/corrupt
sources appear as explicit gaps; there is no latest-generation fallback. Directory
entries are paths, not documents. Graph assertions retain their supporting or
contrary anchors and qualifiers. Unsupported visual/asset extraction remains a
gap, even when text/path records are usable.

The map is bounded, not an assertion of full semantic recall. Catalog gap nodes
can advance to another retained page; graph expansion follows supported one-hop
reads. Returned labels contain metadata/source-relative paths, not excerpts.
Selections resolve server-held IDs; the browser cannot supply filesystem paths,
read scope or arbitrary queries. Refresh after restart restores initial IDs;
expanded IDs may expire. Revoked details clear cached anchors, edges and metadata.

If no publications are configured, the map says so. A synthetic verification
archive is evidence for the adapter journey, not your production content.
An unsuccessful refresh or expansion clears previously displayed records,
relationships and selected details. Responses from an older map request or node
selection cannot restore them after a newer refresh. If a selected record is no
longer in the returned view, its details are cleared.

## Verification and ownership

Focused gates are `runtime:dashboard-planner-test`,
`runtime:dashboard-schedule-test`, `runtime:knowledge-map-test`,
`runtime:task-test` and `runtime:task-typecheck`. Registrar tests require explicit
`TEMARI_REGISTRAR_SOURCE` and `TEMARI_REGISTRAR_PYTHON` (Python 3.12) and fail
rather than silently skip when those prerequisites are absent.

The [overnight contract](dashboard-overnight-contract.md) defines the finish
condition. The decision trail and verification record distinguish subprocess
fixtures, actual Registrar/native execution, live model calls and browser proof.
See the [retained verification record](../evaluations/task-continuity/dashboard-autonomy-2026-10-01.md)
for executed checks, actual parallel overlap, restart identity and configuration limits.
The runtime owns recurrence with Archon 0.10.1; adopting upstream native triggers
would require an explicit owner migration and a separately verified pinned upgrade.
