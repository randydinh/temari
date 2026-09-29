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
