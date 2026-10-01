# Archive verification evidence

The final dependency is admitted through
`/private/tmp/temari-knowledge-implementation-20260929/registrar-selected.json`.
Selected dependency: Registrar `92665d939e6f92ec26fab1387cd9d946ccaddc2b`,
archive protocol schema 1, SHA-256
`74f2c5417ceb8f844f217fd620fbc7ee53bdb533a7108a97b4000aa16500f9c4`.
Source: `/private/tmp/temari-knowledge-implementation-20260929/registrar-evidence/source-archive-20260929-r5-workers/build/source-archive-20260929-r5-workers-build/integration`.
Matching Python: `/private/tmp/temari-knowledge-implementation-20260929/python/2797139bc0a8ab9e/bin/python`.
Full six-target execution uses only that reviewed selection.

Command from the implementation clone:

```sh
python3 /private/tmp/temari-knowledge-implementation-20260929/verify_temari_selected.py
```

The helper validates the selected commit, protocol digest and Python package,
copies exact working-tree bytes to an isolated directory, installs the frozen
lockfile there, inspects the resolved Nx project and executes all six targets with
cache disabled. It compares the original and copied source inventories afterward.

Executed continuation checks (2026-09-29):

- The restored implementation passed all six targets: knowledge typecheck,
  26 unit tests, 15 actual-CLI integration tests; plan-draft typecheck,
  273 unit tests and 9 actual-CLI integration tests. Source inventory digest:
  `6d631eb795e2efa8a790936fff79de84c167c91dc858be31e4ea3fff4c62b5ac`.
- After adding the complete JSON demo journey, competing initial captures,
  read-only database checks, actual assessment handoff, contradictory basis
  rejection and full-representation consistency checks, the focused command
  below passed knowledge typecheck, 27 unit tests and 17 actual-CLI integration
  tests. Source inventory digest:
  `505723c570a28c54e4206bc802c8fcbd6db9f88c255e37e42ee01b5fb03f231f`.

```sh
python3 /private/tmp/temari-knowledge-implementation-20260929/verify_temari_selected.py \
  knowledge:typecheck knowledge:test knowledge:integration
```

Those are immutable development observations, not substitutes for the final
six-target check after formatting and the bounded occupied-artifact regression.
The helper emits the final source digest and external `verification-result.json`
path; the implementation handoff references that receipt. No generated verifier
outputs or dependency trees belong in this library.

The first archive integration test executes the documented JSON demo handlers in
fresh Node processes: capture v1, search, selected partial read, capture v2, remove
originals/cache, and resume v1. It checks exact Unicode/CRLF excerpts and preserves
the original checkpoint bytes. Separate tests exercise interrupted publication
with source loss, concurrent first capture and replay, unchanged Registrar database
contents after reader calls, and actual caller-supplied assessment with two cited
records versus four read/context records. No model is invoked.

`archive.integration.test.ts` runs the real Python CLI. `archive-parser.test.ts`
is explicitly a malformed-protocol shim and supplies no archive correctness proof.
`archive.test.ts` uses a replacement provider for consumer contract behavior.

The Registrar-selected source's `docs/evidence/source-archive/corpus-matrix.json`,
`execution-r4.json`, `verification-r4.md`, `verification-r5.md`, and `tests/test_source_archive.py` own the full
preservation/extraction and Nx/non-Nx layout matrix. Temari's `archive-corpus.py`
provides representative real PNG, DOCX, searchable PDF and image-only PDF inputs.
The integration assertions recover their original bytes exactly. Searchable PDF
extraction is asserted only when supported; an explicit
`pdf-memory-boundary-unavailable` receipt is the accepted host gap, not a PDF-text
success. No test claims to interpret pixels.

Pinned Registrar corpus evidence:

- [Executed original preservation and layout matrix](https://github.com/randydinh/content-registrar/blob/92665d939e6f92ec26fab1387cd9d946ccaddc2b/docs/evidence/source-archive/corpus-matrix-r4.json)
- [Reviewed extraction boundary and 293-test execution](https://github.com/randydinh/content-registrar/blob/92665d939e6f92ec26fab1387cd9d946ccaddc2b/docs/evidence/source-archive/verification-r5.md)
- [Actual source archive fixtures](https://github.com/randydinh/content-registrar/blob/92665d939e6f92ec26fab1387cd9d946ccaddc2b/tests/test_source_archive.py)

The selected macOS host reports `pdf-memory-boundary-unavailable`: PDF originals
are retained and recovered, but no successful PDF archive text extraction is
claimed. DOCX text and its visual omissions are asserted through the real CLI.
Standalone and scanned-image fixtures do not supply visual understanding.

## Structural intake continuation (2026-09-30)

The exact continuation passed `knowledge:typecheck`, 36 unit tests and 28
actual-Registrar integration tests through the isolated Nx helper. A new
synthetic integration case publishes both Graft and Nx edges, reads the pinned
graph back, verifies that a single-source intake handoff automatically exposes
its graph to search, and refuses an edited source file, a stale edge whose
endpoints still exist, and call spellings found only in Swift comments, raw
strings, multiline strings, interpolation or Swift regex literals. The Graphify design
ledger readback and `git diff --check` passed.

Two curated local feasibility checks used the real archive and structure
artifacts. The Nx graph provided one source-anchored `depends-on` edge. The
Graft wiring provided 32 source-anchored edges in the earlier feasibility run,
including one inferred call. The stricter AST-span and call-name checks were
verified against the synthetic archive; the private pilot count is historical.
For one annotated query in each corpus at K=2, BM25 alone had expected-document
recall 0 and the graph trial had recall 1. These counts do not estimate general
retrieval quality, prove runtime calls, or establish visual/text coverage.
Private reports and source manifests remain outside this repository.

## Archived generation diff and PDF boundary, 2026-10-01

From an isolated worktree based on merged Temari `ef5553a942e64bbffbc551e74be31f0368b8f58f`,
the final changed source passed `knowledge:typecheck`, 43 `knowledge:test` unit
tests, and 55 `knowledge:integration` actual Registrar CLI tests. The latter
used the bundled pinned Registrar and an isolated Python with its frozen
dependencies. `workflow-runtime:canonical-test` passed 15 tests; canonical
package and check passed, and the relocated stock-Node package exported
`diffArchiveGenerations`.

The new CLI cases compare explicit v1 and v2 captures after an edit, addition,
deletion and rename, including a valid leading-dash filename. They check exact
retained SHA-256 changes, a metadata-only durable receipt, deterministic replay,
historical v1 read, tampered publication rejection and current-registration
revocation. This compares archived originals; it does not establish live source
currentness or refresh graph relationships.

The PDF corpus test now requires a searchable text representation and citation
on Linux, and exact retained bytes with `pdf-memory-boundary-unavailable` on
this macOS host. It requires scanned PDF and PNG fixtures to yield no invented
text. Linux assertions were not executed on this macOS run. The macOS worker
cannot establish a hard address-space, data or resident-memory limit through
`setrlimit`; no successful macOS searchable-PDF extraction is claimed.

## Archived graph impact plan, 2026-10-01

The next isolated increment compares an explicit, complete v1 graph with a
complete v2 archive capture for one registered source. An actual Registrar CLI
test publishes the graph, retracts assertions, recaptures edited/removed/added
documents, and checks the metadata-only plan's review, repin, historical-only,
and discovery queues. The old graph remains readable under v1 but is refused
under v2. A multi-source graph, tampered publication, and disabled registration
also refuse planning. The planner does not mutate the graph, establish live
source currentness, or claim refreshed relationship correctness.

The repaired candidate passed `knowledge:typecheck`, 43 unit tests, and 56
actual-Registrar integration tests through Nx. The 15 canonical runtime tests,
canonical package/check, and a relocated stock-Node import of
`planArchiveGraphImpact` passed. Independent review found no remaining blocking
issue after the historical-only and changed-path repairs.
