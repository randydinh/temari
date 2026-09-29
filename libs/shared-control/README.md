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

`SqliteImmutableArtifactProvider` is a local transactional artifact adapter.
It returns path-free, revision-bound references and verifies stored bytes on
read. It uses Node 24.15+ `node:sqlite` and is kept off the package's default
entry. Its tests reopen the same SQLite file and reject tampered bytes. Run
`pnpm exec nx run shared-control:artifact-test` for that focused check.

The library does not implement `Nx05SharedControlProvider`. The SQLite file
is still on one host, and the Temporal fixture uses an in-memory server. There
is no atomic parent/dispatch commit, child publication, remote delivery, or
independent-disk recovery. The NX05 shared-provider gate remains blocked
until those operations and a second-host test pass.
