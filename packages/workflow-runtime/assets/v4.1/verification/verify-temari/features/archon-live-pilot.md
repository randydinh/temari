# Bounded live pilot

A caller supplies actual planning for one prepared charge-cost task. The installed pilot delegates implementation to a fresh Codex actor and review to a different fresh Codex actor. The controller preserves the tests, workflow, Git history and candidate identity.

## Sub-features

- `archon-live-prepare` creates the fixed disposable task and records its baseline and task hash.
- `archon-live-planning` imports real How, two independent designs, selection and four-part checkpoint with host-reported authors and preserved bytes.
- `archon-live-shape-provenance` seals the exact historical documents and normalized manifest alongside a separate current-candidate mechanical assessment in `shape-final.json`.
- `archon-live-permissions` freezes fixed role inputs, executable/configuration identities and explicit environments; candidate evidence binds the execution digest.
- `archon-live-build` runs Codex in a scratch workspace, admits exactly one bounded source file and promotes those exact bytes with one controller commit.
- `archon-live-verify` executes actual target tests under the fixed read-only Codex sandbox and checks completion diagnostics.
- `archon-live-review` requires an observed new thread, terminal structured acceptance, matching candidate and zero findings.
- `archon-live-failure` rejects incomplete, failed, stale, oversized or contradictory model responses and incompatible app-server profile/configuration/MCP state without a receipt.

## How to get to it

First select the optional distribution described in [Archon installation](./archon-installation.md). The portable distribution has no Archon commands. In an Archon distribution, read its integration README before using the installed `integrations/archon/live.ts prepare` and `run` commands. Run requires macOS and explicit Archon, Codex, model and reasoning selections. Canonical pilot and runtime paths must be outside shared temporary roots; use the macOS per-user temporary directory or an owned normal directory. It accepts only the prepared task, with fixed permissions and no repair loop.

## Verification

1. Run `bun test integrations/archon/live.test.ts integrations/archon/live-permissions.test.ts` and the integration's strict TypeScript check. Synthetic tests cover protocol failures, scratch output rejection, candidate identity, verifier retry and receipt behavior. Provenance tests decode original document bytes and metadata from all three canonical shape imports, check historical versus assessed identities, and reject frozen-input tampering, candidate drift and sealed-assessment changes. Unchanged replay preserves the original assessment time; external source-file changes preserve the frozen snapshot. Permission tests bind accepted user configuration and reject unsupported non-user configuration/managed requirements, unsupported policy fields, changed environments/runtimes, relabeled candidate policies, context drift, extra files and link escapes. These tests do not prove actual model access or sandbox enforcement.
2. Run lifecycle and host-package checks. Both workflow files and the live modules must survive installation and relocation. Plain checks leave live configuration, authentication and verification unknown.
3. Before claiming containment, capture the actual offered tool manifest from the pinned CLI and exercise its real command/file tools. A local scripted model endpoint can drive native tool dispatch without a paid model call; label those instructions synthetic. Attempt forbidden reads/writes to protected target files, Git, sibling evidence, home and shared temporary directories. Test shared-temporary directory listings and sentinels, foreign command working directories, links, descendants, command-network denial and a synthetic environment canary. Separately execute adversarial submitted code through the exact non-model verifier launch. Confirm expected denials, unchanged sentinels and unchanged user configuration. Exact role-directory trust must be session-only. Tool flags and direct sandbox probes alone do not prove the actual model tool boundary.
4. From a fresh moved installation, prepare the task and bind actual planning to its baseline. Run the live pilot with `--fail-verification-once`. Require an actual changed source, exactly one controller commit, the deliberate failure, the same resumed native run ID, unchanged successful builder capture, passing protected tests and a fresh accepting reviewer.
5. Inspect `summary.json`, the sealed build, shape, verification and review reports, raw event logs and canonical review receipt. Decode the shape assessment's original documents and normalized manifest from the canonical evidence imports. Compare their hashes and metadata with the supplied originals, and compare the assessment candidate with each shape record's HEAD and fingerprint. Compare the execution-contract digest in each role observation, review identity and shape assessment; confirm exact copied inputs and recorded configuration/environment/profile hashes. Compare builder and reviewer thread identities and model selections with observed output. No rejected or malformed review may publish `evidence.json`.

## Limits

Planning and actor attribution are host reported. A receipt verifies procedural conformance for one candidate, not report accuracy or implementation quality. The read-only model reviewer supplies a separate semantic judgment.

Test-output counters detect ordinary incomplete test runs. Admitted source can intentionally forge output; independently inspect its tiny diff. The verifier profile restricts task reads, writes and command networking during execution, with an explicit command environment. The authenticated parent client remains trusted. Unknown or incompatible configuration must stop execution, never trigger a broader retry.

The app-server deadline and bridge cleanup cover the owned process group. Deliberately detached descendants and hard-crash cleanup have no general lifetime guarantee. Fixed sandbox restrictions still apply to model descendants. The live pilot is not an arbitrary-repository runner, a recovery engine or proof of general unattended readiness. macOS is the supported live platform; Linux remains unverified and is refused by this policy. Synthetic tests that need the native policy layout are marked macOS-only; pure configuration/catalog checks remain portable.
