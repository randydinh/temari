# Local Codex parallel workers

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

This command is a standalone local worker utility. It does not change the public entry's pinned lightweight route, satisfy full-feature admission, or grant publish approval.
