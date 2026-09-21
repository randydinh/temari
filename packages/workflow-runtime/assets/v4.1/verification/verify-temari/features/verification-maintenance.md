# Daily verification maintenance

Temari requires a fresh maintenance receipt before ordinary verification. It selects the maintenance skill when due, and the host coordinator executes that skill through its own instruction-loading mechanism. The CLI stores an explicitly caller-attested result and guards the next drive; it does not execute or authenticate the skill.

## Sub-features

- `maintenance-status` reports due or fresh without changing state.
- `maintenance-due` treats missing, invalid, unknown, future, blocked, or evidence-invalid receipts as due. Exactly 24 hours since completion is due.
- `maintenance-record` stores clean/changed completion time, repository binding, and retained evidence reference/hash only with explicit caller attestation.
- `maintenance-replay` preserves identical replay and refuses conflicting current-run or older results.
- `maintenance-drive` refuses an ordinary verification command before it runs when due, and preserves the target's result when fresh.
- `maintenance-host-continuation` lets the host execute the required pass through raw controls without recursively invoking the guard.

## How to get to it (user POV)

- Ask Temari to verify a mapped feature. Its canonical verifier instructions require the maintenance guard.
- Set `TEMARI_MAINTENANCE_REPO` to the owning Git repository root. Installed package location and scratch/evidence overrides do not select this state.
- Use `control-temari maintenance-status`, `maintenance-record`, or `drive`; each also accepts `--repo <root>`.

## Driving it with control-temari

Preconditions:

- Launch an isolated verifier run and require `control-temari doctor` to report `healthy=yes`.
- For guard regression, use a disposable Git repository and independent `TEMARI_VERIFY_ROOT` and `TEMARI_VERIFY_EVIDENCE`. Synthetic completions prove storage only. Never seed the real owning repository merely to pass the guard.
- For real clean/changed recording, the host has actually completed every requirement in `maintain-verification-skill` and retained evidence outside verifier scratch.

- **Inspect.** Run `control-temari maintenance-status --repo <root>`. Exit 0; JSON contains `due` and `reason`. No receipt is written. A successful receipt is fresh only while its age is less than 24 hours.
- **Refuse a due drive.** With no successful receipt, run `control-temari capture due-init -- drive --repo <root> -- orch -- init`. Exit 3; retained stderr contains `status: blocked` in JSON and selects `maintain-verification-skill`. The requested init does not run, so the isolated store has no units file.
- **Complete through the host.** Load the current host mapping and the maintenance skill. Perform its source wave and live pass. Use raw `control-temari orch`, catalog, and other mapped controls during the pass. If coverage is blocked, stop and retain that result.
- **Record completion.** Run `control-temari maintenance-record --repo <root> --run-id <id> --outcome clean --completed-at <actual-UTC-completion> --evidence <retained-notes> --attest-completed`. Exit 0 stores the explicitly caller-attested receipt. `changed` also requires the maintenance skill's shipping conditions. Source text and printed intent do not establish either outcome.
- **Preserve unsuccessful state.** Run `control-temari maintenance-record --repo <root> --outcome blocked` or use `failed`. Exit 0 reports `refreshed: false`; the existing success bytes remain unchanged. A due run stays due.
- **Retry.** Run `control-temari drive --repo <root> -- orch -- init`. A fresh receipt permits the real target, whose stdout reports `initialized`. Inspect its units file and `control-temari orch -- status`. Drive itself does not refresh maintenance.
- **Check replay and process recovery.** Run `node --test verification/verify-temari/scripts/verification-maintenance-test.mjs`. It tests boundary timestamps, invalid state, evidence validation, unchanged failed/blocked state, clean/changed recording, fresh-process reads, replay, repository binding, and real guarded subprocesses. `TEMARI_MAINTENANCE_TEST_ROOT` selects the parent of its retained disposable fixtures.

## Gotchas

- No automatic host dispatcher or scheduler is implemented. JSON selection is an instruction for the host, not an execution receipt.
- The recorder trusts the coordinator's completion attestation. File hashes verify retained bytes, not source/live coverage or host identity. Do not call it after a source-only scan or a fabricated callback.
- Supply actual completion time, not retry or recording time. Keep run IDs unique. The helper recognizes the current record's run ID, not all historical IDs after replacement. Identical replay of the current run is stable. An older completion cannot replace a known newer success even if the newer evidence disappears or changes.
- Receipts are bound to the canonical Git repository root and their evidence bytes. Copying a receipt to another repository, moving evidence, or editing evidence makes it invalid.
- Raw controls deliberately remain available for maintenance and diagnostics. The guard is cooperative, not a security boundary.
- Doctor can install missing dependencies. Help, status, doctor, cleanup, and ordinary drive never record maintenance success.
- Only one coordinator writes success receipts. Concurrent maintenance execution and distributed history are outside this increment.
