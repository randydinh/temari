# Proposed Registrar profile and compatibility contract

Status: **proposed runtime schema**. This is a review specification, not executable
application code or a claim that the current database accepts these records.
The implemented documentation ledger schema is described separately below.

## Canonical runtime envelope

Every runtime record should have `schemaVersion`, `kind`, `id`, `revision`,
`createdAt`, `origin`, `accessPolicyRef` and a kind-specific payload. IDs are opaque
and immutable. A revision appends a record; it never edits the bytes named by an
old digest. Resolve references in a generation before publishing its manifest.
Use a canonical JSON encoding for digests, documenting key ordering, UTF-8,
number restrictions and array ordering. Never hash a display label as sole identity.

| Type | Proposed representation and validation |
| --- | --- |
| Digest | `{algorithm: "sha256", hex: string}`; lowercase 64 hex characters; computed from original bytes for SourceRevision. |
| RecordRef | `{kind, id, revision}`; target kind and revision must exist in the selected manifest. |
| Range | `{unit: "byte" \| "unicode-codepoint", start, end}`; nonnegative integer, half-open `[start,end)`, bounded by named representation. |
| ModalityCoordinate | Tagged union: page/region, sheet/cell, symbol, media track/time; always supplementary to a specific revision and mapping. |
| Origin | `source-observed \| model-inferred \| human-adjudicated`; evidence of authorship/method retained, not implied by confidence. |
| SupportStatus | `unassessed \| supported \| contradicted \| insufficient \| disputed`; judgment/rubric and reviewer references where applicable. |
| Lifecycle | `proposed \| active \| superseded \| retracted`; separate freshness field can mark an active assertion stale. |
| Freshness | `{mode: "published-snapshot" \| "current-original", state: "unchanged" \| "changed" \| "unavailable" \| "unknown", observedAt, receiptRef}`. |
| ModelJudgment | `{resolvedModel, rubricHash, questionHash, evidenceHashes, answer, probabilities?, confidence?, calibrationRef?}`; absence is not zero. |

A SourceRevision has exactly one source, captured representation and byte hash; its
inventory may identify many assets. An Extraction has exactly one source revision
and extractor configuration. An Anchor names exactly one revision and extraction
mapping, even when a derived assertion cites many anchors. When a binary source has
no direct text range, use the extraction coordinate and retain its mapping/coverage
to original pages, cells or media regions. Never label normalized offsets as original
byte offsets. Current UTF-8 codepoint evidence remains valid without reinterpretation.

An Assertion has one subject, one predicate and one object (entity or typed literal),
zero or more support anchors and zero or more contradiction anchors. Zero supports is
permitted only for a clearly proposed/insufficient hypothesis, never an active supported
source fact. Every anchor also declares its role and applicability. At least one support
must resolve before source-backed promotion; some predicates require multiple independent
supports. Declare these requirements in the versioned predicate registry.

Entity IDs survive renames. Mention IDs identify local occurrences, so their source-scoped
record identities can change. IdentityLink records candidate alias/equivalence/rename
relationships and their adjudication; retracting one restores the previous interpretation.
No union-find merge may erase original entity IDs or historical source-bound mentions.

## Multi-source publication

A Generation manifest lists its immutable records, per-source inventory and validation
receipts. A RevisionSet selects source revisions/generations with explicit captures and
applicability constraints. These are different records: a serving selection may join
several independently published generations without claiming a distributed transaction.

Publication validates the entire manifest, writes immutable partitions, and atomically
changes a serving pointer using the previous pointer as a compare-and-swap precondition.
Readers pin a completed manifest, never a work-in-progress directory. Dependency indexes
map source revisions and access-policy epochs to derived assertions, views and caches.
Revocation must remove eligibility before the affected result can be served again.

## Illustrative multi-anchor assertion

All names below are synthetic symbols. Placeholder IDs describe relationships and are
not hashes, product records or executed verification receipts.

```json
{
  "schemaVersion": "registrar-proposal-1",
  "kind": "Assertion",
  "id": "assertion:coverage:R17:B",
  "revision": "proposal-1",
  "subject": {"kind": "Entity", "id": "requirement:R17"},
  "predicate": "tested-by",
  "object": {"kind": "Entity", "id": "test:reject-invalid-state"},
  "revisionSetRef": "revision-set:synthetic-A",
  "supports": [
    {"anchorRef": "anchor:req-v1:section-17", "role": "required-behavior"},
    {"anchorRef": "anchor:test-v1:assertion-2", "role": "asserted-outcome"}
  ],
  "contradictions": [
    {"anchorRef": "anchor:results-v1:run-7", "role": "execution-failure"}
  ],
  "origin": "model-inferred",
  "supportStatus": "disputed",
  "lifecycle": "proposed",
  "freshness": {"mode": "published-snapshot", "state": "unchanged"},
  "modelJudgmentRef": null,
  "accessPolicyRef": "policy:synthetic-admission"
}
```

This does not show that R-17 is covered. A proposed test relationship, a failed run and
missing configuration/build compatibility require an assessment. Full production
records would also require the envelope timestamps and versioned references described
above; the sketch intentionally omits invented evidence hashes or model receipts.

## Investigation progress and continuation

Do not rename the existing provider `coverage.consumed`. Its meaning is returned
candidate enumeration progress. Add the following investigation fields at a versioned
integration boundary and preserve old checkpoints through an explicit adapter:

| Field | Contents |
| --- | --- |
| `enumeratedDocuments` | Document identities returned by discovery, with query/route/page receipt. |
| `fetchedAnchors` | Exact accepted read records; a failed/partial read adds an omission. |
| `suppliedEvidence` | Evidence IDs actually placed in the bounded reader context. |
| `assessedEvidence` | Evidence ID + question/rubric + assessment attempt + disposition; no automatic promotion on fetch. |
| `pendingWork` | Required dependency reads, unreviewed candidates and stale/revalidation work. |
| `omissions` | Unsupported, refused, budget-limited, changed, unavailable, unknown or purged items with allowed disclosure. |
| `continuation` | Opaque operation cursor plus request/scope/grant/publication/provider identity and parent checkpoint. |

The sets are related but not universally a simple subset chain: explicit selected reads
can bypass discovery; retained evidence may have been supplied in an earlier pass. Track
per-pass and cumulative totals separately. Resume must keep those receipts rather than
recounting retained context as newly read. Revalidation checks are operations with budgets,
not semantic assessments. Unknown checks prevent a false currentness claim.

## OKF extension proposal

A portable bundle contains Markdown concepts with required OKF `type`, a namespaced
`registrar` extension and an immutable manifest. The extension carries `profileVersion`,
`recordRef`, `generationRef`, `revisionSetRef`, `anchorRefs`, `assertionRefs`, `origin`,
`supportStatus` and `accessPolicyClassification`. Paths are presentation locators while
record references preserve identity. Include lifecycle and omission receipts.

Import must reject unsupported profile versions or unresolved/different digests. It may
quarantine a plain OKF concept lacking Registrar provenance as an unverified import.
Imported lifecycle or verification labels remain the author's assertions. An export
cannot grant access; apply destination authorization and omit disallowed content and
metadata. Original bytes remain in the separate archive and require their own retention
and access decisions. Roundtrip checks compare full identity and provenance, not text
similarity or node counts.

## Implemented design-ledger schema

[evidence.json](evidence.json) is the canonical input to this documentation graph.
It is a source/decision ledger, not an instance of the proposed production schema.

- `sources`: unique `id`, durable `locator`, exact commit/hash or dated observation
  `revision`, honest `reading_status` and `intended_influence`.
- `points`: unique ID, label, topic, evidence type, source refs with locator/revision/span,
  conditions, confidence basis, limits, benefit, risk, implementation status and tags.
- `decisions`: unique ID, label, rationale, status and ordered supporting point IDs.
- `relationships`: unique assertion ID, source/target point or decision, typed predicate,
  `EXTRACTED`, `INFERRED` or `AMBIGUOUS` provenance tag in `confidence`, basis and source refs.
  Here `confidence` is a Graphify provenance class, not a model probability or calibration.
- `conflicts`: old and new source IDs plus explicit resolution or unresolved fork.

Source IDs are referenced metadata rather than extra graph nodes. Graph node identities
are exactly points + decisions + relationship assertions. Connector edges encode only
subject/assertion/object topology; the assertion node retains semantic predicate and
basis. `project.py` avoids full semantic extraction/dedup and verifies every exported
record field through `verify.py`. Unknown additional Graphify annotations may remain,
but no canonical field, entity or edge may change or disappear.
