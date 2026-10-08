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
Replay opens captures; it cannot rerun a successful builder. An uncertain
intent refuses further dispatch. For a lost build capture after an accepted
child, supply `--intent-sha256` independently; capture reconstructs the result
only from the existing PASS child receipt and integration result. Unaccepted
or ambiguous work stays blocked. Native uncertainty uses the existing
`TaskRuntime.reconcileNative` with exact executor identity; never start again.

After six valid captures, `finalize` independently reads every artifact and
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
