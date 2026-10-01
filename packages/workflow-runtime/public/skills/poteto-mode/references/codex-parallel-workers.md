# Local Codex parallel workers

For a full feature request launched through `temari.mjs` or `poteto-mode.mjs`,
use [task tracking](../../temari/references/task-tracking.md) when a durable task
has been selected. Its version-2 sidecar keeps the original project as the task
scope and records preparation before workers launch. Standalone worker commands
do not accept tracking flags.

The bundled `bin/codex-parallel.mjs` runs independent local Codex CLI workers. Resolve that file from the installed plugin root and invoke it with Node and an absolute JSON request path:

```sh
node /absolute/path/to/temari/bin/codex-parallel.mjs /absolute/path/to/request.json
```

The router chooses a read-only batch when every assignment is an `investigator` or `reviewer`. It chooses a write batch when every assignment is an `implementer` with typed, disjoint `owns` scopes. Do not supply a `mode` field. Mixed or ambiguous batches fail before workers launch. Both paths use bounded concurrency, retain per-worker process evidence, and print JSON containing `route`, `status`, and `receiptPath`. A nonpassing result exits nonzero.

A read-only request has this shape:

```json
{
  "runId": "review-42",
  "revision": "candidate-42",
  "workspaceRoot": "/absolute/path/to/repository",
  "evidenceRoot": "/absolute/path/outside-repository/evidence",
  "maxConcurrency": 2,
  "executable": "codex",
  "timeoutMs": 120000,
  "assignments": [
    {
      "id": "api-review",
      "role": "reviewer",
      "required": true,
      "brief": {
        "goal": "Review the API change",
        "context": "The checkout contains the candidate change.",
        "scope": "API module",
        "acceptanceCriteria": ["Report concrete findings"],
        "verificationCommand": null,
        "reportFormat": "json",
        "forbiddenActions": ["Do not edit files", "Do not send messages"]
      }
    }
  ]
}
```

A write request requires a clean Git checkout at a pinned full `baseCommit`, an evidence directory outside the checkout, disjoint file or directory ownership scopes, and at least one verification command:

```json
{
  "runId": "feature-42",
  "sourceRepo": "/absolute/path/to/clean-repository",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "evidenceRoot": "/absolute/path/outside-repository/evidence",
  "maxConcurrency": 2,
  "executable": "codex",
  "timeoutMs": 900000,
  "prepare": [],
  "verify": [{ "program": "pnpm", "args": ["exec", "nx", "run", "app:test"] }],
  "assignments": [
    {
      "worker": {
        "id": "api",
        "role": "implementer",
        "required": true,
        "brief": {
          "goal": "Implement the API change",
          "context": "Use the pinned checkout.",
          "scope": "API module",
          "acceptanceCriteria": ["API tests pass"],
          "verificationCommand": null,
          "reportFormat": "json",
          "forbiddenActions": ["Do not edit unowned paths", "Do not commit"]
        }
      },
      "owns": [{ "kind": "directory", "path": "libs/api" }]
    }
  ]
}
```

Each implementer works in an isolated local Git clone. The controller checks changed paths, saves each accepted patch, applies patches in assignment order to a separate integration clone, runs `verify`, and creates an integration commit only if verification passes. The JSON result includes `integrationPath` and `integratedCommit`. Inspect that checkout and the receipt before applying or publishing its commit. The source checkout is not changed. The sandbox does not prevent every external side effect; keep worker tasks and verification commands scoped accordingly. The runner does not resume interrupted external processes.

For one feature builder and a separate reviewer, the public entry can launch and observe both workers through `run-workers`:

```sh
node /absolute/path/to/temari/bin/poteto-mode.mjs run-workers \
  --request /absolute/path/to/feature-workers.json \
  --expected-request-sha256 SHA256_OF_REQUEST_BYTES \
  --expected-manifest-sha256 SHA256_OF_PUBLIC_ENTRY_MANIFEST
```

The JSON request has `schemaVersion: 1`, `entry: "poteto-mode"`, `runId`, `revision`, `candidateRoot`, `evidenceRoot`, full `baseCommit`, `timeoutMs`, `builder`, `owns`, `verify`, `reviewer`, and optional `prepare`. `builder` is a required implementer assignment; `reviewer` is a required reviewer assignment with a different ID. Use the assignment, ownership, and verification shapes above. The entry selects `codex` from its host environment; requests cannot select an executable or supply receipt paths. The host runs the builder in an isolated clone, verifies and commits its result, then launches the reviewer against that exact commit. It retains a combined report with both process IDs, observation hashes, and the verified request and bundle digests under the evidence directory.

`run-workers` is a standalone host worker bridge; its report alone does not grant lifecycle or publish approval. The standalone router remains available for other local batches.

For a full feature lifecycle, invoke `start` with the trusted request and artifact digests. The request uses `route: "full-playbook"`, `profile: "feature-v1"`, the pinned feature obligations from `policy.json`, and an `invocation` with `runId`, `revision`, `candidate: { scopeId, root }`, and `runDirectory`. Add `featureWorkers` containing `evidenceRoot`, full `baseCommit`, `timeoutMs`, required `architect` investigator, `builder` implementer, `owns`, `verify`, and independent `reviewer`; `prepare` is optional. Use the assignment shapes above. Keep the source checkout clean and put the run and evidence directories outside it. The host launches three independent Codex processes, checks GitHub access with `gh`, and retains the proof across resume. The deliver stage must name an open pull request in that repository with the exact integrated commit at its head. Use `closeout verify` with an independently selected current candidate to verify the persisted PASS result. Publishing remains subject to operator approval.
