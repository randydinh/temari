---
name: closeout
description: Persist and verify a current Temari run only through trusted invocation and independently selected candidate state.
---

# Closeout

Closeout is a guarded boundary, not a transcript summary.

1. Use only the current canonical runtime/store records for receipts, checkpoints, and evidence. Do not copy or recreate the legacy workflow ledger.
2. The invocation must be trusted and the current candidate must be selected independently from the invocation input before closeout is evaluated.
3. Require the canonical stage sequence, a passing receipt, complete stage evidence, and revision/run-bound evidence. Missing or changed evidence keeps closeout blocked and resumable.
4. The packaged public entry is intentionally blocked until trusted invocation and current-candidate selection are implemented and independently verified.

Use `bin/closeout.mjs policy` to inspect the contract and `bin/closeout.mjs admit --run-directory ABSOLUTE_PATH` to record the current blocked boundary. Do not report a closeout as ready from this preflight.
