# Installed QA route and host evidence

## Current-main QA follow-up (2026-09-30)

This follow-up started from `5af7b97` in an isolated worktree. The packaged QA route now has a separate local evaluator process, but that worker derives procedural evidence findings. This increment makes the boundary explicit: a procedurally clean round remains `BLOCKED` with `product-intent-assessment-unavailable`. Pinned `intentSources` can carry the assigned requirement revision and expected outcome into the frozen evaluator input; their presence is not an independent judgment of authority or assertion strength.

The installed entry loads `ticket-acceptance-v1` and the QA evidence skill with SHA-256 identities. It loads the `temari-public-v1` verifier text only when that profile is requested and the candidate carries the matching workspace package marker. The result labels this as a handoff with `execution: not-observed`; loading guidance does not run a project verifier. The relocated synthetic journey remained `BlockedOrIncomplete`. A separate fresh-context plain-language attempt also stopped before `qa`: its supplied candidate contained only a text fixture, with no category-search behavior, governing requirement revision, or runnable control surface.

Focused uncached Nx `temari-core` typecheck/test, `workflow-runtime:public-entry-test`, and `workflow-runtime:qa-installed-journey` are the verification scope for this change. The remaining admission work is a trusted independent semantic assessor that reviews pinned intent and assertion counterexamples, plus an actual project verifier and candidate-bound observations. This dirty-worktree artifact is development evidence and is not a clean release candidate.

The installed temari qa command accepts a versioned full QA assignment and unexecuted review draft. It routes through the ./qa-review domain owner and the existing six-stage engine. On the selected experimental-local-host, the result is BlockedOrIncomplete because the host bridge cannot launch a separate evaluator context. The workflow receipt is independently BLOCKED with a capability-gap. No evaluator round, finding, or PASS is invented.

## Boundary

The request uses schemaVersion 1, route qa-review, and profile qa-review-v1. It carries an assignment, review draft, and canonical invocation. The public entry verifies external request and artifact SHA-256 values before loading the installed core. The assignment must be full, name the invoked candidate revision, and use only the policy's read actions. The draft must have unexecuted scenarios, assignment source references, no external write references, and no evaluation rounds. The entry rejects caller-written evaluator IDs, context claims, capability lists, dispositions, and generic feature-plan obligations.

createRequestPlan fixes workType qa, independent review, revision-bound evidence, and the canonical investigate, plan, build, review, verify, deliver stage order. The installed host bridge reports capabilities in the retained run descriptor. The strict missingOrUnprovenCapabilities gate compares that observed report with the required subagents capability. The canonical runtime writes the workflow receipt. The QA boundary then writes a digest-bound review record with one blocked attempt, zero rounds, no evaluator output digest, and a separate QA disposition. The frozen draft input lists only the review snapshot, canonical evidence references, declared constraints, and prior rounds. This blocked draft has no canonical evidence references or prior rounds. No external system write occurs.

The temari-public-lightweight-v1 policy ID and the generic feature profile's unsupportedRoutes [qa-review] remain unchanged. The QA command is an explicit domain entry. The installed lightweight and read-only closeout routes retain their existing policy contract.

## Observed host capability

The clean-head installed journey at 15e147174cc4f6e7bc7cc6c7a1f045adda980634 retained evidence at /var/folders/2q/k63m84tn5q13cvh__pxjtnjm0000gn/T/temari-qa-installed-mThkyT/journey-evidence.json. The relocated artifact manifest SHA-256 is 2ac7b0c2c3aa5e0ab481cd514e9e1bc2dfd2cc53e6d75fe15a8b96e4d4d23c03. The bundle marked that revision with dirty false.

| Host and tool                                     | Observed invocation and lifetime                          | Observation                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| experimental-local-host, installed host/entry.mjs | node-pid-12376, 2026-09-28T14:29:32.454Z to 14:29:32.511Z | Child exit 1. Retained report had available []. Strict gate found missing subagents. Six-stage plan produced a BLOCKED receipt before stage work.                                         |
| Local codex exec --help probe                     | Read-only CLI help, exit 0 on 2026-09-28                  | The CLI advertises exec. This does not establish an evaluator launch, context lifetime, allowlist confinement, or installed bridge integration. No Codex evaluator capability is claimed. |

The installed public-entry regression also completes a separate synthetic serial lightweight run with six PASS stages and all four pinned source IDs. This demonstrates the supported serial product path. Its scripted host is a transport fixture, not independent QA or native host-family proof.

At code milestone c83c316117a9efe36a37a03ad04ab1f1a7710d0a, the installed policy owner was corrected to the exported ./qa-review domain entry and checked against the runtime binding. The focused uncached public-entry-test passed 36 of 36 and qa-installed-journey exited 0. That run carried uncommitted handoff documentation and is not cited as a clean artifact; the clean artifact evidence above remains bound to 15e1471.

At clean handoff head b7f2cf8403da63f9171fc5b96ef82c33c3aabdc4, the direct relocated journey retained `/var/folders/2q/k63m84tn5q13cvh__pxjtnjm0000gn/T/temari-qa-installed-CKditn/journey-evidence.json`. Its manifest SHA-256 was 524efaf9f474e2080f3cbd749fdc183944e9b663925bbbc36905906d4b62f426 with dirty false. The installed host invocation `node-pid-53180` ran from 2026-09-28T14:37:33.231Z to 14:37:33.297Z. The child exited 1, the workflow receipt was BLOCKED, the QA disposition was BlockedOrIncomplete, the retained report had available [], and the strict gate lacked subagents. The outer journey target and direct artifact checker both exited 0. The same uncached final-head run passed 36 of 36 public-entry tests and the 234-file package check.

## Verification and limits

At clean code head 15e147174cc4f6e7bc7cc6c7a1f045adda980634, these commands exited 0:

    NX_DAEMON=false pnpm exec nx run-many -p contracts,temari-core,workflow-engine,runtime -t typecheck test --parallel=1 --skipNxCache --skipSync --output-style=static
    NX_DAEMON=false pnpm exec nx run-many -p workflow-runtime -t canonical-test host-session-test public-entry-test qa-installed-journey check --parallel=1 --skipNxCache --skipSync --output-style=static
    PATH=/opt/homebrew/bin:$PATH NX_DAEMON=false pnpm exec nx run workflow-runtime:test --skipNxCache --skipSync --output-style=static
    node tools/public-entry-runtime.mjs check --artifact /var/folders/2q/k63m84tn5q13cvh__pxjtnjm0000gn/T/temari-qa-installed-mThkyT/relocated/artifact --expected-manifest-sha256 2ac7b0c2c3aa5e0ab481cd514e9e1bc2dfd2cc53e6d75fe15a8b96e4d4d23c03

The first command passed eight affected targets, including 25 contract, 49 core, 18 engine, and 185 runtime tests. The second passed 11 canonical, 39 host-session, and 36 public-entry tests, a direct relocated QA journey, and the 234-file distribution check. The QA journey's inner public command exited 1 by design. Its Nx target exited 0 after checking the retained BLOCKED receipt, zero rounds, and denied writes. The direct outer artifact checker exited 0. A broader local workflow-runtime:test attempt without Bun on PATH exited 1 at spawnSync bun ENOENT. The same target passed 34 of 34 tests with installed Bun 1.4.2 on PATH; its nested maintenance suite passed 10 of 10.

The relocated public-entry test refuses an actual source-checkout import with its ESM loader before running the installed QA entry. It rejects forged freshContext, evaluator ID, round, capability list, PASS disposition, execution, external write authority, and write receipt reference before a run directory exists. It also records a missing-environment block without a round. These are synthetic plumbing and refusal cases. PASS and REVISE from a genuinely separate evaluator have not been run on this host.

Linux and Windows workflows now run the direct installed QA journey at the branch head. Draft PR #61 is open; its exact-head checks remain pending at this checkpoint. A separate read-only Codex review process was attempted, but the workspace approval boundary rejected it because it could transmit repository contents to another service. No workaround was attempted; independent code review remains pending. A future evaluator adapter must observe its own context ID and lifetime, constrain access to the frozen input allowlist, retain input and output digests and full findings, and derive the verdict from actual output. Caller-written freshContext or evaluator IDs cannot satisfy that gate. No installed plugin was replaced, and this result does not authorize cutover or merge.
