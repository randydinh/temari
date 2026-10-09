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

The request validates all assignments and resolves the executable before
launching workers. Roles are limited to `investigator` and `reviewer`, and
briefs must request JSON reports. `maxConcurrency` is capped at 16, `timeoutMs`
at 30 minutes, and optional `finalResponseLimitBytes` at 16 MiB (4 MiB by
default). This bounds only parsing of `final.json`; the complete final file
remains retained if parsing is rejected.

`outputLimitBytes` is a deprecated alias for that same semantic limit, and
conflicting alias/new values are rejected. Raw stdout/stderr and verification
transcripts stream to private files without a retention byte cap or
output-volume kill.

A repeated run ID and revision is rejected to keep prior evidence intact. On SIGINT or SIGTERM, the runner kills active worker process groups, records queued work as blocked, and writes a blocked receipt before exiting. An uncatchable termination such as SIGKILL cannot provide that cleanup. The declared parallelism capability remains unproven until a successful real Codex run confirms process overlap; the fake-executable tests prove only the local transport. This command does not resume external processes after interruption or use native chat subagents. It does not provide remote execution or write-capable worker isolation.

Raw capture finishes after the process closes, both pipes drain, and their files
are synced and closed. Timeout and cancellation still terminate processes and
retain every delivered byte. Sink, launch, start-observation, input, and
finalization errors have controlled summaries and full private diagnostic files;
incomplete capture is explicit. Setup failures launch no process. Each raw
stream reports whether its owned file is available; receipts and dashboard
sealing include only available spools and private cause files.

Schema or terminal metadata publication failure returns a controlled blocked
result with available capture paths and a full private cause. Missing terminal
metadata prevents transport success; dashboard archival still retains the
adapter-returned sources.

`process.json` includes received/written byte counts, hashes, capture status,
and diagnostic source identities. The actual-spawn observation remains
`process-start.json`, bound to the same PID/start timestamp as the terminal
record. POSIX process-group behavior is covered by the local fixtures; Windows
process-tree parity remains unverified.

Restartable dashboard routes publish these sources through the existing evidence
store and verify them without buffering. Failed children retain typed `retained`
or `archive-failed` diagnostics, with complete available secondary causes and
partial references on archive failure. Terminal/retry events preserve canonical
references plus digests; cancellation binds requested versus effective
diagnostics. Replay rechecks current and historical references without invoking
workers. Legacy children without this optional field remain readable and make no
complete-retention claim. Required routes reject stores lacking both streaming
ports before claiming children.

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

Run `node --import @swc-node/register/esm-register tools/run-codex-write-workers.mts /absolute/path/to/request.json`. The JSON response contains the status, receipt path, integration checkout path, and integrated commit ID when successful. The integration checkout and per-worker clones remain under `<evidenceRoot>/<runId>` for review. A required worker failure blocks integration; an optional worker failure is recorded as a degradation and its patch is omitted. Failed verification leaves the integration checkout for inspection and produces no integration commit. The command supports the pinned read-only submodules described below and rejects symlink edits, dirty or moved bases, overlapping ownership, and paths that target Git metadata. It does not resume interrupted external processes, apply changes back to the source checkout, or claim a real Codex smoke from fake-process tests.

## Repo-local batch routing

When a Temari/poteto throughput checkpoint identifies independent workers, prepare either of the existing JSON shapes above and run:

```sh
node --import @swc-node/register/esm-register tools/run-codex-parallel.mts /absolute/path/to/request.json
```

The router selects `read-only` for a homogeneous investigator/reviewer batch and `write` for a homogeneous implementer batch with typed `owns` scopes. It validates with the selected runner's parser before launching Codex and rejects mixed or ambiguous batches. A caller-provided `mode` label is rejected before any worker launches; omit it and use the existing request shape. The command prints JSON with `route`, `status`, and `receiptPath`; write results also include `integrationPath` and `integratedCommit`. Nonpassing receipts make the command exit nonzero. Inspect the receipt and, for writes, the verified integration checkout before accepting or applying the result.

The installed public Temari plugin also bundles the standalone router as `bin/codex-parallel.mjs`. Its optional [Codex host adapter guide](../packages/workflow-runtime/public/adapters/codex/parallel-workers.md) is packaged at `adapters/codex/parallel-workers.md` and gives the installed invocation and request shapes. Both copies route independent local batches. A successful local receipt proves only that batch.

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

This command is a standalone host worker bridge, separate from `start`/`resume`.

## Full-feature lifecycle

The public `start` entry admits a trusted `full-playbook`/`feature-v1` request when the host proves three distinct local Codex workers and forge push access. The architect investigates the pinned source checkout read-only. The builder works in an isolated clone with owned paths and verification commands. A separate reviewer examines the integration commit read-only. The host binds the observations, process receipts, verified commit, and forge identity to the request and retains them for `resume` and `closeout verify`.

The request includes `schemaVersion: 1`, `entry`, `route: "full-playbook"`, `profile: "feature-v1"`, `obligations` equal to `policy.feature.obligations`, `invocation: { runId, revision, candidate: { scopeId, root }, runDirectory }`, and `featureWorkers: { evidenceRoot, baseCommit, timeoutMs, architect, builder, owns, verify, reviewer }`. The assignment and ownership shapes are in the bundled worker guide. `prepare` is optional. The source checkout must be clean and pinned at `baseCommit`. Run and evidence directories must be outside it. The host selects `codex` and rejects caller-supplied proof paths. Stage results still flow through the six-stage canonical runtime. Deliver requires an open pull request in the selected repository whose head matches the verified integration commit. Publish remains gated by operator approval.

Verification keeps the existing `verify-N.log` combined transcript and adds
typed raw capture identities to each new verification receipt entry. Dashboard
sealing includes the transcript, raw pipes, and available operational-cause
sources.

Receipt/manifest/final JSON, Git status and binary patch inputs remain bounded
semantic/control data. The legacy buffered evidence APIs retain their 16 MiB
materialization bound, and stage attestations retain their
32-payload/16-MiB aggregate input bounds. These limits do not truncate raw retained
diagnostics.

## Existing pinned read-only submodules

Application-only edits support initialized, clean first-level submodules already
recorded as gitlinks and uniquely mapped by tracked `.gitmodules` at the pinned
parent commit. Each dependency must be at that exact commit and contain tracked
regular files only. Working-tree bytes must equal stored blobs; checkout filters
and line-ending transformations are unsupported. Ordinary `.git` files into the parent's Git administration
and independent `.git` directories are supported. Nested dependencies, symlinks,
unsafe or case-colliding paths, shallow/borrowed object databases, missing objects,
uninitialized checkouts and coordinated dependency edits are refused. Dependency
capture is bounded to 10,000 files, 64 MiB of tracked content and 1 MiB of compact
plan evidence. Application Git capture has its own 10,000-file/64-MiB bound.

The runner freezes `pinned-readonly-dependencies-v1` evidence containing each
path, commit and tracked file's mode, size and SHA-256, plus `.gitmodules` identity.
Worker patches and integration receipts retain this plan. Preparation copies local
Git objects into independent repositories, checks out the exact pins, and never
fetches remotes or copies ignored/private worktree payloads. Verification that needs
ignored configuration must supply it separately through the existing preparation
contract. Dependency identity excludes Git administration and ignored payloads;
it does not attest to those payloads or their influence on commands.

Owning a parent directory does not authorize changing its dependencies. Changes to
child bytes, modes, index, HEAD, nonignored untracked files, parent gitlinks or
`.gitmodules` block integration. Recursive checks explicitly override
`ignore-submodules`, inspect tracked bytes even under assume-unchanged flags, and
run around preparation, patch capture/application, verification and source checks.
The feature host repeats the same typed checks around independent review, stages,
resume, forge proof and trusted closeout. A parent Git tree or worker PASS alone is
insufficient; the six-stage canonical receipt and exact-commit PR remain required.

For a refusal, retain the failed receipt and logs. Restore the intended clean,
initialized dependency at the recorded pin through your normal repository workflow,
then start a fresh run with a newly reviewed request. The runner does not fetch,
repair, advance dependencies, rewrite evidence or apply integration changes to the
source. Rebuild the public package from TypeScript to obtain this behavior; never
edit an installed cache. Synthetic fixtures prove mechanics, not live worker or
Sports Analyst compatibility.
