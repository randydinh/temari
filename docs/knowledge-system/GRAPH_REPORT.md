# Scoped design graph report

Status: **documentation projection built and read back; runtime architecture proposed**.
Updated: 2026-09-30. Original Temari base: `664144d17272697d68e045143f0ede0458ee6eca`.

## Corpus and provenance

Canonical input is [evidence.json](evidence.json): **34 source records,
37 points, 11 decisions and 55 relationship assertions**.
The corpus is bounded to the supplied research brief, selected historical design lineage,
pinned Temari contracts/adapter, selected Registrar source, unmerged candidate designs,
and official Nx, Graft, Graphify, OKF, TypeSafe and SkillOpt documentation/code.
This is not a broad repository graph, a private source inventory or an exhaustive literature
review. Reading status distinguishes direct inspection from brief-reported observations.
`S-workers` now resolves to the [byte-identical archived snapshot](sources/knowledge-workers-design-a2c80bc.md),
not the unavailable GitHub commit. Its original local-only/unpushed ref and verified
SHA-256 are recorded in the [source provenance](README.md#archived-worker-source);
it remains a candidate source, not implementation delivered by this PR.
No existing Temari code graph was changed or treated as current runtime proof.

The actual projection contains **103 nodes and 110 directed edges**.
Every relationship becomes its own assertion node between subject and object. The two
relationships from `P-graphify` to `D-projection` survive with distinct assertion IDs.
Tags retain topic, evidence type, status and assertion provenance class. Here Graphify's
`confidence` values are EXTRACTED/INFERRED/AMBIGUOUS categories, not statistical confidence.
Source metadata lives in canonical records and node attributes, not extra source nodes.

The installed package reports **graphifyy 0.9.49**. Its actual `build.py` hash is recorded
in `S-local-graphify`; this differs from the candidate design's historical reported 0.9.63
roundtrip and the observed upstream commit. No dependency was installed or upgraded.
The builder used `graphify.build.build_from_json(..., directed=True)` and
`graphify.export.to_json`, followed by actual API readback. It bypassed the full build's
semantic extraction/dedup pipeline; unique ID-qualified labels and exact field checks
protect canonical identity from any builder normalization.

This was a **no-viz** build. The architecture diagram is in the main document.
No HTML, automatic graph refresh, hook, scheduler, hosted extraction or paid model call
was requested. Host-authored synthesis token usage is **not separately metered**; do not
interpret lack of tool API billing as zero extraction tokens. Graph projection and query
were local deterministic operations, without a hosted model request.
Clustering and cohesion analysis were not run: cohesion is **not measured**, not zero.

## Integrity evidence

[readback.json](readback.json) records successful exact ID and complete topology checks,
all canonical point/decision/assertion attributes, connector attributes, source locators,
revisions, tags, and the repeated-endpoint witness. It re-imports the serialized graph
through the installed builder and rechecks node attributes and directed edges.
The task's separate artifact verifier also checks expected schema/identity/topology.
The prior independent review returned **ISSUES** for A-044 provenance; that historical
receipt remains ISSUES. This correction marks A-044 INFERRED and adds pinned SkillOpt
backend/Sleep evidence alongside TypeSafe evidence. The cross-source rationale is that
Jev cannot generate prose while SkillOpt editing requires generation; model-role permission
remains conditional. Regenerated readback checks that provenance as well as topology.
These are integrity checks; they do not establish that every claim is true or that a
proposed runtime meets the design. No Temari/Registrar runtime tests were run here.

- Evidence SHA-256: `0ad914802db15b62ac5465486b2ff55afab7a2b03191c5f2257340067646e3ce`.
- Graph SHA-256: `7d94cde9e6a375d0990a9caedabf87167be1596a21122d4070c653bfa0e866c7`.

## Query executed

Question: **Why can Jev not replace SkillOpt editing, and what gates are required?**
Expansion from actual graph label vocabulary: `jev`, `skillopt`, `gate`.
From this directory, the installed CLI was run as:

```sh
python -m graphify query 'jev skillopt gate' --budget 1800
```

The CLI used BFS depth 2 and returned eight nodes, including `P-skill-tools`,
`P-model-fork`, `D-models` and `D-evolution`. Its printed source locations are bounded;
full source refs remain in the ledger. The deterministic verifier additionally traversed
from `P-jev`, `P-skill-gate` and `P-model-fork`, reaching `D-models`, `D-evolution` and
`P-skill-platform` through reified links. The exact visited IDs/edges are in readback.json.

Answer supported by those nodes: Jev supplies typed judgments and cannot generate skill
text. SkillOpt editing therefore needs a generative role whose permission remains open.
The default aggregate gate is insufficient for promotion; real tool replay, separate
held-out evaluation and review are required by the proposed Temari decision.
`P-jev` cites TypeSafe introduction/models; `P-skill-gate` cites pinned Sleep config/gate;
`P-model-fork` cites the dated trusted request. `A-044` joins the TypeSafe limitations
to pinned `S-skill-backend` and `S-skill-sleep` editing evidence as an inference. This is source navigation, not a product
benchmark. Query output was not re-ingested as fact or used to boost truth confidence.

## High-connectivity decisions

Degree counts are structural navigation statistics, not truth or importance scores.

| Node | Total directed degree | Why it connects |
| --- | ---: | --- |
| `D-reconcile` | 6 | Reconcile pinned main and candidates before extending runtime |
| `D-projection` | 5 | Preserve exact identity through directed reified Graphify view |
| `D-evolution` | 5 | Trial SkillOpt as offline platform capability with stronger gate |
| `D-increments` | 6 | Require synthetic preservation journey before ranking promotion |
| `P-generation-candidate` | 4 | Immutable generations already reify relationships in candidate |

## Useful cross-topic paths and open gaps

- `P-model-fork → A-035 → D-evolution` connects deployment model scope to whether
  generative skill optimization can proceed. Two-agent selection does not resolve it.
- `P-access → A-045 → P-lossless` makes erasure policy a limit on recoverability;
  a preserved historical checkpoint cannot bypass current access revocation.
- `P-pagination → A-042 → P-retrieval-flow` connects existing provider semantics to
  the proposed separate enumerated/fetched/supplied/assessed evidence ledger.

The whole graph is a reviewed-design input, not a semantically audited production corpus.
Open gaps include multi-source archive implementation, rename/alias lifecycle, real
connector grants and retention, source-currentness policy, actual language/modality
coverage, model-role approval, local Jev calibration and complete-task performance.
Recovery covers successfully captured retained versions only; upstream history gaps remain
explicit. Backup/restore of bytes, manifests, retained extraction outputs/provenance and
access/retention state, hash and derived-view checks, current revocation/erasure enforcement,
and selected/tested RPO/RTO remain proposed production gates, not executed infrastructure.
Both candidate branches and their combined integration remain unmerged/unverified here.
Historical tests and vendor examples do not fill those gaps. External unversioned web
pages are dated observations; pinned commits or local byte hashes are recorded where available.

Useful next queries: Which facts constrain snapshot optimization? Which records are
needed before v1 recovery and v2 invalidation can be proven? Which proposed gates prevent
a skill-text improvement from concealing a citation/access regression?

## BM25 clarification

The user explicitly selected BM25 ranking. The [preserved request](sources/bm25-selection-2026-09-29.md)
and official BM25 reference are recorded in the ledger. `P-retrieval-flow` and
its existing inferred link to `D-serving` now carry that selection and context.
This bounded documentation follow-up uses focused self-review and exact artifact
readback. The earlier independent review remains bound to the prior design commit.
In that BM25 clarification, node/edge identities and topology were unchanged;
the later guide reconciliation below adds source-backed points and links. No ranking implementation or benchmark is claimed.

## Supplied-guide reconciliation

The [user guide](sources/content-registrar-guide-received-2026-09-29.md) is archived
byte-for-byte with its original locator, SHA-256 and user-reported approximate age in
`S-user-guide`. Its 13 sections were read; implementation/test statements remain
historical unless separately checked. Several historical sources retell this same
lineage and do not count as independent corroboration.

New points retain the guide's BM25 granularity/diversity/receipt proposal, confirmed
checkpoint reuse behavior, bounded provider reports and the precedence of newer user
selections. Existing decision records and relationship assertions are unchanged; five
inferred links connect the four new points to existing selected roles and proposed work.
Static inspection of pinned `retrieval.py` confirms lexical overlap plus filename-stem
weighting rather than BM25. `S-investigation` separately records direct inspection of
save-before-assessment and unchanged input-key skipping at the pinned Temari baseline.
No provider execution or historical test rerun is claimed for this reconciliation.

Executed focused query: `graphify query 'granularity assessment' --budget 1800`.
Both terms appear in actual labels. BFS depth 2 returned six nodes with no truncation:
`P-bm25-receipt`, `P-investigation-checkpoints`, `A-049`, `A-050`, `D-serving` and
`D-reconcile`, with four connecting edges. These paths explain which existing plans the
new source details inform; they do not establish that ranking or checkpoint behavior has
been evaluated at runtime. Full provenance remains in the canonical ledger.

The initial broader navigation query requested 1,400 tokens and omitted two of thirteen
selected nodes; those results were not treated as complete coverage. Decisive source and
ledger passages were inspected directly, and the focused query above supplies the guide
navigation witness. Exact source-byte comparison and the regenerated verifier receipt
check archival and projection integrity. The documentation delta uses focused self-review;
prior independent reviews stay bound to their original candidates.

## Corpus validation scope

The [preserved user request](sources/validation-coverage-2026-09-29.md) selects Nx and
non-Nx codebases plus varied documentation and suggests images. `P-validation-corpus`
records that scope; `A-052` and `A-053` connect it to the existing routing and increment
plans as engineering inferences. The concrete format/fixture matrix is proposed and
all application cases are not run. Existing decision records are unchanged.

Image preservation, extracted text, OCR, visual meaning and answer support have separate
outcomes. Correctly reporting unsupported visual processing is not visual-answer coverage.
The initial graph query `synthetic tasks` returned all ten selected nodes/eight edges;
its approximately 1,669 tokens exceeded the requested 1,400-token budget. This was bounded
navigation, not exhaustive source coverage. The regenerated exact projection/readback
checks documentation integrity only; no corpus or runtime evaluation is claimed.

The focused query `graphify query 'formats' --budget 1600` returned five nodes and
four edges with no truncation: the new corpus point, A-052/A-053 and D-routing/D-increments.
Exact attributes/topology and preserved decisions were checked again. This clarification
uses focused self-review; prior independent review remains bound to its original commit.

## Delivery-order update

The [owner's 2026-09-30 decision](sources/plugin-order-2026-09-30.md) selects a
working, measured knowledge journey before installable plugin packaging.
`P-plugin-order` supports `D-plugin-order` through extracted assertion `A-054`;
`A-055` links the decision to the prior increment plan as an inference. The
projection and [readback](readback.json) include these exact records. The graph
records delivery intent, not a completed plugin or a production-ready knowledge
system.
