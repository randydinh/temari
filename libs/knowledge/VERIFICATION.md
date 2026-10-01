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

## Read-only v2 graph anchor proposal, 2026-10-01

The repin increment passed `knowledge:integration` 67/67, `knowledge:test`
43/43, `knowledge:typecheck`, formatting and diff checks. Actual Registrar CLI
fixtures verify an unchanged node and relationship, including support and
contrary anchor positions. A long unchanged anchor and its dependent
relationship defer explicitly; a pinned 4 KiB transport shortens a v2 read
and also defers. Tampered impact, v2 publication or capture binding, and
revoked registration refuse the proposal. The v1 graph remains unreadable
under v2; no graph is published. Independent exact-head review and canonical
package/check remain delivery gates at this checkpoint.

The metadata-only receipt partitions every bounded `needRepin` ID into
`eligible` or `deferred`; it does not certify relationship meaning, live
currentness, cross-source graph migration or a default search improvement.

## Point-in-time local currentness audit, 2026-10-01

The next isolated increment passed `knowledge:typecheck`, 43 unit tests and
57 actual-Registrar integration tests through Nx. Its new case compares one
complete pinned archive with a later local edit, addition and deletion,
checks unchanged hashes, tests oversized and symlink unknowns, refuses a
tampered pin and disabled registration, and confirms the historical archived
read still returns v1 text. It asserts the audit receipt has no document body.
The bundled Registrar's focused Python regression forces a byte change
between scan passes and confirms refusal without modifying the archived
manifest or blob count. The 15 canonical runtime tests also passed.

The audit is a bounded, non-atomic observation of the local root. A file that
cannot be verified is `unavailable`, so a partial result cannot certify the
whole source as unchanged. The result does not schedule recapture, repin a
graph, establish continuous freshness, or resolve the macOS PDF text gap.

## Bounded currentness snapshot paging, 2026-10-01

The next isolated increment passed `knowledge:typecheck`, 43 unit tests, 59
actual-Registrar integration tests, four focused Registrar snapshot tests, and
15 canonical runtime tests. The actual CLI journey verifies one immutable audit
across source edits, a bad cursor and revoked registration, Python Unicode
code-point path order, and multiple pages with a pinned 16,000-byte transport
cap. A dense 994-path Python fixture exceeds the former 1 MiB one-shot limit
but returns every row through bounded pages; a 2,000-path union and schema-4
to schema-5 migration are also covered. Independent read-only review found no
remaining blocking issue after byte-cap, ordering, cursor and contract repairs.

The Registrar stores at most eight content-addressed snapshots per source,
each bounded to 8 MiB. Pages recheck current source admission and archive pin,
and Temari publishes only hash, size, path and gap metadata. The snapshot is a
non-atomic observation at one time; later source edits do not rewrite it.
This does not establish continuous freshness, automatic recapture, graph
refresh, or searchable PDF text on this macOS host.

## Synthetic sealed retrieval cohorts, 2026-10-01

An actual Registrar CLI fixture now pins five development and five distinct
holdout gold paths outside the registered source root, then runs exact and BM25
at the same top-two budget. All ten gold paths were indexed and all shortlists
were verified. Each cohort scored exact 3/5 and BM25 5/5, with no per-case
regression or unverified shortlist; the existing local gate returned
`promotion-eligible`. The fixture includes rare identifiers, two partial
paraphrase probes, duplicate-document crowding and contrary drafts. Injected
key and fetch counters stayed at zero, so this evaluation made no hosted call.

The final test-only edit passed its focused actual-CLI Nx integration run (1/1)
and `knowledge:typecheck`. A full integration run before the final scenario
assertions passed 64/64; the final focused run verifies those assertions. The
cohorts were authored with the synthetic fixture, so the result validates gate
mechanics and a specific lexical comparison, not untouched real-task holdout
quality or a default-ranker change. No-answer, image-only and searchable-PDF
coverage remain open.

## Operator-triggered source recapture handoff, 2026-10-01

A new local API composes a complete pinned v1 capture, an explicit v2 capture,
the retained-original generation diff and optional read-only graph impact.
Four focused actual Registrar CLI cases passed after the final repairs. The
full `knowledge:integration` suite passed 64/64, `knowledge:test` passed 43/43,
and `knowledge:typecheck` passed on the final source. The tests edit, add and
remove files while preserving unchanged files and historical v1 reads; check
diff counts and optional graph review; and refuse a reused key, changed task,
source or transport, disabled registration, forged task authority, tampered
manifest, invalid v1 graph and incomplete v2 without a successful handoff.
A 16 KiB pinned transport case also passes. Independent read-only review found
no remaining blocker after adding pre-capture original-binding and graph
checks and a final graph-impact receipt digest recheck.

The successful handoff is bounded metadata with v1/v2 publication pins and
diff/impact receipt hashes. It says `currentOriginal: not-checked` and
`graphMutation: none`. A failed downstream step can leave a complete v2 capture
without a handoff; the typed error exposes its persisted capture paths. One
request key denotes one logical idempotent capture, so concurrent retries can
share it. This does not schedule changes, serialize all recaptures, rebuild a
graph or prove continuous source freshness. The shared historical publication
loader also checks the original binding, as described below. Production
backup/restore and macOS searchable-PDF text remain open.

## Original capture binding consistency

The shared publication loader now requires the original task-scoped capture
binding and checks its request-key-derived ID, schema and eight publication
fields. Its ancestry walk applies the same check beneath rebinds. An actual
Registrar CLI case failed against the old loader, then passed after the fix:
changed original publication, each shared binding field and a missing binding
are refused for direct and two-step rebind reads. Synthetic parser and Jev
privacy fixtures now include realistic binding artifacts. Final checks passed:
`knowledge:integration` 65/65, `knowledge:test` 43/43, a post-final focused
integration rerun 3/3, and `knowledge:typecheck`. A manually constructed legacy
publication without the binding now refuses; migration needs an explicit
decision. This checks local artifact consistency, not authenticity against a
writer who can rewrite both files. Limits and OCR mode are outside the shared
publication fields and are not certified by this check.

## Resume a complete persisted source capture, 2026-10-01

`resumeArchiveSourceHandoff` passed the final `knowledge:integration` suite
70/70, `knowledge:test` 43/43, `knowledge:typecheck`, and post-final focused
actual-CLI checks 7/7. An actual complete v2 capture can be selected with v1,
resumed twice with identical receipt bytes, and leaves Registrar generation
and capture-attempt counts unchanged. The test retains historical v1 reads and
checks diff and graph-impact queues. It refuses a changed attempt key or
limits, swapped result path, incomplete v2, invalid v1 graph, reversed capture
order, missing result and revoked registration. The existing recapture
schema-1 receipt shape remains unchanged and has a regression assertion.

The new resume receipt has a distinct kind and pins attempt/result/binding
hashes. It labels v1 as operator-selected during resume; those artifacts do
not prove a previous call selected that v1 or even failed. This is a local,
no-capture completion path, not automatic scheduling, crash recovery without
a result, production restore or continuous source freshness.

## Operator-attributed fresh v2 graph root, 2026-10-01

`publishReviewedArchiveGraphRoot` requires an explicit subset of the verified
v2 repin proposal and an operator-supplied reviewer reference and reason. It
rechecks pinned publications, the old graph and current admission, rereads
selected v2 anchor spans, and publishes a fresh `parent: null` graph through
the actual Registrar CLI with new deterministic record IDs. The receipt maps
old IDs to new IDs and lists excluded review, historical and discovery queues.
It reports `semanticCorrectness: not-verified`,
`reviewerAuthenticated: false` and `currentOriginal: not-checked`; unchanged
quotes alone do not establish that a relationship still means the same thing.

The actual-CLI fixture checks selected nodes and a relationship with contrary
evidence, changed/dependent/retracted/superseding exclusions, missing endpoint
refusal, exact v2 RevisionSet read, historical v1 read, deterministic repeat,
post-publish receipt-collision recovery, and tampered publication or revoked
admission refusal. The final full Nx integration suite passed 71/71 after the
last edits; focused integration passed 1/1, unit tests 43/43, and typecheck
passed. The
quote-bearing publish draft is retained in the task directory as a bounded
mode-0600 artifact for deterministic replay. Generated receipt evidence is
metadata only; the reviewer reference and reason are operator-supplied free
text. This does not authenticate the reviewer, promote graph facts
automatically, or establish continuous source freshness.

## Explicit reviewed-v2-root graph evaluation, 2026-10-01

`evaluateReviewedArchiveGraphRoot` reads a content-addressed fresh-root review
receipt, checks its v2 publication, source admission, draft and graph pins,
then builds an archive provider for exactly that v2 publication. It verifies
each operator-supplied lexical candidate against retained v2 bytes and runs a
bounded one-hop graph trial. The persisted summary pins the trial checkpoint,
counts gaps and target reads, and carries no excerpts. The private trial
checkpoint may contain excerpts. The case query is attribution metadata, not
an executed search; lexical and gold inputs are operator supplied. The summary
therefore marks BM25 lift, gold coverage, semantic correctness, reviewer
authentication and original currentness as unverified, with no operational
query or graph mutation. Wall-clock timing can give repeated diagnostics
different per-run summary hashes.

An actual Registrar CLI fixture first confirms a v1 graph refuses under the
v2 publication. Its explicitly reviewed v2 root then adds one unchanged,
archived and revalidated related target from an extracted link. The changed
target remains excluded. Tampered review bytes, a bad lexical original hash
and revoked registration refuse the evaluation. Full Nx knowledge integration
passed 72/72 after the final checkpoint-integrity repair; a focused actual-CLI
run passed 1/1, unit tests 43/43 and typecheck passed. This does not enable
graph expansion in unlabelled production search.
