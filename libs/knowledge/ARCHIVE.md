# Local archive handoff

This guide is for an operator handing explicitly admitted local sources to a Temari
reader. Registrar retains originals and extracted representations. Temari stores
request bindings, publication references, capability receipts, and bounded evidence
checkpoints. A publication JSON is **not a backup of the original documents**.

## Before starting

Use a supported Registrar source tree, its matching isolated Python, an existing
Registrar workspace, and a canonical existing Temari task directory. The source
must already be registered and enabled. Admit its entire root explicitly. Nothing
in intake or the reader registers, refreshes, fetches, watches, invokes a model, or
executes document instructions. The current local text adapter remains unchanged.

The adapter consumes archive protocol schema 1, including the additive read
`path/offset/total_chars/next_offset` and discovery count/snapshot fields. See
[verification evidence](VERIFICATION.md) for the reviewed dependency and executed
checks. Run all commands below from the Temari workspace root with its frozen
workspace dependencies installed.

For an entirely synthetic setup, create two text files and use the existing
[`prepare` demo](README.md#local-demo-and-preparation). It prints the new isolated
workspace, source identity and task directory. Alternatively, explicitly register
a synthetic directory with Registrar's `sources ... add` operator command. Neither
setup operation belongs to the archive reader.

## Capture and hand off

Write `/absolute/intake.json` with your actual admitted values:

```json
{
  "task": {
    "id": "archive-demo",
    "directory": "/absolute/task",
    "authorityRef": "explicit-synthetic-demo-admission"
  },
  "source": {
    "provider": "my-explicit-registrar-instance",
    "id": "REGISTERED_SOURCE_ID",
    "locator": "file:///absolute/synthetic-documents"
  },
  "readScope": "source-root",
  "transport": {
    "python": "/absolute/isolated/python",
    "registrarSource": "/absolute/registrar-source",
    "workspace": "/absolute/registrar-state"
  },
  "requestKey": "v1",
  "limits": { "entries": 100, "file_bytes": 1048576 }
}
```

`source.locator` must exactly match the registered canonical root's file URL.
`provider` is the caller's stable instance label. It is part of the admission and
cannot be changed during replay. Task IDs, authority, source, limits, process and
adapter identities are bound before capture.

```sh
pnpm nx run knowledge:demo -- capture --input /absolute/intake.json
```

The result gives `publicationPath`, `preservation`, `gaps`, `attemptPath`, and
`resultPath`. `status: published` means an immutable Registrar generation is
referenced. Inspect `preservation`: `incomplete` must never be called lossless.
`complete-admitted` describes retained admitted originals; it does not imply
extraction, OCR, visual interpretation, or semantic completeness. Useful extracted
text can coexist with `visual-evidence-unavailable` and other omissions.

Intake derives `temari-archive-v1:SHA256(task identity/authority + caller key)`;
Registrar scopes it by source. Each invocation publishes a started attempt and a
terminal result. It publishes the immutable request binding **before** invoking
capture. Temporary files are synced, linked without overwrite, and the directory
is synced; collision content is checked. Concurrent successful callers converge
on one publication, while every attempt retains its own evidence. Registrar may
refuse a competing writer: retry the same request. A started attempt without a
result records interrupted work, not success.

If capture commits and publication fails or the process dies, keep exactly the
same intake JSON and rerun. Registrar resolves the original generation even if the
original directory has since disappeared. Changing limits, configuration, source,
or adapter implementation under the same key is refused. Use a new key for a new
observation. Persistence failures throw `ArchivePersistenceError` rather than
claiming durable completion. Do not delete failed receipts to make a retry appear
clean.

## Search, select and checkpoint

The read role receives publication paths, not a capture capability. Its provider
has only `identity`, `discover`, `read`, and `revalidate`. It supports up to eight
explicit publications in one workspace, one generation per source. No discovered
source or path expands admission.

Create `/absolute/search.json`:

```json
{
  "config": {
    "publications": ["/absolute/task/archive-publication-BINDING.json"],
    "readScope": "source-root"
  },
  "task": {
    "id": "archive-demo",
    "directory": "/absolute/task",
    "authorityRef": "explicit-synthetic-demo-admission"
  },
  "request": {
    "scope": [
      {
        "provider": "my-explicit-registrar-instance",
        "id": "REGISTERED_SOURCE_ID",
        "locator": "file:///absolute/synthetic-documents"
      }
    ],
    "query": "proposal",
    "selections": [],
    "limits": {
      "evidenceCodePoints": 100000,
      "contextCodePoints": 65536,
      "stateBytes": 1048576
    }
  },
  "budget": {
    "calls": 4,
    "responseBytes": 131072,
    "codePoints": 8000,
    "codePointsPerRead": 1000,
    "documentsPerPage": 1
  }
}
```

```sh
pnpm nx run knowledge:demo -- archive-collect --input /absolute/search.json
```

Read the returned `checkpointPath` JSON. Its `discovery[].documents[]` contains
source-relative paths and original-byte SHA-256 values. Counts separate indexed,
matched, returned, consumed and remaining documents. `consumed` means enumerated,
not read. Search-only completion can contain zero evidence and zero context IDs.
Exhaustion says nothing about semantic recall or unsupported images.

Choose a document explicitly. Copy the search input to `/absolute/read.json`, set
`request.query` to `null`, and set `request.selections` to:

```json
[
  {
    "document": {
      "source": {
        "provider": "my-explicit-registrar-instance",
        "id": "REGISTERED_SOURCE_ID",
        "locator": "file:///absolute/synthetic-documents"
      },
      "path": "plan.txt"
    },
    "expectedSha256": "ORIGINAL_SHA256_FROM_DISCOVERY"
  }
]
```

Use `budget.calls: 2` and `budget.codePointsPerRead: 9` to observe a bounded partial
read (for a document longer than nine codepoints):

```sh
pnpm nx run knowledge:demo -- archive-collect --input /absolute/read.json
pnpm nx run knowledge:demo -- archive-collect --input /absolute/read.json \
  --resume /absolute/task/retrieval-HASH.json
```

Increase only the pass budget for progress: a pass needs a call per new page plus
one revalidation call per retained evidence record. For example set calls to 100
and responseBytes to 1048576. Retained limits, task, authority, request and provider
must match across resume; changing any of those requires a fresh request. Each
pass leaves prior content-addressed checkpoints untouched.

Evidence IDs identify exact excerpts and their archive descriptor. The descriptor
includes generation, manifest/text/settings hashes, `coordinateSpace:
extracted-text`, `currentOriginal: not-checked` and bounded omissions. Original
`sha256` remains the original file's hash. PDF/Office spans count Unicode
codepoints of extracted text; they are not binary offsets or page coordinates.
Returned `context` serializes those same records, and `contextEvidenceIds` identifies
only supplied records. Revalidation must have `basis: archive-snapshot` to permit
archive context. Missing basis is unusable. Capability omissions survive completed
read resume and conservatively keep `complete: false` / `BLOCKED` even when useful
text is returned. Read the gaps, not just the status.

The generic collector does not assess anything. A caller can hand the returned
context to its own assessment function. For the existing structured design/update
assessment, `archive-assess` accepts `{config, task, brief, request}` using the
existing `InvestigationRequest` and optional `--assessment` / `--resume` arguments.
The callable `investigateDesignUpdate` accepts the same archive reader. Its assessed
citations remain separate from discovered, read, and context evidence. Neither route
returns a semantic PASS.

## Prove v1 survives v2 and source loss

On your synthetic source, edit `plan.txt`, copy intake JSON to `intake-v2.json`, and
change only `requestKey` to `v2`. Capture again. The new publication must have a
new generation. Keep `/absolute/read.json` pointing to the **v1** publication.

Move the synthetic original directory aside (outside any registered source), and
move aside the workspace's disposable `cache` directory if present. Resume the
v1 read in a fresh process with the command above. The excerpts and their original
hash must still describe v1. Every unchanged check says the retained snapshot is
intact; it explicitly says current originals were not checked. Restore the moved
directories after the exercise if you need live operations again.

Original byte recovery is a separate Registrar operator action:

```sh
/absolute/isolated/python -B -m knowledge_agent.cli archive \
  --workspace /absolute/registrar-state recover \
  REGISTERED_SOURCE_ID GENERATION plan.txt /absolute/new-recovered-plan.txt
```

Run it in the selected Registrar environment. The destination must be new and
outside registered roots and the workspace. Temari exposes no recovery method.

## Failures and trust boundary

- Scope errors, traversal, noncanonical paths, changed query/configuration cursors,
  and mismatched generations fail closed. Scope denial precedes the subprocess.
- Disabled sources or changed exclusions/root admission revoke old archive access.
  A missing original alone does not revoke historical access.
- Corrupt/missing retained blobs or manifests yield an archive integrity/unavailable
  gap. No fallback reads a live original, re-extracts, or selects latest.
- A malformed or oversized response is rejected. Subprocesses use an explicit
  argument vector, restricted environment, timeout and byte bounds, with no shell.
- Source, lock, Python binary, protocol, adapter and publication configuration are
  pinned. Installed dependencies, standard library and OS are not fully attested.

The trusted local Registrar process verifies whole manifests and retained bytes.
An excerpt and matching returned hashes are **not** a cryptographic inclusion proof
of the whole representation. A hostile process or actor rewriting trusted state is
outside this profile. Checkpoints are immutable local evidence, not authenticated
statements about their author. Publication references do not implement backup,
erasure, disaster recovery, semantic recall, or multiuser authorization.

Nx project/AST navigation, Graft, Graphify generation, BM25, Jev judging, OCR,
visual interpretation, remote connectors and SkillOpt remain future integrations.
Archive fixtures that resemble repositories do not certify those capabilities.
