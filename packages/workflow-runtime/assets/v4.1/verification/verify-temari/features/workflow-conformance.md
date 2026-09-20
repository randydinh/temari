# Workflow conformance journeys

These journeys test whether an installed Temari candidate selects and completes the right P-stack route from an ordinary request. They keep workflow conformance separate from product correctness. The driveable path in this checkout is the workflow CLI plus sanitized journey replay; live model capture is manual or release-gated.

## Sub-features

- `workflow-help` prints `Record and verify a Temari playbook run` and the command list `start`, `stage`, `gate`, `route-pivot`, `check`, and `receipt`.
- `workflow-open` starts a named `lightweight-engineering` or `feature` run under the isolated verifier scratch.
- `workflow-drive` runs a workflow command as a named actor without repeating the run path. An incomplete run fails `check --boundary final`.
- `workflow-snapshot` copies the named workflow tree into retained evidence.
- `journey-capture` runs one bounded command and retains its raw capture (`timed_out=no` when the command finishes inside the timeout).
- `journey-score` validates a sanitized revision-bound journey manifest against the candidate checkout.
- `lightweight-product` compares the lightweight fixture result with `fixtures/organic-lightweight/expected/README.md` and requires one token replacement in one file.
- `feature-product` runs the feature fixture's legacy command and `--json` object against `fixtures/organic-feature/expected/`.

## How to get to it (user POV)

- Ask Temari to do ordinary engineering work without naming a playbook. The journey fixtures' `initial/AGENTS.md` invoke Temari for that work the same way a repository `AGENTS.md` would.
- A lightweight request is a local reversible change with a direct check. A Feature request names the requested behavior, not the engineering route.
- Coordinators record playbook progress with `bun skills/poteto-mode/scripts/workflow/workflow.ts`.
- Live capture of a model session is manual or release-gated. CI replays sanitized manifests with `journey-score`.

## Driving it with control-temari

Preconditions:

- `control-temari launch --run-id <run-id>` has created an isolated run.
- `control-temari doctor` reports `healthy=yes`.
- Build a unique candidate from the exact Git revision under test. Install it under a fresh temporary host root, and leave any existing user installation untouched.
- Record SHA-256 values for the candidate plugin manifest, Temari adapter skill, poteto-mode skill, active playbook profile, fixture prompt, and fixture `AGENTS.md`.
- For `journey-score`, use a retained sanitized directory such as `verification/verify-temari/evidence/routing-organic-lightweight/`. `--expected-revision` is the `candidate.repositoryRevision` in that manifest, not necessarily `HEAD`.
- Live Codex (or equivalent) journeys need a model account on this host. Skip them rather than inventing a session.

- **Show help.** Ask the workflow CLI what it records. Run `control-temari capture 60-workflow-help -- workflow -- --help`. Exit 0. Stdout contains `Record and verify a Temari playbook run`.
- **Open a lightweight run.** Start named bookkeeping. Run `control-temari workflow-open wf-maintain lightweight-engineering <repo-root> coordinator`. Exit 0. Stdout contains `started wf-maintain`.
- **Reject an incomplete check.** Drive the named run. Run `control-temari workflow-drive wf-maintain coordinator -- check --boundary final`. Non-zero exit. That rejection is the proof an empty run is not a passing receipt.
- **Snapshot.** Retain the tree. Run `control-temari workflow-snapshot wf-maintain opened`. Stdout contains `workflow_snapshot=` under the active evidence directory.
- **Bounded capture.** Run `control-temari journey-capture bounded-smoke 5 <cwd> -- sh -c 'printf journey-ok'`. Stdout contains `timed_out=no`. This proves the helper bounds a command; it is not a model journey.
- **Score retained lightweight.** Replay CI-safe evidence. Run `control-temari journey-score verification/verify-temari/evidence/routing-organic-lightweight --expected-revision <sha-from-that-manifest>`. Exit 0 when this checkout still contains those candidate blobs.
- **Score retained feature.** Repeat for `verification/verify-temari/evidence/routing-organic-feature/` with that manifest's revision.
- **Live model capture.** The host-native path is unreachable through this harness without a model account. Attempted route: `control-temari journey-capture <journey-id> <timeout-seconds> <fixture-copy> -- codex exec --json --ephemeral -C <fixture-copy> -o <final.txt> <prompt>` (lightweight) or the same without `--ephemeral` (Feature native delegation). Unmet prerequisite: a Codex parent on this host. Ordinary CI never invokes a model account.

## Gotchas

- Candidate hashes pin product files (Codex plugin, temari adapter skill, poteto-mode skill, the active playbook profile, fixture prompt, and fixture `AGENTS.md`), not `control-temari`. A harness fix must not force recapturing every journey.
- Live capture must run through the fresh candidate installation. A globally installed or previously cached Temari package is not evidence for the revision under test.
- Remove the temporary host root after capture. Do not modify or replace the user's existing installation.
- `journey-score` always uses this package as `--candidate-root`. The helper rejects a caller override.
- Feature native delegation needs a persisted Codex parent (omit `--ephemeral`). A lightweight journey may use an ephemeral parent because that playbook forbids delegation.
- The procedural receipt proves recorded P-stack requirements and gates for one workflow revision. Product proof is a separate JSON artifact. Neither proves the external identity of the person who resolved a gate.
- Delete only the temporary task created by a live journey after retaining its sanitized evidence.
