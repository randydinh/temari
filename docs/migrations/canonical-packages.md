# Verify portable canonical packages

This maintainer check packages the existing contracts, coordinator, workflow
engine, and runtime as executable JavaScript. It is preparation for an isolated
installation, not a new end-user workflow entry. It does not replace the
installed `temari`, `poteto-mode`, or `closeout` skills.

## Build and check

Use a checkout with the frozen workspace dependencies installed. The builder
uses the root's TypeScript development dependency; the emitted libraries run
under stock Node without that compiler or a source loader.
Use Node 24, as CI does, or a supported newer Node release for the relocation
proof's permission flags. The separate legacy regression suite also needs Bun
1.4.2 available on the shell's search path.

From the workspace root, choose a new absolute destination whose parent exists:

```sh
pnpm exec nx run workflow-runtime:canonical-package --output=/absolute/new/artifact
pnpm exec nx run workflow-runtime:canonical-check --artifact=/absolute/new/artifact
```

The builder refuses an existing destination. Choose another empty destination
name rather than replacing an installation. The output contains ordinary ESM
packages under `node_modules/@temari/` and a `canonical-manifest.json` inventory.
The four packages preserve existing API names and concrete internal dependency
versions. The pinned v4.1 distribution remains separate and unchanged.
Declarations are included for TypeScript consumers, which must supply their
own Node type declarations. The stock-Node runtime needs no external package
dependencies beyond the four included libraries.

The manifest binds actual source/build content and emitted file hashes. It is
an integrity record, not a trusted signature. A checker using only an artifact's
own manifest cannot authenticate a coordinated replacement of both manifest
and payload; keep an expected manifest through a trusted channel when needed.
Publication reserves a new destination and writes the manifest last. An
interrupted write can leave an incomplete directory; verification will reject
it. Preserve that directory for diagnosis and build into a different new path.
Atomic directory publication and automatic replacement are not claimed.

## Run the relocation proof

```sh
NX_DAEMON=false pnpm exec nx run workflow-runtime:canonical-test --skipSync
```

This uncached target builds into a disposable directory and copies the artifact
to a different path containing spaces and a non-ASCII character. A plain-JS
fixture resolves the copied package exports in fresh Node processes. Every
child clears `NODE_OPTIONS` and `NODE_PATH` and uses no source preload. The
final readback process explicitly checks that source-checkout,
workspace-dependency, and original-artifact reads are denied. Node's permission
model guards against accidental dependencies here; it is not a sandbox for
malicious code.

The first process exits after a persisted build checkpoint. A second process
resumes the remaining canonical stages. A third opens the receipt and evidence
stores afresh under restricted reads. The first two processes run without
permission mode because Node disables file-descriptor `fsync` in that mode;
the runtime's durable writes remain unchanged. This proves isolated imports
and evidence readback, not denied source reads throughout writing/recovery.
Assertions require the original checkpoint prefix and start
time, one handler invocation per stage, and literal `APPLE\nPEAR\n` product
bytes. Negative checks reject missing or changed dependency bytes, extra files,
links, unsafe inventory paths, and a rewritten manifest when an expected
manifest is supplied. An existing destination must remain unchanged.

Five additional candidate-bound scenarios use the same compiled packages and
separate stable stage directories. Build changes actual candidate bytes from
`pear\napple\n` to `APPLE\nPEAR\n`; the expected final digest comes from literal
expected output, not the receipt being checked. Fresh processes recover from
empty, build, and complete checkpoints. Other processes stop after an
unacknowledged build mutation or after manifest/evidence publication before
checkpoint save. Recovery refuses those ambiguous gaps. Reader checks reject
stale expectations, changed candidates, changed stage artifacts, and missing or
tampered evidence, with restored-byte success controls.

Run the adjacent regression checks before publishing:

```sh
NX_DAEMON=false pnpm exec nx run-many -p contracts,temari-core,workflow-engine,runtime,workflow-runtime -t typecheck test --parallel=1 --skipNxCache --skipSync
NX_DAEMON=false pnpm exec nx run workflow-runtime:check --skipSync
```

If compilation or inventory verification fails, retain the error and candidate
identity. Do not add a loader, disable integrity checks, or use files from the
source checkout to make the artifact run. If a child times out or cannot load
the package, inspect its stderr and the generated package exports first.

## Acceptance boundary

Passing the eleven checks establishes portable canonical libraries with
fixture-based local process recovery. The original evidence-only fixture and
the newer [candidate-bound verifier](./candidate-closeout.md) have different
claims: the latter verifies bounded regular-file identity and complete retained
stage evidence under a cooperative exclusive writer. It does not prove
independent QA, truthful evidence, or archive/merge authority.

The candidate scenarios cover both acknowledged recovery and refusal of selected
pre-acknowledgment gaps. They do not establish automatic rollback, exactly-once
execution, atomic filesystem snapshots, live host dispatch, installed-entry
migration, or multi-machine operation.

See the [continuation record](./continuation.md) for actual verification and
remaining gates. Do not mark the public-entry or cutover gates complete from
packaging alone.
