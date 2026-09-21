# Archon execution foundation

This optional integration connects a native Archon workflow to Temari's existing Feature evidence checker. It proves capture, failure and resume behavior with deterministic fixture commands. An explicit live pilot delegates one disposable charge-cost implementation and its independent review to Codex. It does not install a host adapter, repair rejected code, open a PR or publish anything.

## Install and check

Use this flow to prepare a local deterministic foundation from a Temari checkout, copied host package or Codex plugin package. You need Bun, Git and an existing compatible native Archon executable. Compatibility is pinned to [Archon v0.10.1](https://github.com/coleam00/archon/releases/tag/v0.10.1), commit `9820785c78698bdbd25a50a91df5d4262a364981`. macOS was exercised; Linux has not been verified here.

Resolve the Temari package root through your host entry. A copied host install uses `<skill-root>/.temari-package`; a Codex plugin uses `<plugin-root>/package`. All commands below work from an unrelated directory. Replace the absolute example paths with your selected package, destination parent and verified executable:

```sh
bun /absolute/temari-package/integrations/archon/lifecycle.ts install \
  --dest /absolute/local-tools \
  --archon /absolute/path/to/archon

bun /absolute/local-tools/archon-foundation/integrations/archon/lifecycle.ts check \
  --archon /absolute/path/to/archon
```

Installation creates only the fixed child `archon-foundation` and a temporary sibling stage/lock. It copies the required integration and canonical Feature files, including the hidden workflow, then installs locked local production dependencies with package scripts disabled. It downloads no native runtime and changes no provider credentials, global configuration or permissions. The original checkout and its dependencies are unnecessary after installation.

A successful install or plain check reports package, dependency, runtime and workflow checks as passed; execution remains `not-requested`. It never installs dependencies during a check. Add `--json` to either operation for structured current facts. The selected runtime is required every time and is never stored as an absolute installation binding.

To verify actual deterministic execution:

```sh
bun /absolute/local-tools/archon-foundation/integrations/archon/lifecycle.ts check \
  --archon /absolute/path/to/archon --verify \
  --evidence /absolute/current-task/archon-verification
```

Use a fresh empty evidence directory outside the package. Omitting `--evidence` creates a retained temporary directory. Verification launches the real native workflow in a disposable Git target, deliberately fails its first verifier, resumes that exact run, checks that the builder ran once, and requires a canonical review receipt. The output names the run and evidence directory. Inspect `summary.json`, the native command logs and the receipt there. A failure retains available execution evidence and exits nonzero.

The smoke isolates `ARCHON_HOME`, disables telemetry and sets `CLAUDE_BIN_PATH=/usr/bin/false` to prevent Archon's auxiliary title-model call. It does not contact a paid model. A passed verification proves deterministic scheduling, capture and ordinary failed-node resume. This deterministic check does not verify live model work. The separate bounded live pilot below requires an explicit authenticated Codex executable and real planning. Automatic repair and hard-crash recovery remain unsupported.

### Repeats, moves and failures

- An exact repeat install freshly checks the existing owned package and leaves its files and siblings intact. Changed source, modified installed files, added files, unowned destinations and destination symlinks are refused. Choose another parent for an upgrade; the command does not overwrite or repair an old installation.
- A missing or incompatible runtime, failed dependency install or invalid workflow cannot publish a successful installation. Correct the reported prerequisite and retry. A failed check does not change the package.
- A lock error may indicate an active or interrupted installer. Confirm the original process has stopped before removing the named `.archon-foundation.install-lock`. After an interruption, preserve and inspect any sibling `.archon-foundation.stage-*` directory; it is not a completed installation.
- Moving the whole installed root preserves its relative layout. Run a fresh check and use new evidence afterward. Existing runs bind absolute paths and are never migrated or restamped after a move or upgrade.
- The manifest checks owned file contents, including installed dependencies. It is an integrity record, not a signature or proof that a local source is trustworthy. Use trusted package source and an operator-owned destination.

### Feed Temari discovery

The JSON `candidate` is scoped to the **deterministic Temari failure/resume foundation**. Plain checks leave `verified: unknown`; only successful `--verify` sets `verified: present`. `authenticated: unknown` makes no assertion about paid-provider access. Add these facts and the observed timestamp/evidence to the current task's inventory alongside the remaining provider census, then use Temari's existing inventory checker. The command does not create a complete census or choose a policy action. The separate `liveCandidate` reports the narrow live pilot as exposed after prerequisites pass. Its configuration, authentication and verification remain unknown. A deterministic check never promotes those facts to live readiness.

## Run the bounded live pilot

Use macOS, an owned empty directory outside the installation, and the authenticated Codex CLI 0.154.0. The canonical pilot root and Codex/Bun executable paths must be outside `/tmp`, `/private/tmp`, `/var/tmp` and `/private/var/tmp`. Use the macOS per-user temporary directory or a normal directory you own. Other platforms are refused until their enforcement is verified. The live pilot has two fixed tasks: the charge-cost fixture and a Temari role-routing guide. It does not accept arbitrary tasks, commands, writable-root lists or permission policies. The builder and reviewer each default to `gpt-5.6-luna` with `xhigh`. Override a role only with its complete `--builder-model MODEL --builder-reasoning EFFORT` or `--reviewer-model MODEL --reviewer-reasoning EFFORT` pair. The complete legacy `--model MODEL --reasoning EFFORT` pair still selects both roles; it cannot be mixed with role options. Native model discovery validates both routes before any paid actor starts. Unsupported selections stop the run; there is no automatic fallback or upgrade. Routing never changes permissions.

```sh
bun /absolute/installed/integrations/archon/live.ts prepare \
  --root /absolute/pilot
```

Preparation creates `target/`, `task.md` and `prepared.json`. Read the actual task, source and protected tests. Perform the Feature playbook's How, two independently authored designs, coordinator selection and throughput checkpoint against this baseline. Preserve the real documents. Create a planning manifest with this shape:

```json
{
  "version": 1,
  "baseline": { "head": "COPY_FROM_PREPARED_JSON", "fingerprint": "COPY_FROM_PREPARED_JSON" },
  "taskSha256": "COPY_FROM_PREPARED_JSON",
  "entries": [
    { "kind": "how", "author": "actual-host-actor", "file": "how.md", "sha256": "DOCUMENT_SHA256", "authoredAt": "ACTUAL_ISO_TIMESTAMP" },
    { "kind": "design-a", "author": "actual-design-author-a", "file": "design-a.md", "sha256": "DOCUMENT_SHA256", "authoredAt": "ACTUAL_ISO_TIMESTAMP" },
    { "kind": "design-b", "author": "actual-design-author-b", "file": "design-b.md", "sha256": "DOCUMENT_SHA256", "authoredAt": "ACTUAL_ISO_TIMESTAMP" },
    { "kind": "selection", "author": "actual-coordinator", "file": "selection.md", "sha256": "DOCUMENT_SHA256", "authoredAt": "ACTUAL_ISO_TIMESTAMP" },
    { "kind": "checkpoint", "author": "actual-coordinator", "file": "checkpoint.md", "sha256": "DOCUMENT_SHA256", "authoredAt": "ACTUAL_ISO_TIMESTAMP" }
  ]
}
```

Paths are relative to the manifest or absolute. Exactly five entries are required. The two design authors must differ from each other and from the selection author. Selection and checkpoint share the coordinator author. Checkpoint text includes `Blocking first steps`, `Independent workstreams`, `Shared mutable state` and `Smallest safe decomposition`. Explain each dimension or its actual non-applicability. Author attribution and timestamps are host reported. Structural validation does not prove architectural quality or that design work occurred. The caller is responsible for truthful provenance and substantive planning.

```sh
bun /absolute/installed/integrations/archon/live.ts run \
  --root /absolute/pilot \
  --planning /absolute/planning/manifest.json \
  --archon /absolute/path/to/archon \
  --codex /absolute/path/to/codex \
  --model gpt-5.6-luna --reasoning xhigh \
  --fail-verification-once
```

The frozen role plan records the selected capabilities and has a digest separate from the permission contract. Actor results record the requested route, observed native route, thread ID and turn ID. Reroutes and changed effective settings fail closed; the catalog alone is not proof that a model completed a task.

`run` copies and hashes the supplied planning before dispatch. It launches `temari-live-pilot` and prints the exact native run ID. The optional failure proof stops once after passing the protected tests, resumes that same native run and checks that the successful builder capture is unchanged. Other failures stop without a model retry or repair. On success, `summary.json` names the candidate, retained artifact directory and canonical review receipt. Read the sealed stage reports and logs before relying on the model judgment.

The live `shape-final` stage seals one `shape-final.json` assessment. Its `origin` retains the prepared baseline HEAD and fingerprint, task hash, and all five original documents with their host-reported authors and authored timestamps. Decode each artifact's `contentBase64` to recover its exact original bytes and check its `sha256`. `manifestBase64` and `manifestSha256` preserve the frozen normalized manifest, whose filenames are local copies such as `design-a.md`. They do not preserve the caller's original manifest formatting or source paths.

The separate `assessment` records the observed implementation candidate, diff and contract hashes, coordinator, run ID and assessment time. Its mechanical checks confirm unchanged protected contracts and one implementation commit. Semantic design adherence remains the independent reviewer's responsibility. `requirements` links each shape requirement to the relevant historical artifact kinds. All three canonical shape records import the same sealed assessment bytes and bind them to the assessed candidate. The new assessment time never replaces an original authored timestamp.

Changing frozen planning bytes or metadata before shape execution fails validation, including edits that update document hashes and the frozen configuration. Changing the code candidate blocks capture reuse and finalization. Changing sealed assessment bytes also blocks finalization. An unchanged replay retains the original capture and assessment time. Later changes to the caller's external planning files leave the frozen historical snapshot intact. These checks preserve supplied provenance. They do not authenticate authors or creation times, or protect against an operator who can rewrite the entire local trust root.

### Create the Temari routing guide

The `temari-routing-doc` recipe creates only `docs/archon-role-routing.md` in an independent local clone. Supply a clean Temari checkout whose integration payload matches the executing installation byte for byte. The output must not already exist. The controller preserves the original source commit, accepts the known uninitialized `external/content-registrar` gitlink, and keeps planning, protected tests and package references outside the clone. It checks the original source remains unchanged.

```sh
bun /absolute/installed/integrations/archon/live.ts prepare \
  --root /Users/you/temari-routing-pilot \
  --task temari-routing-doc --repository /absolute/clean-temari-checkout
```

Author fresh planning against the returned baseline and task hash, then use the same `run` command above. The builder sees an empty `archon-role-routing.md` scratch file and four read-only implementation references. Only the controller can create the canonical document and its single commit. The fixed verifier reads Markdown as data and parses the documented routing examples with the shipped parser; an independent reviewer checks accuracy and design adherence. Successful output is an isolated commit for the coordinator to review and integrate.

Canonical inventory includes ignored files and Git metadata, with a 10,000-entry, 256 MiB aggregate bound; individual Git files are streamed up to 64 MiB and other files up to 4 MiB. Links and special files are refused. Actor output keeps its separate 64 KiB bound.

The charge-cost builder receives a fresh scratch directory containing only `charge-cost.ts`. The controller admits exactly one changed regular file with one link, unchanged permissions and at most 64 KiB. A bounded descriptor read supplies the exact bytes promoted into the canonical target. The controller creates one fixed implementation commit with hooks and signing disabled. The model cannot write the target, tests, workflow, Git, package or evidence.

The controller copies the exact candidate source and protected test into a verifier input directory and runs the fixed Bun test command through an invocation-local named Codex permission profile. The profile denies the filesystem root, permits the minimal native runtime and selected executable/input reads, grants no task writes, and denies command networking. The trusted sandbox launcher retains host configuration lookup. Inside the restricted child, a fixed `/usr/bin/env -i` invocation gives the verifier an explicit environment with a task-local HOME and no inherited credentials. The controller checks zero failures and the complete fixed suite: two tests/thirteen assertions for charge-cost, or three tests/fourteen assertions for documentation. Bun transpiler caching is disabled so the verifier leaves its read-only task home unchanged. Those output checks detect ordinary early exits; they are not proof against deliberately forged output. The fresh read-only reviewer inspects the small source change, actual commit diff, planning and observed test output and assesses semantic design adherence. Rejection, malformed replies, stale candidates, reused builder thread identity and contradictory acceptance cannot create successful review evidence.

`live-permissions.ts` owns one frozen execution contract for the fixed pilot. It binds runtime identities, task/planning/playbook copies, explicit command environment and native configuration facts. Its digest is part of each review identity, shape assessment and role observation. Builder and reviewer receive separate exact input copies; the reviewer reads a controller-produced commit diff without access to canonical Git. Context, runtime and configuration changes are checked before and after execution and prevent accepting the result.

Each actor uses a fresh app-server process and an explicit named profile on both thread creation and turn start. This transport provides the returned active profile and same-process configuration checks; the adapter requires the exact profile, model, provider, effective reasoning effort and approval policy before requesting a model turn. Initial actor probes exposed native shared-temporary grants, addressed by the paired glob denials below. Those probes do not establish a separate CLI exec enforcement defect. Session-only trust for the exact role directory prevents automatic global project registration. Startup disables approval escalation and alternate tool surfaces, sets zero subagent depth, disables notification commands and login shells/shell snapshots, and supplies an explicit shell environment with an include-only variable list.

The same actor process reads its configuration and managed requirements before and after execution. The contract hashes accepted user-layer content without logging it. Supported user settings are explicitly bounded and overridden for task execution; every configured MCP server is disabled by name. Before a turn, the started thread must report no exposed MCP capabilities. Retained rows must name configured servers, be disabled, and have empty tools/resources with no connection or discovery errors. The runner accepts only an empty system layer and no managed requirements. Project, packaged, other managed or unknown layers, custom provider/agent settings, unknown user feature settings and incompatible environment filters are refused until separately verified; mandatory restrictions are never overridden. Existing local command allow rules remain loaded, but must not broaden the explicit native profile or approval policy. Native tool-manifest and command/file enforcement proof remains required for this pinned client. Feature flags or absence of logged tool use alone do not establish that a tool is unavailable.

The native command profile restricts task file reads, writes and networking. It pairs glob denials such as `/private/tm[p]` and `/private/tmp/**` to cover shared temporary directory listings and contents because the pinned macOS minimal profile otherwise grants temporary-file access after ordinary path denials. Both forms are required. Task and runtime paths in those directories are rejected instead of granting exceptions to those denials. The authenticated parent CLI still handles host state, discovered instruction metadata and its model connection; this is not whole-client isolation. No credentials are copied and no global settings are changed. Some host sandboxes require an approved outer invocation so the CLI can start its restricted child sandbox. A startup failure does not authorize bypassing child restrictions. Concurrent hostile reconfiguration of the trusted host is outside this local trust boundary.

Deadlines are fixed by the closed task recipe. Charge-cost model invocations have 180 seconds and bridge stages have 240 seconds. The documentation task allows 600 seconds per model invocation and 660 seconds per bridge stage to inspect its larger reference set. The shared Archon workflow allows 720 seconds per capture node and 60 seconds for finalization, so either task can retain a failure before the scheduler exits. Workflow wait covers the full 2940-second serial node budget; wait and resume subprocesses have a further 30 seconds to report completion. These outer limits add no model time, retry or repair. Invocation records and summary.json report the selected task budget.

Each model invocation uses its task-specific app-server deadline, an 8 MiB stdout limit, 1 MiB stderr limit, 512 KiB event limit and 64 KiB final-response limit. Success requires exactly one completed turn with a terminal structured reply, consistent thread/turn identities and unchanged configuration. The controller writes the final-message artifact only after those checks, then stops the ephemeral server. The controller retains bounded raw output, including failure output. Successful bridge captures seal those logs; failed attempts retain their raw logs without a success seal. Prompts and intermediate control files are useful context, but their paths alone do not establish future integrity.

Child processes inherit the bridge's process group. The bridge stops that group on completion or interruption; inherited output pipes trigger bounded failure. A deliberately detached process can outlive that group while remaining subject to its sandbox. This pilot does not promise a general process-tree deadline or hard-crash recovery. Runs use an exclusive disposable target. Native Archon status and resume remain the recovery interface. Use the recorded `ARCHON_HOME` in `native-run.json`; do not repeat `run` to recover a stopped pilot. Existing invocation records prevent another model dispatch under that prepared root.

The supported live platform is macOS. Linux execution and containment remain unverified and the live policy refuses that platform. The bounded pilot is not evidence of general unattended AI readiness.

## Run the smoke from source

For integration development, install the existing tool dependencies, then run the original entry point:

```sh
bun install --cwd skills/poteto-mode/scripts --frozen-lockfile
ARCHON_BIN=/absolute/path/to/archon bun integrations/archon/smoke.ts
```

It exercises the same verification as `check --verify` and prints the retained receipt path.

## Execute stages directly

The native workflow is `.archon/workflows/temari-pilot.yaml`. Archon owns scheduling, persisted node status and resume. The bridge exposes only `capture` and `finalize`:

```sh
bun integrations/archon/fixtures/pilot.ts /absolute/empty/pilot-directory --fail-once

bun integrations/archon/bridge.ts capture \
  --repository /absolute/empty/pilot-directory/target \
  --artifacts /absolute/empty/pilot-directory/artifacts \
  --workflow-id my-explicit-run-id \
  --spec /absolute/empty/pilot-directory/pilot-spec.json \
  --stage build
```

Run `shape-final`, `verify` and `review` in that order with the same arguments. For the fixture's intentional verification failure, repeat only `verify`, then continue. Finally call `finalize` with the same arguments and without `--stage`.

For manual native operation, use the same workflow inputs as `smoke.ts`. Keep the checkout exclusive, use `--no-worktree` for the prepared disposable target, and pass `--workflow-source /absolute/path/to/temari/integrations/archon`. Start with `workflow run temari-pilot ... --detach --json`. Preserve its `runId`; use `workflow get RUN_ID --json` and `workflow resume RUN_ID` directly. In the pinned release, `workflow resume RUN_ID --json` alone validates the request without executing it. Use blocking resume or `--detach --json`.

## Capture contract

The trusted local spec contains the canonical Feature profile path, coordinator, stage assignments and one executable plus argv and timeout per stage. Each evidence mapping names a profile requirement, permitted kind and file relative to the child's `TEMARI_OUTPUT_DIR`. The bridge validates ownership against the canonical profile. The child also receives `TEMARI_STAGE`, `TEMARI_ACTOR` and `TEMARI_ARCHON_RUN_ID`. Commands run in the target checkout with inherited environment. Task text never becomes shell source in the bridge.

The bridge binds each run to the exact Archon ID, canonical repository and artifact paths, spec bytes, profile and playbook hashes. All bridge state lives under the external artifact directory. Every attempt is recorded before spawn. Actual stdout, stderr, exit status and timeout result are retained. Successful output files are copied into sealed artifacts and hashed.

`build` establishes the sole code candidate, identified by Git HEAD and Temari's tracked/untracked content fingerprint. Every later stage must leave that candidate unchanged. Each successful capture validates all preceding captures. A retry can reuse a successful capture only while its identity, artifacts and candidate still match. Historical plans remain historical. `shape-final` explicitly produces a new coordinator reconciliation against the final code and preserves the fixture's original design text in its report.

`finalize` validates all captures before importing evidence through Temari's existing APIs. It requires the **review** boundary, writes the canonical receipt and atomically publishes `$ARTIFACTS_DIR/evidence.json` last. The native finalizer has `always_run: true`; an old marker never substitutes for validation. Partial imports can resume because canonical writes are idempotent. Changed source, spec, profile or evidence requires a new run; the bridge never re-labels old tests at a fresh revision. Re-run `finalize` before relying on an old receipt, since a later edit can invalidate it.

The fixture declares distinct scripted actor identities solely to exercise Temari's assignment contract. Identity remains host-reported, not cryptographically authenticated. These files and commands are trusted local inputs, and the bridge is not a sandbox. `mutates_checkout: false` and hashes detect persistent changes but cannot prevent arbitrary command effects or detect a write that is reverted before capture. Only an operator-owned exclusive checkout is supported; do not run separate bridge runs or other writers against the same target.

## Interrupted work

A per-run lock excludes concurrent bridge commands before subprocess execution. Each attempt records `process.json` with the bridge PID and child's process group when spawn succeeds. Timeout or a graceful termination signal kills the owned process group. A completed child also has remaining group members stopped before capture.

A hard kill can leave a child alive and `.capture.lock` present. Inspect the recorded process identity and confirm it still belongs to this attempt before stopping survivors. Confirm no writer remains, reconcile the checkout, and only then remove the stale lock. Do not blindly kill a recorded PID, since operating systems reuse them. A persisted `running` builder, any signaled or timed-out builder, a process error, or a failed builder that changed the candidate will still be rejected. Start a new disposable run after reconciliation. Only a normal nonzero exit with an unchanged tree may retry a builder. The bridge does not claim exactly-once arbitrary side effects or automatic crash recovery.

## Verify and extend

```sh
bun test integrations/archon/bridge.test.ts integrations/archon/lifecycle.test.ts integrations/archon/live.test.ts integrations/archon/live-permissions.test.ts
bun skills/poteto-mode/scripts/node_modules/typescript/bin/tsc --project integrations/archon/tsconfig.json --noEmit
```

Run these development commands from the source checkout; the standalone installation includes only runtime files and production dependencies. The standard repository verifier runs these regression tests and typechecks the integration. Native execution verification remains opt-in because it needs the external pinned executable. The live protocol tests use synthetic executables and make no model calls. Establish live execution with the [explicit pilot](#run-the-bounded-live-pilot); ordinary checks never spend a model account.
