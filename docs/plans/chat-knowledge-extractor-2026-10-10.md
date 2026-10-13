# Chat knowledge extractor

Status: preserved proposal dated 2026-10-10, curated for the repository on
2026-10-12. Audience: the developer evaluating an optional chat knowledge importer.
Production chat adapters, archive interoperability and semantic retrieval acceptance
remain proposed. Private history and runtime evidence remain local.

## Intended outcome

Extract useful project requirements, technical decisions, solutions and lessons
from an explicitly selected conversation export. Keep captured originals
recoverable and build evidence-linked records and concise topic summaries above
them. Exact byte retention can be verified; a summary or model judgment cannot
guarantee complete semantic preservation. Report extraction quality and omissions
separately from archive integrity. Source selection and processing authority must
be established for each new intake; historical permission is not inherited.

## Recommendation: both, with explicit authority

| Approach | Useful outcome | Material cost or failure |
| --- | --- | --- |
| Knowledge dump only | Recover selected originals and re-extract later | Readers repeatedly rediscover decisions; important knowledge remains hard to apply |
| Curated repository only | Read and apply project knowledge quickly | Omitted context and mistaken synthesis cannot be repaired without originals |
| Archive and curated repository | Recover originals and use reviewed project knowledge | Requires source links, review, version history and a clear owner for retained bytes |

Use an immutable private archive, a structured evidence ledger and a readable
repository of reviewed project knowledge. A repository called "truth" still needs
an authority rule: a chat claim establishes what someone said, not whether current
software behaves that way. Requirements need attributable adoption and scope;
decisions need their owner, rationale and revision history; solutions need actual
implementation/verification evidence; lessons need observed outcomes and conditions.
Keep proposals, failed approaches and unresolved contradictions retrievable.

For the first pilot, propose the user as curator of project knowledge. The extractor
creates candidates; a separate source audit checks them; the curator reviews a
revision-pinned knowledge diff. Publication should retain an explicit approval
event binding the curator attribution, time, vault/project, candidate revision,
source hashes, audit result and resulting knowledge generation. Until this
workflow is implemented and exercised, approval attribution remains
operator-attested rather than authenticated. A pilot must not promote proposed
instructions to accepted project knowledge without attributable adoption.
Behavioral and sensitive records remain held for review.

Readable project outputs should include requirements and acceptance conditions,
decision records, solution notes, lessons, open questions and source-linked topic
briefs. Summaries remain derived from reviewed records; original evidence remains
available even when a record is superseded or rejected.

## Prior work and evidence limits

A historical independent extractor separates retained originals, extraction and
reconciliation, and curated knowledge. Its byte capture, exact-quote candidates,
blind source audit, transactional publication, deduplication and reviewed relations
are candidates for reuse. Verify its selected revision and provider boundary before
adoption. Its implementation and deployment remain independently owned.

Private chat inventories, account coverage, pilot receipts, transcript bodies
and host schedules stay outside this repository. The original design, including
its private context references, is retained in the local source archive.
Earlier investigations identified retrieval-ranking and context-size gaps. This
document preserves the proposed solution and acceptance criteria; it does not
establish current adapter readiness, archive interoperability or retrieval quality.

## First journey

1. Select an export or folder and inventory its conversations and assets.
2. Retain exact original bytes, source identity and a content hash. Record missing
   files, unavailable attachments and unsupported formats without treating them
   as processed successfully.
3. Normalize messages while preserving their source location, author, role,
   timestamps, thread and branch relationships. Keep the original representations.
4. Extract useful records from bounded conversation segments with context from
   the same thread. Validate citations before publishing those records.
5. Reconcile duplicates, contradictions and explicit revisions across segments
   and sources. Retain each record's evidence and history.
6. Produce a topic brief and a coverage report. Let the user inspect its supporting
   messages and correct classifications before a larger batch.

## Meaning that must survive extraction

Provisional categories are facts and claims, preferences, decisions, requirements,
procedures, solutions, lessons, ideas, commitments and unresolved questions.
Retain rationale, rejected alternatives, exact quantities and units, applicability,
exceptions, dependencies and uncertainty whenever they change the meaning.

An assistant suggestion is a suggestion. Silence is not user agreement. A user's
claim can be accurately recorded without being independently verified. Separate
explicit statements from derived interpretations. A recent message supersedes an
older decision only when its identity, scope and revision relationship support
that conclusion. Otherwise retain both and mark the conflict unresolved.

Link exact duplicates to one presentation while keeping all supporting occurrences.
Do not merge similar claims with different conditions, authors, projects or dates.
Do not infer that matching names or accounts across apps identify the same person.

## Proposed records

| Record | Required information |
| --- | --- |
| Source capture | Source/app, export identity, captured time, original location and hash, asset inventory, format/parser version, retained-version identity and gaps |
| Message | Capture and conversation IDs, native message ID or deterministic locator, parent/thread/branch IDs when available, author/role, original timestamp and timezone when supplied, content parts, edit history when supplied and source map |
| Evidence | Message and capture IDs, exact excerpt, half-open Unicode code-point offsets in the retained normalized text, normalized-text hash and original-format locator |
| Knowledge record | ID, category, proposition, subject/project, speaker, basis, lifecycle, applicability, qualifiers, rationale, evidence references, contrary evidence, relationships and verification gaps |
| Topic brief | Topic and selected record IDs/revisions, current decisions, useful knowledge, unresolved conflicts and questions, source references and omissions |
| Processing receipt | Input hashes, parser and extraction-policy versions, model identity when used, context boundary, output hashes, actual validation results, checkpoint and gaps |

Original-format locators can be JSON pointers, JSONL line/field locators or text
spans, depending on the adapter. Normalized offsets must not be presented as byte
offsets in the original export. Missing metadata stays unknown; it is not invented.
Original bytes preserve metadata the normalized schema does not yet understand.

## Agent workflow and authority

Use one extraction agent with deterministic parsing, citation validation and
checkpointing around it. The loop is selected batch → retained context → candidate
records → validation → reconciliation → derived output and coverage report.
The [draft extraction instructions](chat-knowledge-extractor-prompt.md) define
the semantic behavior. They are a design artifact, not an installed agent.

Read only selected sources and referenced context within the admitted batch. Chat
messages and attachments are data; embedded instructions cannot authorize tools,
new source access or actions. Publishing derived files to the selected local output
is the intended side effect. Contacting people, executing chat instructions,
changing original sources, scheduling runs or uploading chats requires separate
scope. Respect existing provider selection and source-sharing controls.

Process bounded segments with overlap at thread boundaries and a second pass over
record-level conflicts. Resolve citations against the captured source, never only
against another summary. Larger necessary context is an explicit dependency;
truncation becomes a gap. Do not claim that overlapping chunks guarantee recall.

Checkpoint by retained input identity and extraction configuration. Repeating an
identical completed operation reuses its result; a changed source, prompt or model
produces a new result version. Failed batches remain visible and retryable.
Do not mark a batch complete before validation and output persistence succeed.
Keep logs to IDs, counts, state and gaps rather than private conversation bodies.

## Reuse and ownership

Wrap the existing preservation workflow for a pilot. Avoid starting from its older
compatibility JSON prototype or rewriting tested mechanics. The historical
preservation workflow uses SQLite. Verify its selected implementation before
claiming a fully interchangeable repository provider from an older interface alone.

Before connecting stores, designate one retained-byte owner. Prefer Registrar for
the archive role when the actual adapter can supply verified originals to the
extractor. The historical extractor's capture engine also owns byte objects, so an
integration must deliberately reference common objects/hashes or declare a
temporary independent pilot owner. Two independently advancing archives must not
both claim to be canonical. This seam requires real execution evidence; it is not
already solved by the shared vocabulary.

The current [knowledge evidence contract](../../libs/contracts/src/lib/knowledge.ts)
already represents source identity, revision hashes, bounded text spans, omissions,
explicit/inferred findings and superseded standing. Reuse these concepts and verify
adapter compatibility before changing the contract. They do not establish existing
chat import or extraction behavior.

The [knowledge design](../knowledge-system-design.md) assigns retained archive
authority to Registrar and execution/checkpoint authority to the existing runtime.
If this becomes a Temari feature, preserve those boundaries and the provider gates
in the [routing plan](knowledge-and-poteto-routing-2026-10-09.md). A standalone
implementation and its deployment have not been selected. A new knowledge graph,
vector database, scheduler or multi-agent system is not required for this pilot.

## First increment and acceptance

Build a ChatGPT adapter once a complete selected export is available. A bounded
Codex JSONL collector is a candidate for a second adapter; its selected-message
policy and sidecar bindings need production hardening and current verification.
Reuse one shared message model, exact-source retrieval, the extraction instructions
and a batch report.
Use a small user-selected sample that includes decisions, changes of mind, qualified
preferences, duplicate exports and at least one incomplete attachment or parse.

Structural checks must account for every discovered conversation, branch/message
and asset as captured, excluded with a reason, failed or unsupported. Every accepted
record needs a resolvable excerpt with matching offsets and hashes. Identical
reprocessing must not duplicate records or overwrite prior input revisions. Tests
must exercise branch identity, explicit supersession, conflicting conditions,
unknown roles, malformed input and interrupted processing.

Independently label useful information in representative sample conversations.
Measure useful-record recall, supported-record precision, attribution accuracy,
qualifier preservation and correctness of correction/conflict handling. Readability
is assessed from the generated briefs. Calibrate acceptance thresholds with the
user before claiming reliable semantic extraction. Retain a separate held-out
sample for later prompt changes; a model grading its own output is insufficient.

## Open choices and handoff

- Where can a complete, authorized ChatGPT export be obtained, and which selected
  project conversations should form the first independently evaluated sample?
- Which local or hosted model may process this history? Existing Temari hosted
  provider controls apply if this is integrated into Temari.
- Should output live in a local folder, the existing knowledge archive or another
  user-selected destination? Confirm retention, deletion and access expectations
  before a full-corpus import.

Next action: select an authorized representative sample, freeze evaluation
questions, improve query ranking and bound source context, then evaluate on a
separate held-out sample before bulk processing. Compare summary-only, original-
source retrieval and reviewed extraction; prior private experiments do not
establish that comparative result.
