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

`SqliteNx05ControlTestProvider` uses the same local database to atomically
retain parent state, its event, and complete dispatch groups. It fences lease
takeover and verifies artifact bytes and their run/revision binding before
publishing a child result. A separate process can claim a committed group.
The claimed group includes the complete worker assignments and concurrency
bound. Run `pnpm exec nx run shared-control:control-test` for the focused check.
The adapter is deliberately kept off the package's default entry.

This SQLite provider is a same-disk test backend. The runtime still calls its
file stores rather than this provider. The NX05 shared-provider gate remains
blocked until a durable service is wired into the runtime, tested from a
second host, and independently reviewed.

`startNx05LoopbackService` and `Nx05NetworkClient` add a bounded, authenticated
HTTP command boundary around the SQLite test provider. The server binds only to
`127.0.0.1`; clients receive its URL and an ephemeral token, not a database
path. The network test starts a worker in a separate process, retains an
assignment and artifact through a service restart, has a replacement process
publish the result, and refuses a stale worker fence. Run
`pnpm nx run shared-control:network-test` for this proof. This local stack has
no TLS, remote host access, external database, backup policy, or production
service supervision. It proves the command transport and process recovery, not
cross-machine takeover or the release gate.
