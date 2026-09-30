# Scoped design graph report

Status: **documentation projection built and read back; runtime architecture proposed**.
Date: 2026-09-29. Temari base: `664144d17272697d68e045143f0ede0458ee6eca`.

## Corpus and provenance

Canonical input is [evidence.json](evidence.json): **28 source records,
31 points, 10 decisions and 46 relationship assertions**.
The corpus is bounded to the supplied research brief, selected historical design lineage,
pinned Temari contracts/adapter, selected Registrar source, unmerged candidate designs,
and official Nx, Graft, Graphify, OKF, TypeSafe and SkillOpt documentation/code.
This is not a broad repository graph, a private source inventory or an exhaustive literature
review. Reading status distinguishes direct inspection from brief-reported observations.
No existing Temari code graph was changed or treated as current runtime proof.

The actual projection contains **87 nodes and 92 directed edges**.
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
These are integrity checks; they do not establish that every claim is true or that a
proposed runtime meets the design. No Temari/Registrar runtime tests were run here.

- Evidence SHA-256: `d49e4e4e656893785d4012684b6228dd33e243a730d22de83d704f503a743230`.
- Graph SHA-256: `593aa44d1d04c759881ceba0f28f867271c020f55223db5274549b6c244d075e`.

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
`P-model-fork` cites the dated trusted request. This is source navigation, not a product
benchmark. Query output was not re-ingested as fact or used to boost truth confidence.

## High-connectivity decisions

Degree counts are structural navigation statistics, not truth or importance scores.

| Node | Total directed degree | Why it connects |
| --- | ---: | --- |
| `D-reconcile` | 5 | Reconcile pinned main and candidates before extending runtime |
| `D-projection` | 5 | Preserve exact identity through directed reified Graphify view |
| `D-evolution` | 5 | Trial SkillOpt as offline platform capability with stronger gate |
| `D-increments` | 5 | Require synthetic preservation journey before ranking promotion |
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
Both candidate branches and their combined integration remain unmerged/unverified here.
Historical tests and vendor examples do not fill those gaps. External unversioned web
pages are dated observations; pinned commits or local byte hashes are recorded where available.

Useful next queries: Which facts constrain snapshot optimization? Which records are
needed before v1 recovery and v2 invalidation can be proven? Which proposed gates prevent
a skill-text improvement from concealing a citation/access regression?
