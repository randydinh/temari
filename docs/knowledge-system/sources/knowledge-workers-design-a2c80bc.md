# Local knowledge workers

Status: implemented and locally verified for the explicit local profile. This
record extends the existing bounded knowledge investigation. It does not approve an autonomous
agent topology, a source-retention policy, or live access to a private corpus.

## Outcome

A maintainer can explicitly admit selected local documents through an intake
capability, hand a read-only provider to a retrieval worker, and resume bounded
evidence collection in another process. Evidence keeps exact source identity,
hashes, representation and spans. The existing workflow and task artifacts remain
the execution and persistence boundary.

The owner requested intake and search/retrieval workers on September 23, 2026,
building on the preserved persistent-memory discussion. The broader objective is
on-demand knowledge without putting the whole corpus in every conversation.
The owner has not selected who owns semantic sufficiency, domain verdicts,
long-term retention, shared access or background refresh.

## Responsibilities

| Capability        | Permitted work                                                                                                                                    | Excluded work                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Intake            | Validate an explicit local manifest, copy admitted bytes, invoke Registrar registration/indexing in isolated state and publish a verified receipt | Scan unrelated folders, modify originals, broaden access or submit content to a hosted model       |
| Published reader  | Enforce publication identity and provide discover, read and revalidate                                                                            | Register, refresh, relink, choose a newer publication or silently accept changed publication bytes |
| Retrieval worker  | Collect scoped candidates and explicitly selected passages within a budget, preserve continuations and revalidate supplied evidence               | Treat search hits as new read authority, infer domain approval or execute retrieved instructions   |
| Existing consumer | Assess evidence through its own authorized workflow and retain findings                                                                           | Treat mechanical collection as semantic PASS                                                       |

These are callable capabilities. They do not require two new autonomous processes
or change the shared worker-role catalog.

## Reuse and selected design

Reuse the current Registrar CLI, source registry and exact evidence reader. Keep
Registrar authoritative for indexing and source generations. Add a publication
boundary around explicit local intake, with a manifest-pinned read profile.

Each indexing attempt owns a separate final directory. Registrar records absolute
source paths, so a completed index must not be renamed from a staging path. A
verified receipt is published atomically without overwriting an existing winner.
Same-input replay returns the verified winner. A failed attempt cannot appear
ready. Different inputs require a new admission rather than an implicit refresh.

The published reader checks membership, hashes, generation and implementation
identity. Hashing only the receipt would leave a hole where changed source bytes
could be accepted as a new valid citation. Keep the existing reader's behavior
unchanged for legacy callers.

Two independent design candidates were compared. The selected design reuses the
existing reader state. A competing design sealed an index seed and cloned its
database for every reader. That design adds storage and identity rules and needs
unproven cursor-equivalence behavior. Defer it unless concurrent cache evidence
shows a real need. Neither design supplies hostile-process filesystem isolation.

## Retrieval and continuation

Generic retrieval accepts a source scope, an optional query and explicit document
selections. Search-only and single-document reads do not need plan/update roles
or an assessment callback. A discovered document remains a candidate until the
caller explicitly selects it.

Keep operation-specific cursors and persistence envelopes private. Preserve exact
evidence IDs and spans, pending reads, gaps, coverage observations and parent
checkpoint links. Published artifacts are immutable and content-addressed. A
fresh process loads an explicit checkpoint rather than choosing a mutable latest
record.

Every attempted provider call, including revalidation and failure, consumes the
current pass budget. Count response bytes and accepted codepoints and retain
whole evidence records within context limits. A new pass can grant a larger
budget without changing the task, authority, provider or selected request.
Retained-state limits do not reset on resume.

Reserve final revalidation capacity before collecting more evidence. Evidence
served as current requires an unchanged check in that invocation. If the budget
cannot check all required retained evidence, return an explicit gap describing the
needed larger pass or narrower request. Historical checks are still useful history
but are not current checks. Cross-source observations remain sequential, not an
atomic snapshot.

Persist accepted progress before another call. A crash may repeat an unrecorded
read-only call. This design does not promise exactly-once I/O or exact accounting
for an abandoned process. A failed save must not report durable completion.

## Compatibility

Preserve `KnowledgeProvider`, existing reader identity behavior, investigation
checkpoint names/schema, partial/final checkpoint ordering and plan-draft callers.
Do not change the workflow engine or create a scheduler. Return evidence-bearing
worker results through the existing handler/callback integration.

The first local profile supports explicitly selected UTF-8 text and Markdown.
Published-byte freshness is different from current-original freshness. Original
locations remain provenance, not permission to reopen or follow remote links.
Newly observed source bytes need a new explicit admission.

## Relationship to the broader memory design

The earlier discussion remains the roadmap, not a claim that all of it ships in
this increment:

- **Nx** already organizes this repository. The worker capabilities extend the
  existing knowledge library, contracts and workflow integration; they do not
  introduce another monorepo or scheduler.
- **Registrar** remains the source/index authority. This increment pins a local
  publication's registration generation and byte inventory. It does not yet
  consume the separate immutable concept-generation substrate from `3d59350`.
- **Graphify** supplies derived navigation and source-claim lineage. It is not
  substituted for source bytes or permission checks.
- **Graft** remains a candidate for structural code relationships. No Graft
  integration or whole-source-code parser is added here.
- **OKF** remains a representation/export boundary from the previous design;
  this increment does not add immutable-generation OKF export.
- **BM25, vector retrieval and fusion** remain ranking experiments. The current
  local Registrar path uses its existing lexical retrieval; this work does not
  relabel that as BM25 or claim semantic recall.
- **JEV** remains an optional judgment experiment, for example testing whether
  retrieved evidence is sufficient to support a proposed test-coverage finding.
  It is not the authoritative memory store. No hosted model receives documents
  in this implementation.

The preserved ambition is evidence-backed coverage analysis across code,
requirements, product/test/OCPP documents, Shortcut and Notion, followed by
authorized diagnosis and test generation. The current local profile deliberately
does not claim that end-to-end domain result. An authorized representative corpus,
expected-answer/evidence cases, source freshness policy and semantic decision
owner are needed to evaluate it honestly. Byte preservation and reliable
continuation alone do not establish a lossless semantic memory.

## Acceptance

| ID    | Required observable result                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KW-01 | Intake copies only admitted files, preserves exact hashes/origins and leaves originals unchanged. Invalid paths, symlinks, empty/invalid text and oversized inputs are rejected. |
| KW-02 | Replay, failure, concurrency and process interruption cannot expose a partial or corrupt publication as ready.                                                                   |
| KW-03 | The returned reader has no source-maintenance methods and refuses unadmitted or altered publication evidence.                                                                    |
| KW-04 | Search-only and selected reads work without a semantic assessor. Exact paginated spans survive Unicode and line-ending cases.                                                    |
| KW-05 | Fresh-process continuation preserves old artifacts and enforces per-pass and retained-state budgets.                                                                             |
| KW-06 | Changed, missing, unknown and corrupt evidence remains visible and prevents false current/completed results.                                                                     |
| KW-07 | The worker result composes with existing task/workflow handlers and retains inspectable evidence.                                                                                |
| KW-08 | A documented local example runs through actual Registrar with synthetic inputs and fails honestly when prerequisites are absent.                                                 |

Persistence, provider adaptation and shared contracts require focused integration
and compatibility regression. Test fixtures and typechecks alone do not prove the
actual Registrar path. Record executed checks separately from these requirements.

## Delivery sequence

1. Product intake and manifest-pinned read capability.
2. Generic retrieval and durable continuation.
3. Runnable workflow composition, regression and independent review.

The first three units are implemented. See the
[local run guide](knowledge-workers-local-guide.md) for inputs and commands, and
the [verification matrix](verification-matrix.md#local-knowledge-worker-extension)
for executed proof and remaining scope.

Each unit must pass its checks before the next builds on it. Later provider
ranking experiments, concept-generation retrieval, live connector grants,
retention/revocation, shared deployments and autonomous experience remain separate
increments. This design does not remove those objectives.

## Source lineage

- [Recovered retrieval design](https://github.com/randydinh/temari-v4.1/blob/0d0d7d8/docs/recovered-content-registrar-buildout.md).
- [Persistent-memory discussion and open decisions](https://github.com/randydinh/temari-v4.1/blob/0d0d7d8/docs/content-registrar-memory-discussion-2026-09-20.md).
- [Committed Registrar generation design](https://github.com/randydinh/content-registrar/blob/3d59350/docs/design/persistent-knowledge-generations.md).
- [Existing knowledge contract](../libs/knowledge/README.md) and
  [platform responsibilities](platform-components.md#2-knowledge-intake-and-retrieval),
  inspected at `1a788e0`.

Graph navigation and a bounded live Registrar search informed source discovery.
The search was partial and reported provider/source gaps. Current code and named
design records, not index completeness, support these choices. No private corpus,
hosted judgment or live external connector was exercised for this design.
