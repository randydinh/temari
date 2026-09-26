# Verify canonical runtime recovery

Run this check before changing the installed Temari entry points. It exercises
the canonical request coordinator and filesystem runtime with a sanitized
artifact. It does not run a model or claim that an installed host has migrated.

## Run the checks

From a clean checkout of this repository with Node and pnpm installed, run:

```sh
pnpm install --frozen-lockfile
NX_DAEMON=false pnpm exec nx run runtime:migration-acceptance --skipSync
```

The test owns disposable directories under the operating system's temporary
directory. It does not read a legacy checkout, replace installed skills, or
modify the caller's project files. Child processes have bounded timeouts.

The expected result is a successful Nx task. The test output identifies each
scenario. A failed assertion or child process produces a failing task rather
than a passing workflow summary.

Run the regression checks before publishing a change:

```sh
NX_DAEMON=false pnpm exec nx run-many -t typecheck test --projects=contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync
```

## What the check establishes

The acceptance suite exercises these boundaries:

| Boundary              | Required observation                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Request and execution | A structured request uses the canonical lifecycle and writes a literal expected product artifact.                       |
| Process restart       | A first process exits after an acknowledged checkpoint. A fresh process reopens the stores and reuses completed stages. |
| Missing capability    | A QA request without required delegation is blocked before its handler runs.                                            |
| Workspace integrity   | Changing an acknowledged stage's workspace prevents resume before another handler runs.                                 |
| Revision identity     | A different revision cannot reuse the original checkpoint.                                                              |
| Evidence integrity    | Missing or altered retained bytes fail verification before closeout readiness is accepted.                              |

The test driver composes the existing APIs. `deriveCloseout` is a pure decision
over receipt facts and evidence identities. Callers must load and verify the
bytes separately. A `ready` decision alone is not evidence that those bytes
exist, that every stage produced the claimed result, or that the current
checkout matches the recorded revision.

## Interpret failures

- A child startup failure requires checking the frozen dependency install and
  supported Node version. Retain the child error before changing assertions.
- A workspace mismatch means the persisted manifest no longer describes that
  stage's files. Do not bypass manifest verification to make resume pass.
- An evidence failure means the artifact is absent or its digest or size has
  changed. A metadata-only closeout decision does not repair it.
- An unexpected handler invocation means acknowledged work was repeated or a
  refusal happened too late. The invocation log is the observation to inspect.

The fixtures use deterministic handlers for local file operations. A deliberate
exit after a committed checkpoint is not a power-loss test during an atomic
store write. Those cases require separate failure-injection evidence.

## Gates this does not close

Keep the following acceptance work separate:

- An installed public entry invoking the new runtime without workspace imports.
- Real host capability discovery and an independent QA evaluator.
- Shared-service operation, remote artifacts, and cross-machine workers.
- Production throughput, automatic failover, and final cutover or rollback.

See the [continuation record](./continuation.md) for the current work order and
the [cutover plan](../temari-nx-cutover-plan.md) for the full acceptance gates.
