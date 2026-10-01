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
source file hash. Python Graft `calls` edges require matching Graft span hashes,
exact Python AST definition name/kind/span, and one `ast.Name` call token in
the source definition's own body. Both endpoints must be in the same pinned
file; a matching name in another file is omitted until import/module mapping
can verify it. Temari parses the bounded retained Python text in a short-lived
isolated subprocess using the configured transport Python. It excludes nested
definitions, decorators/defaults, attribute calls, local and enclosing
shadowing (including match captures), nested or class-method target
definitions, and module rebinding/import aliases. The AST is cached per file
for one publication attempt. Imports whose target is only a module name have
no Graft node ID and are omitted as `import-target-without-node`; a future
adapter must map module names to pinned file nodes before asserting imports.
Swift candidates require a call spelling outside comments. Files containing
any Swift string delimiter, unmasked slash/hash syntax or non-ASCII code are
omitted until a Swift expression parser handles interpolation and regex
literals; accepted
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

## Compare two archived generations

After explicitly capturing the same registered source twice with different
request keys, a caller can compare the retained originals in those two pinned
generations:

```ts
import { diffArchiveGenerations } from '@temari/knowledge';

const { receiptPath, receipt } = await diffArchiveGenerations({
  beforePublicationPath:
    '/absolute/private-task/archive-publication-BEFORE.json',
  afterPublicationPath: '/absolute/private-task/archive-publication-AFTER.json',
});
```

The durable receipt lists added, removed, changed and unchanged **captured
originals** by relative path and SHA-256. It contains no document body. Both
publications must be complete, use the same enabled registration and compatible
Registrar implementation, and pass pinned manifest inspection. Excluded files
are outside this comparison. `removed` means an original was retained in the
first capture but not the second; it does not prove a live file was deleted.
A changed path can guide an operator to rebuild affected graph relationships,
but the receipt does not do that rebuild. It
always says `currentOriginal: not-checked`: it compares two archived snapshots,
without checking whether the source has changed since either capture. Historic
readers remain pinned to their selected generation.

## Plan graph work after a capture

For a graph pinned to one source's **before** publication, inspect which old
records need attention after the explicit new capture:

```ts
import { planArchiveGraphImpact } from '@temari/knowledge';

const { receiptPath, receipt } = await planArchiveGraphImpact({
  beforePublicationPath:
    '/absolute/private-task/archive-publication-BEFORE.json',
  afterPublicationPath: '/absolute/private-task/archive-publication-AFTER.json',
  beforeGraphId: 'OLD_GRAPH_ID',
});
```

The durable receipt contains record IDs and path names, not source excerpts.
`needsReview` covers changed or removed anchors and relationships depending on
them. `needRepin` covers remaining old records: even unchanged original bytes
cannot make an old generation and manifest anchor valid in the new graph.
`historicalOnly` keeps retracted assertion IDs out of the new work queue.
`needDiscovery` lists added and changed paths as places to inspect for new facts,
without claiming any new relationship. This is a work plan only; it leaves the old graph readable
under its original publication and publishes no child graph. Multi-source
graphs are refused until every selected source has an explicit revision
comparison. The receipt retains `currentOriginal: not-checked` and does not
prove the live source is still current.

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

### Query feedback and reviewed graph changes

`query-feedback` accepts a private operational `archive-query-*` report, the
original query text, an operator attribution and reason, and explicitly
selected `relevant` and `missed` document pins (`sourceId`, source-relative
`path`, `sha256`). Relevant pins must match the ranked shortlist; missed pins
must be outside it. The command verifies the query hash, exact report and
handoff bytes, current source admission and archived reads before saving a
content-addressed feedback receipt. Its private `candidate` is a labeled
search case with `hostedTextApproved: false`. This makes a regression question
available for a separately sealed evaluation; it publishes no graph edge and
does not change default ranking.

```json
{
  "reportPath": "/absolute/private-task/archive-query-HASH.json",
  "query": "the exact original query",
  "reviewerRef": "operator:local-review",
  "reason": "Verified the selected documents against the task",
  "relevant": [
    { "sourceId": "SOURCE", "path": "a.md", "sha256": "ORIGINAL_SHA256" }
  ],
  "missed": []
}
```

```sh
pnpm nx run knowledge:demo -- query-feedback --input /absolute/private-feedback.json
```

`graph-reviewed-change` publishes one child generation from an exact parent
graph and selected archive publications. The operator can retract specified
assertion IDs, add one Markdown `links-to` assertion, or do both. For an
addition, supply the retained source and target paths, an explicit allowed
path set, and the Unicode code-point offset of `[` in the source link.
Temari rebuilds the link and both anchors from the archived representation,
checks current admission and the parent's RevisionSet, verifies the child,
and saves a receipt with exact publication byte pins. The parent stays
readable. A review attribution string is recorded; it is not authenticated
identity. Query feedback and Jev output cannot create an assertion.

```json
{
  "publications": ["/absolute/private-task/archive-publication-BINDING.json"],
  "parentGraphId": "PARENT_GRAPH_SHA256",
  "reviewerRef": "operator:local-review",
  "reason": "Checked the retained Markdown link and target",
  "retractAssertionIds": [],
  "addLink": {
    "publicationPath": "/absolute/private-task/archive-publication-BINDING.json",
    "sourcePath": "a.md",
    "targetPath": "b.md",
    "codePointOffset": 42,
    "allowedPaths": ["a.md", "b.md"]
  }
}
```

```sh
pnpm nx run knowledge:demo -- graph-reviewed-change --input /absolute/private-graph-review.json
```

This reviewed link path supports one same-source Markdown link at a time.
Unsupported destinations, code, raw HTML, images, unadmitted targets and
ambiguous source text remain omissions. A fresh source capture needs a new
review against its new RevisionSet; old graph generations remain historical.

## Search and score

On macOS, Jev looks up the TypeSafe key in the current user's Keychain item
`temari-typesafe-jev` when `TYPESAFE_API_KEY` is unset. The adapter reads it only
after the registered-source sharing gate passes. An explicit server-side key or
`TYPESAFE_API_KEY` takes precedence for deployments. The key is never included
in task receipts or reports. A local-only source never reaches the lookup or
TypeSafe. Vercel is not part of this path.

Registrar also holds each source's current sharing setting. To change it for an
already registered source, run `python -m knowledge_agent.cli sources
--workspace /absolute/registrar-state set-sharing REGISTERED_SOURCE_ID
local-only` (or `registered-sources` to allow future hosted use). The current
setting is checked before credential lookup and before every TypeSafe attempt,
including retries. A current `local-only` setting overrides an older handoff
that allowed sharing. A handoff already pinned `local-only` stays local even
if the current setting later changes. If the current setting cannot be
verified, Jev is denied and local search still returns its evidence and gap.
This is Temari's hosted-use gate; Registrar's generic local CLI/MCP reads do
not interpret sharing metadata as a ban on local retrieval.

For ordinary search, use an unlabelled query. It selects a pinned intake handoff,
source scope, exact or BM25 discovery and a bounded top K. There is no gold path,
recall score or graph expansion in this path:

```json
{
  "handoffPath": "/absolute/private-task/archive-handoff-HASH.json",
  "id": "user-query-1",
  "query": "example search terms",
  "sourceIds": ["REGISTERED_SOURCE_ID"],
  "topK": 4,
  "discoveryMode": "bm25"
}
```

```sh
pnpm nx run knowledge:demo -- journey-query --input /absolute/query.json
```

The content-addressed `archive-query-HASH.json` report contains ranked pinned
document paths and hashes, first-excerpt verification counts, source and search
gaps, and Jev shadow advice. It contains no source text, expected paths, recall
score or required gold flag. The private shortlist checkpoint holds the bounded
verified excerpts and evidence checks for a reader. `shortlistVerified` covers
only the selected first excerpts, not complete documents or answer quality. Jev
cannot override BM25 or exact order; `suggestedOrder` is advice. A local-only
source or `hostedTextApproved: false` prevents TypeSafe calls. Unknown input
fields, including a misspelled privacy field, fail before discovery or Jev.
This CLI action is a single run, not a durable scheduled job: repeat invocations
can repeat TypeSafe requests and billing, including after a crash. Use the
two-job coordinator below for a resumable intake and query. Older handoffs
without a pinned sharing policy require an explicit `hostedTextApproved` boolean.

### Resumable intake and query jobs

Put the same intake plan and an unlabelled query **without** `handoffPath` in
one private job plan:

```json
{
  "intake": { "task": {}, "intakes": [] },
  "query": {
    "id": "user-query-1",
    "query": "example search terms",
    "sourceIds": ["REGISTERED_SOURCE_ID"],
    "topK": 4,
    "discoveryMode": "bm25"
  }
}
```

The displayed `intake` object is a placeholder for a complete plan from the
intake section above. The query may narrow that plan's source IDs. `localOnlySourceIds`
remains part of intake; `hostedTextApproved: false` on the query is an additional
opt-out. Unknown plan fields fail before either job starts.

```sh
pnpm nx run knowledge:demo -- journey-jobs-create --input /absolute/jobs-plan.json
pnpm nx run knowledge:demo -- journey-jobs-tick --spec /absolute/private-task/archive-job-spec-HASH.json
pnpm nx run knowledge:demo -- journey-jobs-tick --spec /absolute/private-task/archive-job-spec-HASH.json
```

Creation saves an immutable, content-addressed spec. Each tick claims at most
one child in the existing runtime store: intake first, then search only after
its validated handoff succeeds. A repeated tick returns the durable result
without rerunning a completed child. Mechanically failed intake may retry up
to the bounded attempt limit. A hosted search with an uncertain previous
attempt blocks for manual review, because its TypeSafe call may have occurred.
The report pins the requested `topK`, query hash and sharing decision; a
missing excerpt or explicit gap returns `ISSUES`, not a success claim. This is
an operator-run command, with no unattended scheduler or notification service.

Use a separate labelled plan to evaluate retrieval. Gold paths are explicit
annotations, not text extracted from the source. Each case narrows the handoff
to listed source IDs. Unknown plan or case fields fail before search, including
a misspelled `hostedTextApproved` opt-out.

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
API key supplies credentials but does not change the source policy. Registrar
sharing changes do not invalidate a retained archive; upgrading Registrar code
changes the pinned implementation identity, so use `archive-rebind` to bind an
existing generation to the new implementation and create a fresh intake
handoff before searching it.

The Jev request carries the query, candidate IDs and bounded, revalidated shortlist
excerpts. The archive, full documents and local-only sources remain local. The report records
`jevSharing` as `allowed`, `local-only`, `case-opt-out`,
`current-local-only`, or `policy-unavailable`. Jev still produces
shadow advice only. Missing key, network or invalid response leaves judgments
`unknown`. `attemptedRequests` records how many TypeSafe POSTs were started;
revocation after a retryable response can therefore show both a prior attempt
and a current denial. A setting change after a policy check cannot retract a
request already in flight. For macOS local runs, the adapter reads the saved
Keychain item after the sharing gate passes:

```sh
pnpm nx run knowledge:demo -- journey-search --input /absolute/search-plan.json
```

For an optional graph ablation, set `graphId` on a search case to a published
Registrar graph ID covering the selected archive publications. A single-source
case automatically trials the graph recorded in its intake handoff when
`graphId` is omitted. The report keeps
`ranked` and `expectedRecallAtK` as the lexical baseline and adds `graph.ranked`,
`graph.expectedRecallAtK`, relationship provenance and explicit gaps. The trial
uses the first lexical hit with an active, extracted `contains`, `depends-on`
or `links-to` relationship as its seed and verifies at most `topK - 1` one-hop
related documents through the same archived provider. Its ordering is an
experimental policy, not a default ranker or evidence of semantic correctness.
Inferred, ambiguous and call-name-candidate edges cannot expand results.
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
    "development": [
      {
        "id": "question-1",
        "query": "bounded search terms",
        "sourceIds": ["REGISTERED_SOURCE_ID"],
        "expected": [
          { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/file.md" }
        ]
      }
    ],
    "holdout": [
      {
        "id": "question-2",
        "query": "separate search terms",
        "sourceIds": ["REGISTERED_SOURCE_ID"],
        "expected": [
          { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/other.md" }
        ]
      }
    ]
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

## Sealed graph diagnostic gate

Use this after publishing a graph from the same pinned archive capture. Seal a
new development and untouched holdout question set before inspecting graph
results. The runner checks the exact question-set and intake-handoff SHA-256,
requires an explicit graph ID, disjoint normalized questions and disjoint gold
paths, and uses BM25 at the same `topK` as the one-hop graph trial. Each case
opts out of Jev. The graph ID is never silently taken from a handoff default.

```json
{
  "schema": 1,
  "handoffPath": "/absolute/private-task/archive-handoff-HASH.json",
  "graphId": "64-lowercase-hex-digest",
  "topK": 3,
  "cohorts": {
    "development": [
      {
        "id": "question-1",
        "query": "bounded search terms",
        "sourceIds": ["REGISTERED_SOURCE_ID"],
        "expected": [
          { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/file.md" }
        ]
      }
    ],
    "holdout": [
      {
        "id": "question-2",
        "query": "separate search terms",
        "sourceIds": ["REGISTERED_SOURCE_ID"],
        "expected": [
          { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/other.md" }
        ]
      }
    ]
  }
}
```

```sh
shasum -a 256 /absolute/sealed-graph-questions.json /absolute/private-task/archive-handoff-HASH.json
pnpm nx run knowledge:demo -- graph-gate --input /absolute/sealed-graph-questions.json --sha256 QUESTION_SET_SHA256 --handoff-sha256 HANDOFF_SHA256
```

The gate inspects text coverage, checks a complete BM25 top-K discovery page,
verifies the BM25 shortlist and the content-addressed graph checkpoint, and
records both selected excerpt bytes and Unicode codepoints. The selected
excerpt totals are the texts in the final K positions. They are **not** equal
total-work budgets: graph projection and extra target reads add physical work.
The one-hop trial caps target read attempts at `topK - 1`; the receipt reports
those attempts and projected node counts separately. A graph trial with gaps or
an unverified shortlist cannot pass its case. Each arm's final selected context
must stay within `topK × 1000` Unicode codepoints and `topK × 4000` UTF-8 bytes.
Private reports and checkpoints retain paths and excerpts; the gate receipt
retains hashes, IDs, counts, and report paths without source text or gold paths.

The status is always diagnostic: `coverage-blocked`, `insufficient-sample`,
`rejected`, or `diagnostic-improvement`. Even a fully verified improvement across
at least five independent questions in both cohorts, with a non-improving graph
expansion exercised in each cohort, never makes graph ranking
promotion eligible. A reused or inspected holdout must become development
evidence; seal another holdout before a later decision. The existing graph
policy may displace a BM25 gold result. A lost BM25 gold path counts as a
regression even when another gold path replaces it at the same K. Inspect
regressions and actual selected-context sizes before a ranker change.

Graft and Nx artifact generation remain operator-owned. Native Graphify
non-code extraction, image interpretation, a scheduled pair of autonomous
agents and semantic answer quality remain separate
capabilities to implement and evaluate. The archive preserves unsupported files
with gaps rather than claiming their contents were understood.
The [bounded real-corpus pilot](../../docs/evidence/knowledge-system/real-corpus-pilot-2026-09-30.md)
records the latest measured coverage and remaining format/relationship gaps.
