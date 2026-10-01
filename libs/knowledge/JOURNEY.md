# Local intake-to-retrieval evaluation

This is an operator-run, two-responsibility flow over explicitly registered local
Registrar sources. Intake can capture and publish; search receives only an immutable
handoff and can discover, read and revalidate retained snapshots. Neither command
scans for new sources or executes instructions found in documents.

## Prepare admitted sources

Create a private, canonical task directory and a Registrar workspace outside this
repository. Register each selected source root with Registrar's `sources add` command.
Use curated copies when a repository or personal folder contains files outside the
evaluation grant. Keep the original path, revision and SHA-256 in a private source
manifest. Do not commit source copies, local reports or credentials.

Use the source IDs returned by registration in an intake plan:

```json
{
  "task": {
    "id": "local-eval",
    "directory": "/absolute/private-task",
    "authorityRef": "/absolute/private-source-manifest.json"
  },
  "localOnlySourceIds": [],
  "intakes": [
    {
      "task": {
        "id": "local-eval",
        "directory": "/absolute/private-task",
        "authorityRef": "/absolute/private-source-manifest.json"
      },
      "source": {
        "provider": "local-eval",
        "id": "REGISTERED_SOURCE_ID",
        "locator": "file:///absolute/selected-root"
      },
      "readScope": "source-root",
      "transport": {
        "python": "/absolute/python",
        "registrarSource": "/absolute/content-registrar",
        "workspace": "/absolute/registrar-state"
      },
      "requestKey": "corpus-v1"
    }
  ],
  "structures": [
    {
      "sourceId": "REGISTERED_SOURCE_ID",
      "artifactPath": "/absolute/pinned-nx-project-graph-or-graft-wiring.json",
      "kind": "nx",
      "paths": ["libs/knowledge/package.json", "libs/contracts/package.json"],
      "maxEdges": 64
    }
  ]
}
```

From the Temari workspace root, with frozen dependencies installed:

```sh
pnpm nx run knowledge:demo -- journey-intake --input /absolute/intake-plan.json
```

Keep the returned `handoffPath`. A blocked capture produces no handoff. Intake
persists its attempts, publications and capability gaps in the task directory.
For local PNG text extraction on macOS, install Registrar's optional
`ocr-macos` extra and add `"ocrMode": "macos-vision"` to the selected intake.
The mode is bound to that immutable capture request; ordinary intakes leave
OCR off. The original image is retained, and OCR text keeps explicit
unreviewed-transcription and unavailable-visual-meaning gaps. A bounded local
pilot retrieved an image by OCR text and obtained a Jev shadow judgment, but
this does not validate the diagram's meaning. PDF text remains unavailable on
this host when the archive worker cannot establish its hard memory boundary.
`structures` is optional. `nx` accepts the JSON from `pnpm nx graph --print`;
`graft` accepts a Graft `.graph/wiring.json` generated from the selected
non-Nx checkout. Provide only paths admitted in the source root. Temari checks
each structural endpoint against the retained archive text and the current
source file hash. Graft call candidates require matching AST span hashes and
a Swift call spelling outside comments. Files containing any Swift string
delimiter, unmasked slash/hash syntax or non-ASCII code are omitted until a Swift expression
parser handles interpolation and regex literals; accepted
candidates publish as
`call-name-candidate` because callee resolution is not proven. `contains` is
limited to whole-file Graft fingerprints and fingerprinted child spans. Nx
dependencies require an exact archived package declaration or
`implicitDependencies` entry. An implicit declaration with any exclusion is
omitted until Nx normalization is reproduced. Accepted candidates cite the call
spelling or declared dependency. Other relationships are skipped.
It then publishes a pinned Registrar graph and records skipped edges
in a private receipt. A stale or unsupported endpoint is omitted. Structure
artifacts are candidate navigation, not proof of a call at runtime or test
coverage. Generate artifacts from the same source revision as the capture;
the relationship checks also refuse stale artifact edges that no longer occur
in retained text.
For a retained publication that already exists, use the separate
`structure-publish --input /absolute/structure-plan.json` command with the
same fields plus `publicationPath` instead of `sourceId`.

## Pinned Markdown links

An operator can publish explicit links between Markdown documents already in
one Registrar archive. List both the linking files and every permitted target;
the adapter does not discover new sources or follow links on the network.

```json
{
  "publicationPath": "/absolute/private-task/archive-publication-HASH.json",
  "paths": ["docs/start.md", "docs/guide.md"],
  "maxEdges": 100
}
```

```sh
pnpm nx run knowledge:demo -- document-links-publish --input /absolute/links-plan.json
```

The adapter reads the complete, bounded `utf-8-text` representations from the
pinned archive and publishes only simple inline links to admitted relative
`.md` or `.markdown` paths. It cites the exact link token and a verified target
excerpt. Fences, inline and indented code, comments, frontmatter, images,
external URLs, fragments, query strings and encoded destinations do not create
relationships. The result is a `links-to` fact about the reference, not a claim
that the target agrees with, depends on, or answers the source. Known visual and
asset omissions remain in the receipt. The adapter makes no model call and does
not need the current original file; changed or deleted originals do not alter
the historical graph. Current source admission is still checked.

The returned `graphId` can be supplied explicitly in a `journey-search` case
for an experimental one-hop trial. A `no-anchored-links` receipt has `graphId:
null` and should not be used as a graph. This route does not claim native
Graphify extraction or enable graph ranking by default. HTML link destinations
are not retained in the current visible-text representation and need a separate
versioned extraction path.

An operator can retire an incorrect active graph assertion through
`retractArchiveGraph` with the exact parent graph ID, its admitted publications,
assertion IDs, reviewer reference and review reason. Registrar publishes a child
generation; Temari saves an immutable task receipt with the reason. The parent
and its original evidence remain readable. Search feedback or a Jev judgment
may prompt review but cannot trigger retraction automatically.

## Search and score

On macOS, Jev looks up the TypeSafe key in the current user's Keychain item
`temari-typesafe-jev` when `TYPESAFE_API_KEY` is unset. The adapter reads it only
after the registered-source sharing gate passes. An explicit server-side key or
`TYPESAFE_API_KEY` takes precedence for deployments. The key is never included
in task receipts or reports. A local-only source never reaches the lookup or
TypeSafe. Vercel is not part of this path.

Write a separate search plan. Gold paths are explicit annotations, not text
extracted from the source. Each case narrows the handoff to listed source IDs.

```json
{
  "handoffPath": "/absolute/private-task/archive-handoff-HASH.json",
  "cases": [
    {
      "id": "known-answer-1",
      "query": "example search terms",
      "sourceIds": ["REGISTERED_SOURCE_ID"],
      "expected": [
        { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/document.md" }
      ],
      "topK": 4,
      "discoveryMode": "bm25"
    }
  ]
}
```

```sh
pnpm nx run knowledge:demo -- journey-search --input /absolute/search-plan.json
```

`expectedRecallAtK` measures whether the annotated documents appear in the ranked
top K. `shortlistVerified` means each selected document yielded a first excerpt
whose archived SHA and read check were accepted. It does **not** mean full-document
coverage or a correct answer. The private shortlist checkpoint retains up to 1,000
codepoints per selected document with exact evidence IDs and checks; the report
contains no source excerpts. `sourceCapabilityGaps` and case `gaps` must be read
alongside scores. A first-page continuation leaves `discoveryExhausted: false`.
`timingMs` separates discovery, excerpt reads and Jev from total case time;
compare modes on the same pinned handoff and budgets.

New intake handoffs use a standing TypeSafe policy: verified excerpts from
registered sources can go to Jev without approval for every search. Mark a source
local-only by adding its registered source ID to `localOnlySourceIds` in the intake
plan. That choice is pinned in the immutable handoff and wins even if a later
search case sets `hostedTextApproved: true`. For an individual search, set
`hostedTextApproved: false` to keep that case local. Older handoffs without the
standing policy still require the explicit per-case boolean. A Keychain entry or
API key supplies credentials but does not change the source policy.

The Jev request carries the query, candidate IDs and bounded, revalidated shortlist
excerpts. The archive, full documents and local-only sources remain local. The report records
`jevSharing` as `allowed`, `local-only`, or `case-opt-out`. Jev still produces
shadow advice only. Missing key, network or invalid response leaves judgments
`unknown`. For macOS local runs, load the saved key into the search process:

```sh
TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s "temari-typesafe-jev" -w)" \
  pnpm nx run knowledge:demo -- journey-search --input /absolute/search-plan.json
```

For an optional graph ablation, set `graphId` on a search case to a published
Registrar graph ID covering the selected archive publications. A single-source
case automatically trials the graph recorded in its intake handoff when
`graphId` is omitted. The report keeps
`ranked` and `expectedRecallAtK` as the lexical baseline and adds `graph.ranked`,
`graph.expectedRecallAtK`, relationship provenance and explicit gaps. The trial
uses the first lexical hit with an active, archived graph relationship as its
seed and verifies at most `topK - 1` one-hop
related documents through the same archived provider. Its ordering is an
experimental policy, not a default ranker or evidence of semantic correctness.
No graph quotations or source excerpts enter the report; a private checkpoint
retains verified graph evidence. A missing/stale graph leaves lexical results
available and records a gap.

This loop measures local archive, exact/BM25 ranking and bounded evidence reads.

## Sealed retrieval gate

Keep the question set in the private task workspace. Define `development` before
changing retrieval code and a separate `holdout` before inspecting challenger
results. Record the holdout's SHA-256 in a dated, append-only decision log or
commit before tuning; the runner verifies the supplied hash but cannot prove
when an operator first sealed it. Each question names its registered source scope and one or more
source-relative gold paths. Gold documents must be disjoint across every
question in both cohorts, so rewording one question about the same document
cannot inflate the independent sample. The gate refuses a changed question-set
SHA-256, repeated questions, reused gold documents, or a changed handoff. The following shape
omits real source IDs and paths:

```json
{
  "schema": 1,
  "handoffPath": "/absolute/private-task/archive-handoff-HASH.json",
  "topK": 3,
  "cohorts": {
    "development": [{
      "id": "question-1", "query": "bounded search terms",
      "sourceIds": ["REGISTERED_SOURCE_ID"],
      "expected": [{"sourceId": "REGISTERED_SOURCE_ID", "path": "relative/file.md"}]
    }],
    "holdout": [{
      "id": "question-2", "query": "separate search terms",
      "sourceIds": ["REGISTERED_SOURCE_ID"],
      "expected": [{"sourceId": "REGISTERED_SOURCE_ID", "path": "relative/other.md"}]
    }]
  }
}
```

```sh
shasum -a 256 /absolute/sealed-questions.json
pnpm nx run knowledge:demo -- journey-gate --input /absolute/sealed-questions.json --sha256 FULL_SHA256
```

The runner reads the exact pinned intake handoff, inspects every archived gold
path, and runs exact and BM25 for each question at the same `topK` and first-excerpt
budgets. It explicitly opts every case out of Jev; no key lookup or hosted call is
needed. Private search reports retain paths and evidence checkpoints in the task
directory. The gate receipt contains question IDs, coverage reason counts, scores,
verification status, timing, report paths and hashes, without source text or gold
paths. A preserved PDF without a text representation counts as a coverage gap,
not a ranker miss. Gold paths absent from the capture are also coverage gaps.
Each fully indexable comparison requires a verified first discovery page that
contains the complete top K. Further lower-ranked pages need not be fetched;
a failed or undersized first page aborts without a passing receipt.

`promotion-eligible` requires at least five independent questions in **each**
cohort, all gold paths indexed, verified returned shortlists, at least one extra
gold hit for BM25 in each cohort and no case-level regression. This is a local
review gate, not automatic promotion or proof of answer quality. `coverage-blocked`
and `insufficient-sample` take precedence; otherwise a failed comparison is
`rejected`. The receipt still shows diagnostic recall on the fully indexable
cases. Add new case cohorts before tuning to them; a reused holdout becomes
development evidence and needs replacement for a later promotion decision.
An extraction gap such as `empty-document` or `pdf-memory-boundary-unavailable`
blocks promotion even when BM25 improves the remaining indexed documents. If
the runner itself fails, no passing receipt is published; inspect the private
task reports and rerun only after the cause is resolved.

Graft and Nx artifact generation remain operator-owned. Native Graphify
non-code extraction, image interpretation, a scheduled pair of autonomous
agents and semantic answer quality remain separate
capabilities to implement and evaluate. The archive preserves unsupported files
with gaps rather than claiming their contents were understood.
The [bounded real-corpus pilot](../../docs/evidence/knowledge-system/real-corpus-pilot-2026-09-30.md)
records the latest measured coverage and remaining format/relationship gaps.
