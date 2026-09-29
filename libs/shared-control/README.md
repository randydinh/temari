# Local Temporal control proof

This Nx library is a local service experiment for NX05. Its Temporal workflow
retains one paused command while a worker stops and a replacement starts. The
replacement invokes `runPlanWithReceipt` from the canonical workflow engine.
Temporal has no stage loop here. The proof checks the six canonical stages and
checks that an unmet required capability yields a `BLOCKED` receipt with no
stage execution.

Run `pnpm exec nx run shared-control:typecheck` and
`pnpm exec nx run shared-control:test`. The test target starts Temporal's local
in-memory test server. It does not need an installed Temporal service or a
model credential.

The library does not implement `Nx05SharedControlProvider`. It has no shared
artifact store, atomic parent/dispatch commit, child publication, remote
delivery, or independent-disk recovery. The in-memory server does not prove
durability after a service restart. The NX05 shared-provider gate remains
blocked until those operations and a second-host test pass.
