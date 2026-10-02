# One-shot source freshness job, 2026-10-02

## Result

Knowledge now has a one-shot job for checking one captured source against its
currently admitted local original. Its immutable spec pins one canonical
archive publication path and SHA-256, a UTC `notBefore` time, and the explicit
`one-shot-pinned-local-currentness-v1` policy. The caller schedules calls to
`tickArchiveFreshnessJob`; there is no daemon or recurring scheduler. A tick
before `notBefore` creates no child task and performs no source scan.

After the due time, the runtime child-task store grants a 120-second lease,
renews it while the audit runs, and fences completion by lease token and epoch.
Concurrent ticks cannot both claim the same audit. The job uses the existing
bounded `auditArchiveCurrentnessPaged` operation, then publishes a durable
metadata-only stage containing the spec digest, audit receipt path and digest,
observation time, and one decision. A later tick validates that stage and its
content-addressed audit receipt and can finish after an expired lease without
scanning the source again. Two mechanical scan attempts are allowed; an
expired second attempt without a stage can only be closed for review. A source
admission refusal is terminal `BLOCKED` and is never retried automatically.
Registration is checked before and after a new audit and before any saved
decision is returned.
If a worker stops after audit start but before stage publication, a later
claim may run a fresh scan within that limit. The job does not promise
exactly-once scanning.

The decisions are `unchanged` when the complete observation has no changes,
`recapture-needed` when a complete observation contains added, removed, or
changed originals, and `unknown-needs-review` when it has unavailable paths.
These are point-in-time observations, not a live freshness guarantee. Results
carry the audit observation time and `currentOriginal: not-rechecked`.
Completed ticks check current source registration before returning a historical
decision; revocation refuses the result. The job never performs recapture,
graph mutation, OCR, or a hosted-model call.

## Verification

Actual bundled-Registrar integration cases verified a future due tick leaves
no child-task state, a due unchanged audit remains one-shot after a later live
edit, and two concurrent ticks produce one leased audit for an edit, addition,
and deletion. An oversized current file produced a partial audit and the
`unknown-needs-review` decision. Spec and stage tampering were rejected.
Another case staged a real audit under an expired lease, edited the live file,
then resumed and completed from the durable stage with no rescan. A disabled
registration finished `BLOCKED` after one claim and remained terminal; a
completed historical decision was refused after registration revocation.
An expired claim with no stage performed one bounded retry, while two expired
claims without a stage closed for review without starting a third scan.
A valid stage could still complete after the second attempt had been marked
mechanically failed; the additional claim only reconciled the saved result.
A source revoked after a mechanical failure went directly to terminal
`BLOCKED` without a second source scan or exposing an old stage decision.

The focused actual-Registrar integration selection passed all eight freshness
cases, and the full `pnpm nx run knowledge:integration` suite passed 87/87.
`pnpm nx run knowledge:test` passed 43/43. An initial focused Nx run
used `--skipSync` after a transient project-reference warning; final
`pnpm nx sync:check` and `pnpm nx run knowledge:typecheck` passed without it.

## Limits

The underlying Registrar observation is a declared selection rather than an
atomic filesystem snapshot. Its existing 2,000-row and 8 MiB receipt bounds
apply. A decision does not establish the current state after its observation
time, and `recapture-needed` is a request for a separate authorized action.
This increment does not establish a lossless production knowledge system.
