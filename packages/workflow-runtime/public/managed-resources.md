# Managed resources in this artifact

The artifact includes compiled `@temari/contracts`, `@temari/privacy`,
`@temari/host-adapters`, `@temari/plan-draft`, `@temari/archon-harness`, and their
runtime dependencies under `runtime/node_modules`. Import their `src/index.js`
entries with stock Node. No Temari source checkout or TypeScript/SWC loader is
required. The shared `temari-worker-efficiency/v1` policy is included in managed
engineering prompts, protected model transport, and command judgment policies.

The managed host entry is `host/reviewed-local-candidate.mjs`. Its separately
launched operation is `host/managed-candidate-operation.mjs`; its native workflow
is `host/.archon/workflows/temari-reviewed-local-candidate.yaml`. Set the Archon
harness `workflowSource` to the absolute `host` directory in this artifact. The
optional dashboard host APIs are in `host/dashboard-managed-candidate.mjs`, with
the separate planner supervisor in `host/dashboard-planner.mjs`.

Validate `public-entry-manifest.json` against its independently supplied SHA-256
before selecting the artifact. Keep the artifact outside the mutable candidate.
Pin the current absolute Node/Bun executable and its digest in the managed
profile. Bridge operation subprocesses use that admitted runtime, including stock
Node for compiled operations. The dashboard planner uses the current host
`process.execPath`; its caller must select the trusted host runtime. PATH does not
select another runtime for either launch.

Include these absolute paths and their verified SHA-256 digests in the trusted
managed profile's `protectedInputs`:

- `host/reviewed-local-candidate.mjs`
- `host/managed-candidate-operation.mjs`
- `host/.archon/workflows/temari-reviewed-local-candidate.yaml`
- `host/owned-process/guardian.mjs`
- `host/owned-process/anchor.mjs`
- For dashboard preparation, `host/dashboard-managed-candidate.mjs` and
  `host/dashboard-planner.mjs`

The bridge refuses missing or changed packaged resource bindings before managed
execution. The dashboard profile also requires its own resource bindings. This
does not replace provider, model, check executable, runtime, native supervision,
candidate, or completion evidence requirements.

Configured Codex/provider credentials, Git, and the pinned Archon executable/home
remain external host prerequisites. Task stores, preparation files, candidate
checkouts, and evidence remain outside the artifact. Packaging supplies resources;
it does not establish host capabilities or grant additional execution permission.
