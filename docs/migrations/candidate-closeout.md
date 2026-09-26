# Candidate-bound local verification

This reference is for runtime integrators. The API verifies a bounded local
candidate and persisted stage chain; it is not installed-host acceptance.

The candidate is the product directory a build changes. It is separate from
the six stable stage-evidence directories. The run's `revision` remains an
execution identity; it is not a content digest and does not change at build.

## What the local boundary can establish

The intended chain is investigation and planning on A, build from A to B, then
review, verification, and delivery on B. A build that makes no change is valid.
Other stages must preserve the candidate. Runtime-owned observations bind this
chain to retained stage evidence; handlers do not supply trusted observations.

A later verifier must reload the complete persisted evidence, check the stable
stage workspaces, and observe the current candidate against an independently
selected expected identity. Reading a receipt or repeating its digest is not
an independent expectation. A successful local identity check is not proof
that the evidence is truthful or that a separate QA evaluator produced it.

## Integration contract

Create the candidate, six stage directories, and store/log directories first.
Keep the candidate root disjoint from every stage and declared write root;
stage roots must also be pairwise disjoint. Use absolute existing directories.

```ts
import {
  observeCandidate,
  executeAndPersist,
  verifyCandidateCloseout,
} from '@temari/runtime';

const scope = { scopeId: 'product', root: '/job/product' };
const expectedInitial = await observeCandidate(scope);
const knownWriteRoots = ['/job/storage', '/job/logs'];

await executeAndPersist({
  ...run,
  store: receiptStore,
  checkpointStore,
  stageEvidence: { store: evidenceStore },
  workspaceManifestStore,
  workspaceForStage,
  candidate: { scope, expectedInitial, knownWriteRoots },
  handler,
});

const verified = await verifyCandidateCloseout({
  runId,
  revision,
  store: receiptStore,
  evidenceStore,
  workspaceManifestStore,
  workspaceForStage,
  scope,
  knownWriteRoots,
  expectedCurrent: selectedReviewCandidate,
});
```

`run` supplies the stable run ID/revision, canonical plan, and capabilities.
`workspaceForStage` supplies a stable root and ID for each stage. The handler
does the actual work and returns named evidence payloads as described in
[stage evidence](./stage-evidence.md). `selectedReviewCandidate` is the expected
identity retained by the caller's review decision, not inferred from the receipt
under verification. Persist the original `expectedInitial` for later recovery;
do not replace it with a fresh observation after a build or crash.

Direct and scheduled execution capture and admit the candidate request at their
public boundary. The scheduled wrapper does so before its clock and run-store
callbacks, retains the selected stage bindings, and rechecks resolved roots
before dispatch. A callback cannot change the selected profile, original
expectation, or forwarding configuration by mutating the caller's request.

Candidate execution selects `candidate-stage-evidence-v1`. Its receipts and
checkpoints retain the initial binding; successor attestations retain compact
before/after identities. Existing evidence-only records remain on their old
profile. The old evidence-only reader does not interpret the stronger profile.

Success returns `status: 'candidate-verified'` and
`scope: 'local-regular-file-candidate-only'`, plus initial and current identities.
Missing, changed, unsupported, or inconsistent inputs throw. A refusal is not
an empty successful result. This API does not create an archive authorization
or upgrade the metadata-only `deriveCloseout` decision.

## Scope and operating obligations

Use a bounded directory of regular files under a cooperative exclusive writer.
The observation includes relative paths, file bytes, sizes, and all nine file
permission bits. It excludes empty directories, directory modes, ownership,
ACLs, and special mode bits. Permission differences can produce different
identities across platforms; cross-platform digest equality is not promised.

There is no implicit Git-ignore filtering. A dependency, log, or `.git` file
inside the root counts toward the candidate. Keep stores and logs outside the
candidate and stage roots, and declare the adapter write roots. Opaque adapters
must honor these declarations; the runtime cannot discover omitted writes.

Root containment and resolved aliases can reject static overlap. They cannot
prevent a hostile filesystem race, detect every external hard-link writer,
make a scan atomic, or prove that a file never changed transiently between
observations. Do not run concurrent writers during capture or verification.

The profile fixes the existing capture limits at 10,000 files and 64 MiB.
Identity hashes a globally path-sorted projection of file metadata and content
hashes. The existing stage-manifest format and traversal order are unchanged.
Compact identities establish equality, not a retained historical file inventory
or enough data to reconstruct a deleted candidate.

## Recovery boundary

Initial candidate intent must be persisted before the first handler. Recovery
may reuse only a matching acknowledged PASS prefix. A fully acknowledged
six-stage prefix still requires revalidation, even though no handler executes.
The empty checkpoint freezes the original plan, capabilities, start time, and
initial candidate together. Structural validation occurs before persistence;
missing capabilities retain the existing BLOCKED path without running handlers.

After publishing stage evidence, runtime reobserves the candidate before saving
the next PASS checkpoint. A mismatch leaves the prior prefix intact. The user
checkpoint callback runs after that save; changes made there do not erase the
acknowledged prefix, but fail the next stage, final publication, or recovery gate.

Checkpoint and receipt saves compare readback with an independent expected
value. A faulty adapter may already have persisted a different record when
that comparison fails. The runtime refuses success; it does not undo the write
or repair an immutable terminal receipt. These checks are not a transaction
across filesystem observation and storage, nor protection from an adapter that
can consistently falsify every read and write.

If a crash changes the candidate before the build checkpoint is acknowledged,
recovery refuses to guess whether the build finished. Orphan immutable stage
manifests are not acknowledgments. This increment does not roll back files,
adopt orphan evidence, retry terminal runs, or provide exactly-once delivery.
An existing terminal receipt remains immutable; retry work under a new run.

Legacy records keep their existing semantics. They cannot acquire candidate
verification by adding a current digest to old history. Stronger profiles must
not be resumed by older executors that ignore additive fields.

## Migration gates still open

The relocated Node consumer is a local-process proof. It does not prove clean
installation of `temari`, `poteto-mode`, or `closeout`, actual host execution,
independent QA, shared-service workers, multi-machine recovery, or cutover.
A verified candidate does not itself grant merge, archive, deployment, or
installation authority.

## Reproduce the local proof

```sh
NX_DAEMON=false pnpm exec nx run-many -t typecheck test --projects=contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync
NX_DAEMON=false pnpm exec nx run workflow-runtime:canonical-test --skipNxCache --skipSync
```

The compiled fixture derives the expected final digest from literal expected
output and native file mode, not from the receipt being checked. It deliberately
exits after empty, build, and complete checkpoints, then starts fresh processes.
Another exit occurs after build mutation but before acknowledgment; an orphan
manifest test exits after evidence publication but before checkpoint save. Restricted
readback denies repository source and the original artifact. Recovery writes
run under ordinary Node because permission mode disables the real fsync path;
no mocked durability is claimed.
