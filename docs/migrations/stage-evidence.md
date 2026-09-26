# Persisted stage evidence

This reference is for maintainers integrating serial workflows with the
canonical runtime. Stage evidence verification establishes which retained
bytes belong to each completed stage. It does not establish that the evidence
is truthful, that an independent reviewer produced it, or that it describes
the current code candidate.

## Ownership and publication

The workflow engine still owns the fixed six-stage sequence. The runtime
publishes evidence through the existing `EvidenceStore` before acknowledging
a stage. Named payloads become content-addressed artifacts. A separate hashed
attestation binds those references to the run, stable run revision, stage,
status, summary, and workspace manifest ID.

Before each asynchronous publication, the runtime copies and hashes the bytes
it intends to retain. The store's returned schema, context, kind, digest, and
size must match that identity. Reload verification then checks the actual bytes.
This applies to payloads and attestations, so a faulty adapter cannot silently
substitute another internally valid artifact.

The receipt and checkpoint retain the attestation reference and the versioned
`stage-evidence-v1` profile. No mutable side index or second lifecycle store
decides whether a stage completed. A crash before a checkpoint can leave
unreferenced artifacts, but those artifacts do not authorize skipping a handler.
Handler delivery remains at-least-once.

Identical payload bytes can belong to different stages. Each stage still has
its own contextual attestation. A hash verifies content integrity relative to
the receipt. It is not a signature and cannot authenticate a writer who can
replace the receipt and all associated records.

## Runtime API

Opt into publication on the existing execution request. The handler supplies
named payload bytes, not run ownership labels or a prebuilt attestation:

```ts
await executeRequestPlanAndPersist({
  ...request,
  stageEvidence: { store: evidenceStore },
  handler: async (stage, plan) => {
    const result = await performStage(stage, plan);
    return {
      status: 'PASS',
      summary: result.summary,
      evidence: [
        { name: 'result', kind: 'verification', content: result.bytes },
      ],
    };
  },
});
```

`request` supplies the usual run ID, stable revision, coordinator request plan,
capabilities, receipt store, and optional checkpoint/workspace services.
`performStage` is your host handler, not a runtime-provided function.

A separate process can use the persisted verifier. It accepts no caller-supplied
evidence list:

```ts
const evidence = await verifyPersistedStageEvidence({
  runId,
  revision,
  store: receiptStore,
  evidenceStore,
});
```

The result has `status: 'evidence-verified'` and
`scope: 'persisted-stage-evidence-only'`. Its stages contain the named payload
bytes that were read and verified. Missing, unsupported, mismatched, or altered
records cause the operation to throw. Catch and report that refusal rather than
treating a failed read as an empty successful result.

Each stage accepts 1 to 32 payloads with unique nonempty names of at most 128
characters. Their combined content is limited to 16 MiB. The verifier checks
declared counts and sizes before loading payload bytes. The attestation itself
also remains subject to the evidence store's 16 MiB artifact limit.

## Evidence-only success

The persisted verifier reads the receipt by run ID and compares the expected
stable run revision. It requires the complete ordered PASS-stage sequence,
loads every attestation, validates its context, and loads every referenced
payload. Its success is `evidence-verified`, not closeout readiness.

Coverage applies to the named payloads in the attestations. Legacy
`evidencePaths` and `rawLogPath` fields do not automatically become portable
payloads. The verifier compares the retained workspace manifest ID with the
attestation; it does not load that manifest or revalidate a workspace. Recovery
continues to use the separate existing workspace manifest checks.

The expected revision is an execution identity label, not an observation of
current workspace bytes. Candidate mutation does not become fresh evidence
because the label stayed the same. The pure `deriveCloseout` function remains
a metadata decision and is not an upgrade path from this result.

## Compatibility and recovery

Records without the new profile remain legacy records. They keep their existing
read and execution behavior, but they are not eligible for evidence-only
verification. Do not backfill bindings into acknowledged history.

Current executors reject profile changes on resume and verify acknowledged
stage evidence before executing another handler or publishing a final receipt.
This also applies when all stages are already checkpointed. Existing workspace
manifest checks remain in effect; changing an earlier stage's workspace still
blocks recovery.

Older executors may ignore additive schema-1 fields. Do not share bound runs
with those executors. This increment does not establish mixed-version executor
safety. Existing final receipts are immutable, including BLOCKED receipts;
changing a terminal run's outcome requires a new run rather than overwriting it.

## Verification commands

Run the core regression checks from the repository root:

```sh
NX_DAEMON=false pnpm exec nx run-many -t typecheck test --projects=contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync
```

Run the relocated compiled-package consumer:

```sh
NX_DAEMON=false pnpm exec nx run workflow-runtime:canonical-test --skipNxCache --skipSync
```

The compiled consumer proves local process recovery and evidence readback.
It is not an installed-host, independent-QA, or multi-machine journey.

## Remaining migration work

The separate [candidate-bound verifier](./candidate-closeout.md) observes actual
build transitions, checks stable stage workspaces and complete evidence, and
requires an independently selected expected candidate. It uses a successor
profile; this evidence-only reader does not upgrade older history.
Isolated `temari`, `poteto-mode`, and `closeout` entry integration, installed-host
acceptance, independent QA, shared services, worker recovery, and final cutover
remain open.
