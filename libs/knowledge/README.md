# Knowledge investigation

`investigateDesignUpdate({ brief, task, request, provider, assess, resumeFrom? })`
returns `Promise<WorkerResult>`. Compose it inside the existing `runPlan` stage
callback; the demo does this for the `investigate` stage. It creates no lifecycle,
agent owner, model service, or source-maintenance operation.

The reader callback is
`assess({ brief, checkpoint, checkpointPath }): Promise<KnowledgeAssessment>`.
The actual `brief.context` contains the original trusted context, visible retrieval
coverage/limits/gap counts, and bounded source records. It equals
`checkpoint.suppliedContext`. Every other brief field is preserved. The original
brief remains in `checkpoint.trustedBrief`. Source text is data; caller selection
and declared `requires` determine reads. Discovery never expands the read scope.

`saveInvestigation(checkpoint)` and `loadInvestigation(absolutePath)` operate on
content-addressed `knowledge-<sha256>.json` files beside the existing canonical
`task.directory`. A synced, exclusive temporary file is linked into place without
overwriting. A checkpoint is saved before assessment, and failed callbacks leave
retrieval recoverable. A process crash can leave an unreferenced `.knowledge-*.tmp`
file; it is never treated as a completed artifact. No automatic garbage collection
or authentication of artifact authors is provided.

Resume requires the same task/authority, request, and provider/configuration.
Changing these requires a fresh investigation while retaining the old artifact.
An unchanged completed assessment input is not repeated. Findings and action IDs
are immutable: revisions use new IDs. Prior questions, rejected alternatives,
completed actions, evidence, and checkpoints remain available. Retries after an
unrecorded callback crash cannot guarantee exactly-once external side effects;
the callback is intended for assessment, not external actions.

The consumer requires citations in the actual supplied context, at least one
plan/update comparison, and accounting for every known question. These are
mechanical checks. Every explicit selection conservatively governs findings:
changed evidence makes them `stale`; missing/partial dependencies or unknown
checks make them `blocked`; otherwise they remain `needs-semantic-review`.
Results are `ISSUES` or `BLOCKED`, never semantic `PASS`.

## Run checks

```sh
NX_DAEMON=false pnpm nx run knowledge:typecheck
NX_DAEMON=false pnpm nx run knowledge:test
TEMARI_REGISTRAR_SOURCE=/absolute/registrar-repo \
TEMARI_REGISTRAR_PYTHON=/absolute/python \
NX_DAEMON=false pnpm nx run knowledge:integration
```

Unit tests use a test-only replacement provider and an explicitly labeled parser
substitute. The separate integration target runs the actual Registrar CLI and
fails if either explicit path is missing; it never skips or substitutes execution.
Tests use fresh directories under canonical `os.tmpdir()`, never a personal registry.
No package installation, network access, or source refresh occurs in the provider.

## Local demo and preparation

```sh
pnpm nx run knowledge:demo -- --help
pnpm nx run knowledge:demo -- prepare \
  --manifest /absolute/selected-documents.json \
  --python /absolute/python --registrar-source /absolute/registrar-repo
pnpm nx run knowledge:demo -- collect --input /absolute/input.json
pnpm nx run knowledge:demo -- collect --input /absolute/input.json \
  --resume /absolute/task/knowledge-HASH.json --assessment /absolute/assessment.json
```

The caller explicitly admits the manifest's canonical `snapshotRoot`. Its bounded
`documents` array lists `snapshot` (relative text path), `sha256`, `origin`, and
`role` (`plan`, `update`, `constraint`, or `dependency`). Only named, hash-matching,
non-symlink snapshots are copied; there is no scanning of that input root. The
demo registers/refreshes only its fresh copies, records origins/hashes, and prints
the generated input path and provider source identity. `collect` does no setup.
Without an assessment file it deliberately saves `BLOCKED` work for a reader.

For an already prepared state, pass `input.json` with `{config, task, brief, request}`.
`config` is `LocalRegistrarOptions`: absolute `python`, `registrarSource`, and
`preparation`, plus explicit `readScope: 'source-root'`. The preparation JSON has
`{schema:1, kind:'temari-knowledge-isolated', instance, sourceId, state, root}`;
`state` and `root` must be its sibling `state/` and `sources/` directories. The
callable `prepareRegistrar({python, registrarSource, documents})` in
`src/support/prepare.ts` creates this format from explicit `{path, bytes, origin?,
sha256?}` inputs. It is demo/test support, absent from the product barrel and port.

## Supported boundary and gaps

This is one local POSIX Registrar source-root profile for bounded UTF-8 `.txt`,
`.md`, and `.markdown` reads. Registrar may inspect every indexed document in the
admitted root and write extraction caches. Document-only access, a hostile-process
OS sandbox, remote sources, semantic search/recall, automated dependency inference,
archive retention/recovery, and access-revocation policy are unsupported.

Implementation identity pins/rechecks the Registrar source tree, package/lock
files, adapter/codec, and Python executable. Configuration includes the preparation,
registered source settings and transport bounds. Installed Python dependencies,
standard library, and operating system are not fully attested. Source bytes and
code/config identities are separate. Exact codepoint excerpts are checked against
fatal-decoded UTF-8 bytes, preserving CRLF and astral characters. Lost provider
state yields `unknown`; a positively admitted missing source file yields
`unavailable`. Sequential rechecks do not establish an atomic multi-file snapshot,
original-document currency, exhaustive discovery, or correctness of an assessment.
