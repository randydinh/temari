# Reviewed local candidate source operation

`reviewed-local-candidate-v1` is an explicit source-only Temari operation for
one coupled builder, read-only architect/planner, a distinct reviewer against
the integration commit, protected external checks and local delivery. It has
no forge or publication action. It never falls back from `feature-v1` and does
not change the installed public policy or conformance bridge.

`createReviewedLocalCandidatePlan()` fixes the six stages, required delegation,
independent review, revision-bound evidence and concurrency of one. The source
host bridge is `packages/workflow-runtime/host/reviewed-local-candidate.mjs`;
`ArchonHarness.startReviewedLocalCandidate()` selects the separate source
native workflow in the host directory. Run host `admit` before native dispatch with independently
computed request and bridge hashes. Each native node checks the bridge hash,
then calls `capture` with the external request digest and exact native run ID.
Archon retains native control. `TaskRuntime.dispatch` retains dispatch intent,
and its exact native reconciliation and cancellation controls remain unchanged.

The JSON request fixes profile, task/run identities, clean repository/base,
disjoint existing evidence root, exact plan/policy digest, Codex executable
selection (provider, version and SHA256), three required distinct worker briefs,
sole builder ownership, acceptance outcomes, protected files and baseline /
acceptance command argv with bounded timeouts. Protected executables and input
files are outside the candidate and hashed before execution and closeout.
`{candidate}` and `{evidence}` substitutions are argv strings, never shell code.
The host requires a pinned account-catalog snapshot for the selected CLI version,
plus the actual inherited user config digest and requested model/reasoning. It
matches a three-part release catalog version to either the same stable CLI
version or an `alpha.N` CLI build of that release (for example,
`codex-cli 0.162.0-alpha.2` with catalog `0.162.0`). The complete executable
version and SHA256 remain exact pins; the retained catalog observation includes
both versions. Different releases, leading zeros, build metadata, other
prerelease forms and malformed versions are refused. This bounded compatibility
rule establishes a version relationship, not model execution proof. The host
parses that config with Python's TOML parser, refuses unsupported catalog models
or reasoning, and refuses ambiguous profile/provider/project overrides. A cached
catalog is a prerequisite, not server execution proof. The host preserves user
model settings. Model and reasoning observations stay
null when the transport does not expose them; CLI selection is not model proof.

The existing write-worker controller validates owned changes and integrates
patches into an isolated clone. The read-only reviewer sees that exact commit.
Each operation uses the existing child store with renewable lease and one total
handler attempt. Stage captures retain baseline, integration, plan, policy,
request, native, child and process identities, plus evidence file hashes.
Before child acceptance, the host publishes the exact operation-result bytes
as portable `worker-result` evidence and a `verification` manifest through the
existing evidence store. The manifest freezes the native/request/policy/plan
binding, complete assignment, input and output candidate identity, result-file
digest, and hashes of external worker/receipt/patch evidence. Successful build
publication and readback require the operation's integration and patch to match
the write receipt, its exact assignment and baseline, and the clean candidate.
Stage refs also retain the accepted parallel receipt and both portable artifacts.
Replay opens captures; it cannot rerun a successful builder. An uncertain
intent refuses further dispatch. For a lost build capture after an accepted
child, supply `--intent-sha256` independently; capture reconstructs the result
only through a pre-existing PASS receipt read path. It uses the runtime's
existing replay validation to check group/assignment identity and portable
evidence, matches the receipt outcome to the SUCCEEDED child, and verifies the
frozen operation bytes and external hashes before using the retained result.
It never takes a new evidence snapshot or falls through to worker dispatch.
Missing/inconsistent receipts, artifacts, result files or evidence refuse
recovery; older reduced child results without the manifest are not upgraded.
Unaccepted or ambiguous work stays blocked. Native uncertainty uses the existing
`TaskRuntime.reconcileNative` with exact executor identity; never start again.

After six valid captures, `finalize` independently reads every artifact and
reopens each worker's accepted receipt and portable evidence through that same
read path, comparing the captured operation and refs with the accepted child.
It then
uses `executeAndPersist` and the canonical evidence store. It does not write
a hand-made workflow success receipt. `readReviewedLocalCandidateResult()`
then checks the task's current run, confirmed controls, exact successful native
observation, canonical evidence and the host-selected candidate verifier. It
rechecks task version after verification to reject concurrent control/replan.
This is a separate local-candidate result; generic `TaskRuntime.accept` still
refuses stronger delegation/review/forge profiles. Retain the completion path
and digest in the task handoff; ordinary task snapshots remain NEEDS_REVIEW
rather than claiming generic DONE.

Run `pnpm exec nx run workflow-runtime:managed-candidate-test` for source
fixtures. Source fixtures prove mechanical contracts, not live coding, model
quality, camera hardware, another provider/host, or installed bundle admission.
Cancellation retains failures and terminates owned subprocess groups. A late
cancel after an already completed capture reads that outcome without dispatch;
route closeout still requires current native success and resolved controls.
