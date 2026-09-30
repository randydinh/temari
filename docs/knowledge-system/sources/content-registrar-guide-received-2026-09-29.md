# Content Registrar

## 1. Purpose and design status

Content Registrar is intended to be a **persistent, source-grounded knowledge layer that agents can query on demand**, without loading an entire organization’s information into every conversation.

Your motivating example is Temari working across OpConnect’s source code, product documentation, test documentation, OCPP specifications, Shortcut, and Notion to investigate coverage gaps, understand causes, propose changes, and produce automation.

The important distinction is:

> Keep the knowledge available outside the conversation; bring the necessary evidence into the conversation progressively.
> 

This is the consolidated design so far—not a frozen specification. Some foundations are implemented, other capabilities remain proposals, and you explicitly left the intended experience, agent organization, and responsibility allocation open. 

## 2. Components and their different jobs

Graft, Graphify, OKF, and Nx are complementary—not competing names for the same component.

| Component | Intended role | Important boundary |
| --- | --- | --- |
| **Content Registrar** | Register sources, establish identity, hash and extract content, retrieve evidence, preserve provenance and report freshness | Authoritative for its source identities and evidence records—not for the truth of every source statement |
| **OKF** | Portable Markdown-based knowledge records with metadata and relationships | A representation format, not a search engine or server |
| **Graphify** | Navigate relationships among documents, concepts, and assertions | A derived, rebuildable view; it must not replace Registrar identity or provenance |
| **Graft** | Structural code navigation and code-impact analysis | A separate code-provider candidate; its output still needs source/version grounding |
| **BM25, semantic providers, optional rerankers** | Find and order potentially relevant evidence | Ranking does not establish completeness or correctness |
| **Temari / another consuming agent** | Use evidence within an authorized task | Final responsibility allocation for planning, synthesis, and domain judgments remains open |
| **Nx** | Organize and build the Temari successor’s packages and integrations | Its project graph is a software dependency graph, not the organizational knowledge graph |

The standalone Registrar does not require an Nx monorepo or Temari to operate. Historical CodeGraph/GitNexus proposals were superseded by the Graft direction, but that does not mean Graft has been integrated. 

## 3. The two-agent idea

We discussed two responsibility groups:

| Intake and maintenance | Retrieval and evidence consumption |
| --- | --- |
| Onboard and register sources | Discover relevant documents |
| Configure authorized access | Search using appropriate retrieval methods |
| Hash, extract, normalize, and index | Read exact passages |
| Refresh and detect changes | Expand required context |
| Invalidate stale derived material | Return citations, limitations, conflicts, and gaps |
| Configure providers and publish generations | Support evidence and claim checks |

That separation remains useful, particularly for permissions: a retrieval consumer should not automatically acquire registration, refresh, or configuration powers.

However, **we have not settled on exactly two autonomous agents**. These could become agents, services, tool profiles, or capabilities within one application. Nor have we settled who decides when evidence is sufficient or when maintenance should run.

## 4. Source onboarding, storage, and ingestion

### Deployment model

The original implementation direction is:

- An independently maintained Python product.
- One local workspace per installation.
- A persistent SQLite registry.
- Local extraction caches, indexes, and knowledge artifacts.
- CLI operations and a local stdio MCP interface.
- Original source folders left unchanged.
- Private source material, credentials, and generated state excluded from the shared repository.

Local storage does **not** guarantee offline processing: an agent using a hosted model may send retrieved excerpts to that model. Any additional model-backed enrichment needs an explicitly authorized data boundary.

### Source registration

Each source has a stable identity and records information such as:

- Location or service selection.
- Access method and enabled state.
- Inclusion/exclusion rules.
- Availability.
- Last scan or fetch status.
- Current generation and provider receipt.

Local files are identified by **source ID plus relative path**, not their filename alone.

Important behavior includes:

- Registering one folder does not admit its entire parent directory.
- Identical content may share cached extraction while retaining separate origins.
- An unavailable drive is not evidence that its files were deleted.
- Relinking a moved source requires revalidation.
- Disabling a source does not delete its originals.
- Modification time and file size alone do not prove unchanged content.

### Ingestion sequence

The core sequence is:

1. Admit the explicitly selected source.
2. Enumerate material within its scope.
3. Hash original bytes.
4. Extract supported content.
5. Preserve structure and produce searchable representations.
6. Record extraction failures and unsupported content.
7. Publish updated registry/index state.
8. Retain completion, freshness, and gap information.

The design distinguishes useful content from incidental files. An unfamiliar extension is not sufficient reason to discard something, but neither should every cache or build artifact become knowledge.

The implementation includes text/code, HTML, PDF, and supported Office/ODF extraction. It does not establish comprehensive OCR, media transcription, arbitrary attachment extraction, or complete preservation of visual document meaning.

### Remote sources

The committed connector work includes selected Shortcut stories, Notion pages, and Testmo sources, with connector-specific boundaries.

Remote material is represented as fetched evidence with service identities, URLs, hashes, fetch information, and omissions. A valid local snapshot does not prove that the upstream service is current.

For example, the Shortcut/Notion design uses explicitly selected objects and GET-only refresh operations. It does not imply unrestricted workspace crawling, complete attachment ingestion, or that the credential itself lacks write privileges. Live Notion verification and stronger identity/isolation proof remain recorded gaps.

## 5. Evidence and knowledge records

The design needs several distinct record types; collapsing them into generic “memory” would lose important distinctions.

| Record | Information it preserves |
| --- | --- |
| **Source** | Identity, location, access scope, availability, scan/fetch state |
| **Document revision** | Source ID, path/object ID, content hash, extraction identity, generation |
| **Evidence item** | Exact passage or resolvable pointer, span, source identity, representation |
| **Concept or relationship** | Scoped identity, content/type, source anchor, extraction revision, provenance class |
| **Retrieval result/page** | Query, scope, provider identity, results, continuation, gaps, coverage observations |
| **Finding** | Proposition, supporting and contrary evidence, interpretation basis, decision standing |
| **Investigation checkpoint** | Task scope, evidence inspected, findings, remaining questions, rejected alternatives, completed work, next step |

These are not all one finalized wire schema. Registrar has its implemented storage structures; the Nx consumer has a smaller provider-neutral contract.

Two distinctions are fundamental:

- **Source evidence versus interpretation:** a model-generated relationship is not automatically a source fact.
- **Interpretation versus accepted decision:** an assistant recommendation is not automatically an owner-approved architecture choice.

For PDFs and normalized HTML, spans refer to extracted text with the original file hash and extraction identity—not necessarily original file line numbers or page coordinates.

## 6. Retrieval architecture

The recovered design uses complementary retrieval methods.

### Exact/lexical baseline

For identifiers and literal terminology:

- Ticket IDs.
- Protocol operations.
- Symbols.
- Error messages.
- Configuration names.

The inspected baseline is lexical term overlap with filename weighting. **It is not BM25.**

### BM25 sparse retrieval — proposed

BM25 would be introduced as an experimental challenger, preserving the existing route.

The proposed comparison includes:

- Document-level ranking.
- Section-level ranking.
- Fielded ranking across path, title, headings, and body.

Document diversity matters: one long document should not consume every result slot merely because many of its chunks match.

Its index receipt should identify the tokenizer, normalization revision, scoring variant and parameters, field weights, implementation version, and source generation. Parameters would be tuned separately from held-out evaluation.

### Semantic retrieval — bounded implementation exists

The preserved optional provider uses local TF-IDF, SVD, and cosine similarity.

It is a limited discovery mechanism—not a modern embedding service or proof of general semantic understanding. Embeddings remain a possible future provider.

### Relationship retrieval — bounded implementation exists

The existing relationship route traverses caller-declared dependencies using Graphify.

That is narrower than automatically extracting and understanding all relationships in the corpus. In particular, the newly persisted concept generations are **not yet consumed by retrieval**.

### Hybrid retrieval and reranking — proposed

The proposed progression is:

1. Evaluate retrieval methods independently.
2. Preserve which method found each candidate.
3. Evaluate combining their candidates.
4. Evaluate query-aware reranking.
5. Promote a combination only when complete-task results justify it.

A reranker cannot recover evidence that candidate discovery never found. An automatic router should not conceal provider failures, omissions, or conflicting evidence.

## 7. Progressive context instead of prompt accumulation

The implemented retrieval interface separates:

**Discover → outline → read → expand → check claims**

- **Discover:** identify matching documents and retain pagination.
- **Outline:** inspect structure before reading everything.
- **Read:** obtain exact, bounded source passages.
- **Expand:** include declared dependencies and required sections.
- **Check claims:** verify supported mechanical properties of citations and required context.

Suppose A requires B, and B requires C. Reading A and B must not silently satisfy the requirement if C is missing, stale, or outside the allowed scope.

The required-context repair handles transitive dependencies and consumed evidence. However, declared dependency traversal is not automatic discovery of every unstated semantic prerequisite.

Results should expose:

- What matched.
- What was returned.
- What was actually consumed.
- What remains unread.
- Missing or unavailable sources.
- Budget omissions.
- Conflicts and applicability limitations.

**Exhausting a result set does not establish exhaustive semantic recall.** Likewise, checking quotation bytes does not establish that a broader conclusion is true.

## 8. Persistent concept generations and Graphify

This is the most recent committed Registrar foundation, on the handed-off branch at `3d59350`.

### Immutable publication

A `KnowledgeBatch` contains:

- One source ID.
- One source generation.
- An extractor revision.
- Concept drafts.
- Relationship drafts.

Every concept and relationship has a source anchor containing a path, SHA-256 hash, character span, and line span.

Publication validates those anchors against current indexed evidence, performs fresh source verification, normalizes the records, and stores an immutable generation. Repeating the same publication is idempotent.

A historical generation can be read and integrity-checked without asserting that it is still applicable to current sources.

### Identity preservation

Two unrelated concepts called `Heartbeat` must remain separate.

Concept identity is scoped by source, path, and local key; record kinds are distinguished. Display names are not identity.

For Graphify, each relationship becomes an assertion node:

`subject concept → relationship assertion → object concept`

This preserves multiple distinct assertions between the same concepts when ordinary graph edges might otherwise collapse.

After building the projection, Registrar checks individual identities, paths, hashes, spans, provenance, extractor/generation information, and actual connector endpoints—not just aggregate node counts.

### Current limits

- One source generation per batch.
- One contiguous source anchor per record.
- Up to 500 concepts and 1,000 relationships.
- 64 KiB per concept body.
- 8 MiB per generation.
- No integration of these generations into retrieval yet.
- No completed generation-to-OKF export.
- No completed cross-source lifecycle or current-generation selection policy.

The retained verification reports seven focused tests, 197 total tests, and a real Graphify round trip. Those tests establish bounded persistence and projection behavior—not extraction quality or final-answer quality. I did not rerun them for this explanation.

## 9. Persistent investigations and the Nx connection

A separate bounded Nx integration now provides a small provider-neutral interface:

- `discover`
- `read`
- `revalidate`

It adapts Registrar without importing its Python storage model into the consumer’s domain types.

The investigation consumer uses existing task/workflow machinery and saves content-addressed checkpoints containing the trusted task brief, supplied evidence, findings, unresolved questions, rejected alternatives, completed assessments, and next safe step.

Its relevant behavior includes:

- Save before assessment so retrieved work survives an assessment failure.
- Preserve old checkpoints instead of overwriting history.
- Revalidate evidence when resuming.
- Avoid repeating an unchanged completed assessment.
- Mark findings stale when evidence changes.
- Keep missing or uncertain dependencies blocked.
- Require semantic review rather than manufacturing a semantic “PASS.”

This is bounded local library/demo functionality, not proof of automatic activation throughout installed Temari.

It also does not guarantee exactly-once external actions, archived historical recovery, or an atomic multi-source snapshot.

## 10. What “lossless memory” would require

The proposed interpretation was:

> Preserve admitted original material and its relevant versions so compact summaries and indexes remain expandable back to exact evidence.
> 

That is different from promising perfect retrieval or reasoning.

The broader design therefore needs two complementary forms of persistence:

1. **Source persistence:** originals, revisions, structure, attachments, and provenance under an explicit retention policy.
2. **Investigation persistence:** what was examined, concluded, rejected, left unresolved, and already done.

The current immutable concept store does not, by itself, provide the first guarantee.

Still unresolved are:

- Which source versions must remain recoverable.
- Treatment of deleted upstream content.
- Revoked access and previously cached material.
- Attachments and unsupported representations.
- Backup, recovery, and retention periods.
- Personal versus shared knowledge.
- Derived summaries and cached answers after source removal.

Freshness also needs multiple dimensions: code commit, deployed build, documentation revision, protocol version, configuration, connector synchronization, and test execution identity.

A recently fetched document is not necessarily applicable to the deployed build. Sequentially checking several sources does not make them an atomic, coherent snapshot.

## 11. Where Jev fits

Jev is a candidate **judgment component**, not the memory store.

The first proposed use is ranking retrieved evidence for a particular question. Other possible experiments include passage classification, contradiction triage, and scoring proposed requirement-to-test links.

TypeSafe describes structured probabilistic decisions and provides a retrieval-reranking example. That supports evaluating it at this boundary; it does not establish improved performance on OpConnect material. [Jev introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [reranking example](https://docs.typesafe.ai/cookbooks/rerank_typesafe).

The surrounding system should retain responsibility for deterministic checks such as hashes, source scope, revisions, and publication. Jev would not establish freshness, authorize access, prove complete coverage, or generate the final automation.

Adoption, provider data access, and measured quality/latency requirements remain open.

## 12. How this could support your coverage-analysis example

The proposed evidence chain is:

**Requirement → applicable behavior → implementation → test assertion → execution result**

Each link should retain its evidence and whether it was extracted, inferred, or independently checked.

That would let an investigation distinguish:

- A requirement with no identified test.
- A matching test name without a relevant assertion.
- An assertion covering only some conditions.
- A test that exists but was not executed.
- Passing evidence from the wrong version or environment.
- Contradictory requirements.
- Insufficient evidence to decide.

Root-cause analysis would require further investigation or reproduction. Generating a regression test would not count as verified automation until its actual assertions and execution were checked.

This is a capability scenario—not an approved allocation of work to named agents. “No coverage found” must remain distinct from “coverage does not exist.”

## 13. Evaluation and remaining decisions

The design calls for complete-task evaluation, not just ranking scores.

Measurements include:

- Relevant evidence found and missed.
- Required-context completeness.
- Citation precision and claim support.
- Final task correctness.
- False coverage-gap reports.
- Appropriate abstention.
- Tool calls, evidence volume, tokens, latency, and cost.
- Behavior after edits, deletion, conflicts, failed updates, and recovery.

A bounded Nx scenario has already exercised comparing a design update with a plan and preserving the investigation. It does not prove the OpConnect coverage workflow or a context-efficiency improvement. The proposed OCPP benchmark remains a separate, unselected domain experiment. 

The principal decisions still open are:

1. The knowledge worker’s intended experience.
2. Agent/service/tool-profile organization.
3. Ownership of search planning, evidence sufficiency, refresh, and domain verdicts.
4. The admitted meaning of “all” and the retention meaning of “lossless.”
5. Freshness and response-time targets.
6. Shared access, revocation, and deletion policies.
7. Provider adoption: BM25, embeddings, Graft, Jev, and fusion.
8. How the broader capability connects to everyday Temari tasks.

**The central design is durable, verifiable evidence plus expandable context and resumable investigations—not one enormous prompt or a summary-only memory.** The foundations exist, but comprehensive lossless organizational memory remains the larger objective, not a delivered guarantee.