# Local Codex parallel reports

`run-codex-workers.mts` runs independent Codex CLI investigations or reviews as local processes. It uses the workflow engine's bounded scheduler and writes one joined receipt plus separate evidence for each worker. Workers use a read-only sandbox and a JSON final response. Their `PASS` status is a report, not acceptance of the underlying change.

Create a JSON request such as:

```json
{
  "runId": "example-1",
  "revision": "main-2026-09-28",
  "workspaceRoot": "/absolute/path/to/repository",
  "evidenceRoot": "/absolute/path/to/evidence",
  "maxConcurrency": 2,
  "executable": "codex",
  "timeoutMs": 120000,
  "assignments": [
    {
      "id": "api-review",
      "role": "reviewer",
      "required": true,
      "brief": {
        "goal": "Review the API changes for concrete defects",
        "context": "The current checkout contains the candidate change.",
        "scope": "API module only",
        "acceptanceCriteria": [
          "Report file and line references for each issue"
        ],
        "verificationCommand": null,
        "reportFormat": "json",
        "forbiddenActions": ["Do not edit files", "Do not send messages"]
      }
    },
    {
      "id": "test-review",
      "role": "investigator",
      "required": true,
      "brief": {
        "goal": "Identify missing tests for the API change",
        "context": "The current checkout contains the candidate change.",
        "scope": "API tests only",
        "acceptanceCriteria": ["Report specific untested behavior"],
        "verificationCommand": null,
        "reportFormat": "json",
        "forbiddenActions": ["Do not edit files", "Do not send messages"]
      }
    }
  ]
}
```

Run from the repository root:

```sh
node --import @swc-node/register/esm-register tools/run-codex-workers.mts /absolute/path/to/request.json
```

The command prints JSON containing `status` and `receiptPath`. It exits nonzero for a blocked or otherwise nonpassing receipt. The receipt is stored at `<evidenceRoot>/<runId>/<revision>/receipt.json`; each assignment has its own directory beside it containing `stdout.jsonl`, `stderr.log`, `process.json`, the output schema, and `final.json` when Codex writes one. `process.json` records the PID and start/end times so actual process overlap can be checked. A failed worker still retains its transcript and process evidence, and the other workers' outcomes remain in the receipt. Run and worker directories use mode `0700`; schema, transcript, process, final-response, and receipt files use mode `0600` on POSIX. Store `evidenceRoot` outside the repository to avoid accidentally staging private transcripts.

The request validates all assignments and resolves the executable before launching workers. Roles are limited to `investigator` and `reviewer`, and briefs must request JSON reports. `maxConcurrency` is capped at 16, `timeoutMs` at 30 minutes, and optional `outputLimitBytes` at 16 MiB (4 MiB by default). This byte limit applies to the combined stream output and separately to `final.json`. A repeated run ID and revision is rejected to keep prior evidence intact. On SIGINT or SIGTERM, the runner kills active worker process groups, records queued work as blocked, and writes a blocked receipt before exiting. An uncatchable termination such as SIGKILL cannot provide that cleanup. The declared parallelism capability remains unproven until a successful real Codex run confirms process overlap; the fake-executable tests prove only the local transport. This command does not resume external processes after interruption or use native chat subagents. It does not provide remote execution or write-capable worker isolation.

## Write-capable workers

`run-codex-write-workers.mts` accepts a separate JSON request for implementers. It requires a clean Git top-level checkout at a full pinned `baseCommit`, an evidence directory outside that checkout, nonoverlapping typed file or directory scopes, and at least one verification command. Each worker runs in its own local Git clone with `workspace-write`; controller-owned Git writes never target the source checkout. The sandbox is not a hard boundary against every external side effect, so a final source HEAD and cleanliness check blocks publication if it changed. The runner checks every Git change against the worker's scope, saves a binary patch, applies accepted patches in declared order to a separate integration clone, runs verification there, and creates an integration commit only when the verified tree still matches. A worker's JSON `PASS` alone cannot publish a commit.

```json
{
  "runId": "feature-42",
  "sourceRepo": "/absolute/path/to/clean-repo",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "evidenceRoot": "/absolute/path/outside-repo/evidence",
  "maxConcurrency": 2,
  "executable": "codex",
  "timeoutMs": 900000,
  "prepare": [],
  "verify": [{ "program": "pnpm", "args": ["nx", "run", "app:test"] }],
  "assignments": [
    {
      "worker": {
        "id": "api",
        "role": "implementer",
        "required": true,
        "brief": {
          "goal": "Implement the API change",
          "context": "Use the pinned checkout",
          "scope": "API only",
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

Run `node --import @swc-node/register/esm-register tools/run-codex-write-workers.mts /absolute/path/to/request.json`. The JSON response contains the status, receipt path, integration checkout path, and integrated commit ID when successful. The integration checkout and per-worker clones remain under `<evidenceRoot>/<runId>` for review. A required worker failure blocks integration; an optional worker failure is recorded as a degradation and its patch is omitted. Failed verification leaves the integration checkout for inspection and produces no integration commit. The command rejects submodules, symlink edits, dirty or moved bases, overlapping ownership, and paths that target Git metadata. It does not resume interrupted external processes, apply changes back to the source checkout, or claim a real Codex smoke from fake-process tests.

## Repo-local batch routing

When a Temari/poteto throughput checkpoint identifies independent workers, prepare either of the existing JSON shapes above and run:

```sh
node --import @swc-node/register/esm-register tools/run-codex-parallel.mts /absolute/path/to/request.json
```

The router selects `read-only` for a homogeneous investigator/reviewer batch and `write` for a homogeneous implementer batch with typed `owns` scopes. It validates with the selected runner's parser before launching Codex and rejects mixed or ambiguous batches. A caller-provided `mode` label is rejected before any worker launches; omit it and use the existing request shape. The command prints JSON with `route`, `status`, and `receiptPath`; write results also include `integrationPath` and `integratedCommit`. Nonpassing receipts make the command exit nonzero. Inspect the receipt and, for writes, the verified integration checkout before accepting or applying the result.

The installed public Temari plugin also bundles the standalone router as `bin/codex-parallel.mjs`. Its [Poteto Mode worker guide](../packages/workflow-runtime/public/skills/poteto-mode/references/codex-parallel-workers.md) gives the installed invocation and request shapes. Both copies route independent local batches; neither automatically selects workers for a public workflow run. A successful local receipt proves only that batch. Full-feature admission still requires independent host proof of `subagents` and `forge`, which the current public bridge does not provide.

## Host-run feature workers

The installed `bin/temari.mjs` and `bin/poteto-mode.mjs` now expose `run-workers`. This command verifies the bundled artifact and an externally pinned request digest, selects `codex` from the host process environment, and runs one required implementer followed by a distinct required reviewer. The reviewer sees the exact verified integration commit in a separate read-only Codex process. The source checkout stays pinned. The command returns a retained report with the two PIDs, candidate commit, hashes of both host observations, and the verified request and bundle digests; the report and observations are written exclusively under the evidence directory.

Use the same digest flags as the public `start` command:

```sh
node /absolute/path/to/temari/bin/temari.mjs run-workers \
  --request /absolute/path/to/feature-workers.json \
  --expected-request-sha256 SHA256_OF_REQUEST_BYTES \
  --expected-manifest-sha256 SHA256_OF_PUBLIC_ENTRY_MANIFEST
```

The request contains `schemaVersion: 1`, `entry: "temari"` (or `"poteto-mode"`), `runId`, `revision`, `candidateRoot`, `evidenceRoot`, a full `baseCommit`, `timeoutMs`, required `builder` and `reviewer` assignments, `owns`, `verify`, and optional `prepare`. Use the assignment and ownership shapes shown above. Omit `executable` and all receipt or observation paths; the host chooses the executable and writes its own evidence. The request digest must come from the trusted invocation, outside the request and artifact.

This command is a host worker bridge, separate from `start`/`resume`. It does not yet turn the worker report into a full-feature lifecycle receipt or prove forge delivery.

## Full-feature host proof gap

The public entry admits only the pinned lightweight route today. Its bridge reports no host capabilities, and a full-playbook request stops before creating a run directory. A future host integration must observe native subagent delegation and forge access independently of request fields and local worker receipts, bind that proof to the selected invocation, and retain it across resume. It must then satisfy the feature profile's distinct builder and reviewer ownership and pull-request delivery requirements. Until that integration exists, keep full-feature admission blocked even when a local parallel batch passes.

The bundled `host/local-worker.mjs` exports `runLocalHostWorker` and `runLocalFeatureWorkerPair`. Each worker uses a clean pinned candidate and evidence directory outside that checkout. For an implementer, the host supplies owned paths and verification commands. Each observation contains the actual child PID and hashes of the controller's process evidence and receipt; caller-supplied receipt paths are rejected. The public `run-workers` command consumes the pair and retains a combined report. Full-feature admission still needs the runtime to bind that report to stage evidence and retained resume state, and to establish forge access.
