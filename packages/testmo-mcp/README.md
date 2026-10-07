# Testmo MCP

Local stdio MCP using the official SDK and documented REST API. Node 22+;
no listening port or VM. Tenant, project, credentials and ticket conventions
belong to host configuration, not shared source.

## Host configuration

Set `TESTMO_BASE_URL` to your hosted Testmo HTTPS origin (for example,
`https://example.testmo.net`) and `TESTMO_PROJECT_ID` to a positive integer.
Origins with credentials, a non-default port, path, query or fragment are rejected.
Only hosted `*.testmo.net` origins are supported. These settings are pinned when
the server starts; no tool caller can select another host, project or API path.
Configure them in the host environment or explicit Codex MCP environment settings.

On Windows, create a Testmo API token with the required project permissions and
save it using the hidden prompt, from the workspace root:

```powershell
& './packages/testmo-mcp/scripts/save-token.ps1'
```

Windows DPAPI protects it for the current user on this machine at
`%USERPROFILE%/.temari/testmo-mcp/token.dpapi`, outside Git. The Node launcher
captures decryption privately. Processes running as that user can still access
it. Keep the token out of chat, command arguments and TOML; rotate it in Testmo.
Direct launches may instead receive `TESTMO_TOKEN` from the host environment.
Browser sign-in does not establish API authentication.

Register Node directly so the MCP input stream stays open:

```powershell
codex mcp add testmo-local -- node ./packages/testmo-mcp/src/index.js
```

Use an absolute workspace path and a trusted Node executable for a saved host
registration. The server defaults to read-only. Set `TESTMO_MCP_WRITE_ENABLED=true`
only after explicitly enabling write access for your task. This setting is a
capability switch, not permission to publish unverified QA results.

The finite connectivity check is read-only:

```powershell
& './packages/testmo-mcp/scripts/start.ps1' -VerifyConnection
```

## Tools and verification boundaries

Read tools inspect metadata, cases, runs, results and local operation receipts.
Case lookup scans at most 100 pages of 100 cases and fails closed if not found.
Write mode adds case creation/update, manual run creation and result append.
There are no deletes, run closeout, historical result edits or tracker status tools.
Discover fields, templates and statuses before writing. Updates require the
observed `updated_at`; omitted fields are preserved. The API update is not
conditional, so a concurrent edit between preflight and PATCH remains possible.
Serialize case editing.

Runs select explicit case IDs. Readback verifies project ownership, name, state,
include-all flag and count; it does not prove the exact saved case membership.
Result `test_id` is a run test ID, not a repository case ID. Obtain untested IDs
from the run UI until a documented test-list endpoint is available.

Result provenance includes executed flag, candidate, served build, environment,
assertions, ticket/work-item reference, evidence, acceptance scope and remaining
scenarios. Full acceptance requires a passing status and no remaining scenarios.
These fields record claims; they do not establish that execution happened or
that evidence proves ticket acceptance. The QA evaluator must decide that first.

## Journals and recovery

Each write reserves a stable unique `operation_key` before HTTP, records its
response and verifies readback. Repeating a verified key with identical input
returns the retained receipt; changed input is rejected. Exclusive reservation
prevents concurrent duplicate submissions. HTTP failures, timeouts and 429/5xx
responses are not retried automatically.

Journals are scoped to the normalized tenant origin and project under
`~/.temari/testmo-mcp/<scope digest>`, or the host's `TESTMO_MCP_STATE_DIR` root.
Every receipt binds that scope. Switching tenant/project cannot replay another
scope's receipt. Receipts contain private case/result content; protect this
local directory with operating-system account permissions. Token storage remains
separate from the scoped journals; changing scope requires the correct token.

Legacy unscoped journals are never automatically imported or replayed. A matching
legacy operation key blocks submission until a human reconciles that retained
record against its original tenant/project. Keep old journals and reconcile all
pending or uncertain operations before migration or switching machines. Inspect
`testmo_operation` and the response ID or result comment marker in Testmo. If no
remote write occurred, a human may authorize a new key; do not delete a journal
or switch keys to bypass uncertainty. A verified historical replay does not
prove the current account still has access; inspect current metadata separately.

## Local validation

```powershell
pnpm exec nx run-many -t test typecheck -p testmo-mcp
```

Tests use synthetic HTTP responses, real local stdio handshake, and synthetic
Windows DPAPI tokens. They do not contact Testmo or establish live API
compatibility. A separately authorized live read must still verify credentials,
field schemas and API behavior. Existing employer-specific configuration remains
outside the shared package.
