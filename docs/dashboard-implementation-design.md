# Dashboard implementation plans

## Outcome and boundary

The configured coding route turns one dashboard goal into 2–4 scoped implementer
assignments, a combined local candidate, verification evidence, and an independent
read-only review. The operator selects a host-prepared plan rather than editing
worker assignments in the browser. The result is ready for coordinator assessment
at **Needs review**; it is not semantic feature closeout.

The source checkout stays unchanged. Work occurs in isolated local Git clones;
accepted patches are integrated in a separate clone outside the source tree.
Applying the integration commit, publishing, opening a PR and merging are separate
actions. The route has no generic Accept shortcut or automatic task decomposition.

The [dashboard guide](task-dashboard.md#implementation-agents) covers operation.
This document records the implementation contract and its verification scope for
maintainers and agents extending the route.

## Owners and execution flow

| Owner                              | Responsibility                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator / Temari coordinator      | Select the plan and goal, review the prepared scopes/checks, assess the final candidate and choose the next action.                            |
| Dashboard controller               | Validate configuration and request, freeze the resolved briefs and base revision, bind both child groups, expose only supported controls.      |
| Runtime                            | Own child identities, claims, leases, fencing, durable outcomes, bounded concurrency and receipts.                                             |
| Detached implementation supervisor | Invoke the existing write-worker mechanics through runtime-owned children, sequence integration/checks/review, and observe cancellation drain. |
| Implementer                        | Edit only assigned paths in its isolated clone and return a bounded report.                                                                    |
| Independent reviewer               | Inspect the exact clean integration commit and its checks without editing.                                                                     |

The workflow is:

1. **Prepare:** freeze the clean source HEAD, overall goal, resolved assignments,
   ownership, verification commands and execution limits. Prepare implementer and
   reviewer child groups before either launches.
2. **Implement:** claim at most the configured number of implementers. Each gets a
   separate local clone of the same base commit and one attempt.
3. **Validate patches:** reject unowned changes, symlink edits, moved HEAD, empty
   results and oversized patches. Retain accepted patch bytes and their identities.
4. **Integrate:** apply accepted patches in assignment order to the separate
   integration clone. Conflicts or altered artifacts block progress.
5. **Verify:** run host-selected checks. Candidate bytes, staged tree and HEAD
   must remain unchanged by verification. Commit only the verified tree.
6. **Review:** launch the distinct read-only reviewer against that exact integration
   commit. Retain the review's candidate binding and process evidence.
7. **Hand off:** expose the integration path/commit, findings, checks and evidence
   for coordinator review. Preserve nonpassing outcomes as blockers.

The existing [write runner](../tools/run-codex-write-workers.mts) owns cloning,
typed ownership, patch validation and integration mechanics. The
[parallel runtime](../libs/runtime/src/lib/parallel-runtime.ts) supplies durable
worker control. The [controller](../tools/dashboard-controller.mts) owns admission.
The installed [worker guide](../packages/workflow-runtime/public/adapters/codex/parallel-workers.md)
describes the underlying standalone route; dashboard preparation adds the durable
task and supervisor bindings.

## Configuration and admission

`implementation` is optional in the dashboard control file:

```text
implementation: {
  executable, maxConcurrency, timeoutMs,
  plans: [{ id, title, description, assignments, prepare, verify, reviewer }]
}
```

- `executable` is an existing absolute Codex executable path.
- Concurrency is 1–4, capped by the selected plan's 2–4 required implementers.
- Each implementer is `{worker, owns}`. Ownership uses explicit
  `{kind: "file" | "directory", path}` entries relative to the Git root. Scopes
  must be disjoint, including case-folded and directory overlap checks.
- All worker briefs use `verificationCommand: null` and `reportFormat: "json"`.
  The separate required reviewer has its own ID and no write ownership.
- `prepare` is explicit and may be `[]`. `verify` is nonempty. Each command has
  exactly `program`, `args`, `timeoutMs`; the program is an existing absolute file
  and the timeout is 1–1,800,000 ms. Commands are argv calls, not browser-provided
  shell strings.
- Worker timeout is 1,000–1,800,000 ms. Coding and review allow one attempt each.
  Timeouts are not a provider spending limit.

The browser sends only:

```json
{
  "requestId": "fresh-request-id",
  "mode": "implementation",
  "planId": "temperature-helpers",
  "title": "Add temperature conversion helpers",
  "goal": "Add standalone Celsius and Fahrenheit conversion helpers with no dependencies."
}
```

The server adds the overall goal as context to fixed briefs, without expanding
their paths or actions. Changing a pinned goal, plan or base requires a new
prepared request; reusing an idempotency key cannot silently change the work.

### Scope worker acceptance separately from combined verification

Each implementer starts from the same unchanged base. Define its acceptance
criteria around its owned change; tests that require a sibling's patch belong in
the host's `verify` commands after integration. An expected failure in an unowned
sibling implementation should be reported as context, not treated as failure of
the worker's completed scope. The independent reviewer assesses the combined
candidate and its retained verification evidence.

## Configure a small coding plan

This macOS/Linux example creates a control file outside the current repository.
It asks two implementers for separate dependency-free `.mjs` modules and verifies
their actual conversions with Node assertions. It requires a clean Git checkout,
installed source-workspace dependencies, Bun on PATH and an authenticated Codex
CLI. Choose this example only when adding these two example files is appropriate
for the selected repository. Generating the configuration makes no model call.

Run from the Temari source checkout selected for the example:

```sh
export TEMARI_CODING_CODEX="$(command -v codex)"
node --input-type=module <<'NODE'
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const workspaceRoot = await realpath(process.cwd());
const state = join(homedir(), '.local', 'share', 'temari-coding-example');
await mkdir(join(state, 'prepared'), { recursive: true });
await mkdir(join(state, 'archon'), { recursive: true });
const executable = await realpath(process.env.TEMARI_CODING_CODEX);
const brief = (goal, scope) => ({
  goal, context: 'Add dependency-free JavaScript ES modules.', scope,
  acceptanceCriteria: ['Meet the requested export contract.', 'Cover zero, boiling point and negative forty correctly.'],
  verificationCommand: null, reportFormat: 'json',
  forbiddenActions: ['Do not edit unowned files, install packages, commit or publish.']
});
const assignments = [
  ['celsius', 'celsius-to-fahrenheit', 'celsiusToFahrenheit', 'C * 9 / 5 + 32'],
  ['fahrenheit', 'fahrenheit-to-celsius', 'fahrenheitToCelsius', '(F - 32) * 5 / 9']
].map(([id, file, name, formula]) => {
  const path = `examples/temperature/${file}.mjs`;
  return {
    worker: { id, role: 'implementer', required: true,
      brief: brief(`Create ${path}, exporting function ${name} for numeric input using ${formula}.`, path) },
    owns: [{ kind: 'file', path }]
  };
});
const verification = [
  "import assert from 'node:assert/strict';",
  "import {celsiusToFahrenheit as c} from './examples/temperature/celsius-to-fahrenheit.mjs';",
  "import {fahrenheitToCelsius as f} from './examples/temperature/fahrenheit-to-celsius.mjs';",
  'assert.equal(c(0),32); assert.equal(c(100),212); assert.equal(c(-40),-40);',
  'assert.equal(f(32),0); assert.equal(f(212),100); assert.equal(f(-40),-40);',
  "console.log('Both conversion helpers passed six assertions.');"
].join('\n');
const config = {
  schema: 1, workspaceRoot, preparationRoot: join(state, 'prepared'), recipes: [],
  implementation: {
    executable, maxConcurrency: 2, timeoutMs: 180000,
    plans: [{
      id: 'temperature-helpers', title: 'Add temperature conversion helpers',
      description: 'Two isolated implementers, combined numerical checks, and an independent review.',
      assignments, prepare: [],
      verify: [{ program: process.execPath, args: ['--input-type=module', '-e', verification], timeoutMs: 10000 }],
      reviewer: { id: 'conversion-review', role: 'reviewer', required: true,
        brief: { ...brief('Review both conversion helpers and their combined checks; report concrete defects or missing evidence.', 'examples/temperature'),
          forbiddenActions: ['Do not edit files, run mutating commands, commit or publish.'] } }
    }]
  }
};
const path = join(state, 'control.json');
await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(path);
NODE

pnpm exec nx run runtime:tasks -- serve --root "$HOME/.local/share/temari-coding-example/tasks" --control-config "$HOME/.local/share/temari-coding-example/control.json" --archon-home "$HOME/.local/share/temari-coding-example/archon" --port 3092
```

The generator refuses to overwrite an existing `control.json`; reuse that file
on later starts or choose a new state directory for a separate example. Open
<http://127.0.0.1:3092>, select the coding plan, and enter the overall goal shown
above. Preparation is reviewable before **Start implementers** makes model calls.
The two files should appear only in the external integration candidate. Review
the retained assertions, exact commit and reviewer findings before deciding what
to do with it.

## Integrity and recovery

| Retained boundary         | Required behavior                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest and task binding | Pin goal, resolved briefs, ownership, checks, limits, source revision and both child groups.                                                                                                                                                              |
| Worker patch              | Bind assignment, attempt, base, snapshot commit, changed paths and hash to retained bytes. Recheck before application.                                                                                                                                    |
| Diagnostic evidence       | Stream full worker/reviewer pipes, verification transcripts and operational causes into private files and the existing evidence store. Reopen portable and linked identities; retain current and historical failure references without rerunning workers. |
| Integration result        | Preserve assignment order and verify the committed tree matches the checked candidate.                                                                                                                                                                    |
| Independent review        | Bind the actual reviewer process to the exact clean integration commit; recheck it after review.                                                                                                                                                          |
| Supervisor                | Preserve launch nonce, heartbeat and ownership. Dashboard restart reopens state; ambiguous ownership never authorizes another launch.                                                                                                                     |
| Cancellation              | Retain intent, stop eligible children, and observe bounded process drain before reporting cancellation. Preserve completed siblings and partial evidence.                                                                                                 |

Lost response, missing heartbeat and expired lease are not proof that a process
has stopped. Do not delete launch records to retry. Do not reuse old patches for
a changed base or rewrite a failed result to passing. Retain the attempt and
prepare a new plan once ownership is resolved.

## Verification scope

This is a risk-based scope, not a record of executed checks. Filesystem writes,
parallel processes, durable ownership and shared write-runner behavior require
runtime evidence. Existing write-runner tests cover useful mechanics, but do not
by themselves prove the new dashboard/supervisor composition.

| Promised outcome                        | Main risk                                                                  | Existing coverage to retain                                                                                                                                                                             | Minimum verification level and proof                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start only the reviewed plan            | Serialized config or browser input changes scopes/commands                 | Controller admission and task idempotency tests                                                                                                                                                         | **Focused integration:** malformed/unknown fields, changed pinned goal/plan/base, duplicate Start and concurrent requests refuse or reuse one launch; no worker starts on refusal.                        |
| Retain full failure output              | Raw capture is truncated or buffered; archive causes are lost              | Exact-byte fixtures above 16 MiB per stream on the adapter, both runners and both dashboards; normal/nonzero verification; timeout/cancel/sink failure; source/portable tamper and replay without rerun | **Focused integration:** verify full private identities and honest incomplete capture, while semantic bounds remain enforced.                                                                             |
| Keep source unchanged and edits scoped  | Concurrent writes escape ownership or contaminate source                   | Write-runner overlap, dirty-base, rename, symlink and unowned-change cases                                                                                                                              | **Broader regression within the write runner:** retain all existing ownership/isolation cases after extraction; compare source HEAD/status before and after dashboard execution.                          |
| Integrate exactly the accepted patches  | Partial state, altered patches or assignment order yields a different tree | Tampered patch and integration failure cases                                                                                                                                                            | **Focused integration:** two distinct patches combine; tampered bytes, wrong binding and conflicting application block without a valid integration result.                                                |
| Check and review the same candidate     | Verification changes files or reviewer examines another commit             | Verification mutation/abort cases and exact-commit host reviewer pattern                                                                                                                                | **Focused integration:** failing/mutating verification blocks review; passing checks produce a matching commit/tree; a distinct reviewer observes that commit; candidate tampering invalidates integrity. |
| Preserve work through dashboard restart | Duplicate supervisor or lost ownership starts more writes                  | Read-only supervisor restart/recovery tests                                                                                                                                                             | **Focused integration:** reconnect after dashboard restart to the same active supervisor/groups; ambiguous ownership refuses takeover; completed children are retained.                                   |
| Stop execution truthfully               | Cancellation races worker completion, integration or review                | Existing worker abort and supervisor drain cases                                                                                                                                                        | **Focused integration:** cancel during building, verification and review; retain partial artifacts; require observed drain; never manufacture cancellation from a stale heartbeat.                        |
| Present a reviewable result             | Process PASS is mistaken for feature acceptance                            | Task acceptance refusal for parallel routes                                                                                                                                                             | **Focused integration plus browser smoke:** render worker/integration/review evidence and Needs review; no generic Accept/apply/push; a failed review remains actionable.                                 |
| Actually run coding agents in parallel  | Fixtures prove only process plumbing                                       | Existing deterministic isolated-clone overlap fixture                                                                                                                                                   | **Live smoke:** one bounded two-implementer run with distinct overlapping process evidence, passing combined checks, a subsequent reviewer and unchanged source. Retain the exact revision and artifacts. |

### Required before claiming the complete route

- Typecheck the controller, supervisor, write helpers and UI contract.
- Preserve the existing write-runner regression suite, then exercise the focused
  dashboard lifecycle/failure boundaries above.
- Inspect the actual browser result and cancellation/recovery controls.
- Record a live bounded coding run separately; mocked reports and shell fixtures
  are not live agent proof. Do not reuse the earlier investigation-only evidence
  as proof of implementation quality.

Optional later checks include four-worker load, the maximum timeout/output
boundaries, large repositories and cross-platform process control. Unchanged
knowledge ingestion, Jev policy, graph ranking and scheduling need no expansion
for this route. Shared packaging should be checked if the helper extraction
changes the bundled standalone worker artifact.

Residual limits remain: a passing command suite and reviewer report may miss a
product defect; the coordinator owns semantic assessment. Workspace isolation and
ownership checks do not prevent every possible external side effect of arbitrary
trusted preparation/verification commands. Select those commands deliberately.

## Source-navigation coverage

The admitted worktree had no current graph covering the dashboard implementation
route during the architecture review. The earlier P-stack graph was navigation
for legacy relationships and did not establish dashboard behavior. Design claims
here were checked against the write runner, runtime and host review source. No
bundled skill/playbook was changed for this documentation increment.

### Pinned dependency integrity

The shared write-runner boundaries also validate existing pinned read-only
submodules for dashboard implementers. The frozen dependency plan is retained in
patches and integration receipts; broad parent ownership cannot grant dependency
writes. Exact-pin checks inspect child bytes/modes, index, HEAD and untracked files
rather than relying on the parent's clean status or tree. Review uses the same
shared candidate guard. See [supported layouts and recovery](codex-parallel-workers.md#existing-pinned-read-only-submodules).
This does not promote a dashboard receipt to canonical feature completion.
