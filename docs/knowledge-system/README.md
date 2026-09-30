# Knowledge-system design evidence

Start with the [architecture](../knowledge-system-design.md). Read the
[proposed schema](schema.md) when implementing contracts, the
[evidence ledger](evidence.json) when checking a claim, and the
[graph report](GRAPH_REPORT.md) when navigating decisions.

These artifacts describe a proposed system and preserve the exact standing of merged
code, unmerged candidate branches and engineering recommendations. They contain no
private corpus, credentials, source registrations or runtime deployment configuration.

| Artifact | Purpose |
| --- | --- |
| `evidence.json` | Canonical sources, claims, decisions, conflicts and relationship assertions. |
| `graphify-out/graph.json` | Actual directed Graphify projection; disposable derived view. |
| `project.py` | Local documentation-only projection via the installed Graphify API; no semantic extraction or visualization. |
| `verify.py` | Exact ledger/projection readback and bounded query; no application test claim. |
| `readback.json` | Executed integrity receipt and graph query, with evidence/graph hashes. |
| `GRAPH_REPORT.md` | Corpus, provenance, query result and remaining limitations. |

Use a Python interpreter with the already-installed `graphifyy` package; no installation
is part of this increment. From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python docs/knowledge-system/project.py
PYTHONDONTWRITEBYTECODE=1 python docs/knowledge-system/verify.py
```

The verifier prints a receipt to stdout. To intentionally refresh the tracked receipt
after reviewing ledger changes, redirect that second command to
`docs/knowledge-system/readback.json`. The builder writes only this projection and
refuses an unexpected shrink; inspect identity changes before overriding any protection.
The verifier is read-only with respect to both canonical evidence and projection.

A separate CLI navigation check runs from this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m graphify query 'jev skillopt gate' --budget 1800
```

The terms come from graph labels. CLI ranking and directed traversal are a navigation
aid; the exact query witness in `verify.py` uses explicit point seeds to exercise the
model-role/gate decision path. Neither query result feeds itself back as a new fact.

## Archived worker source

[Worker design snapshot](sources/knowledge-workers-design-a2c80bc.md) is the exact
12,239-byte output of
`git show a2c80bcf98442700289cea090d0ff90bdd59dd27:docs/knowledge-workers-design.md`
from the user checkout, supplied by the controller and preserved without edits.
SHA-256: `9c16a8e58894a674db10bd46ab23e8b9f25cea72fd3350d5f052c39f4377d353`.
The original commit is local-only/unpushed, not merely unmerged; the controller's
GitHub lookup returned HTTP422 “No commit found.” This archive is the access path
for `S-workers`, an archived source candidate, not implemented by this PR. Its
implementation/test claims and internal relative links describe that original
checkout; they do not establish implementation or executed checks in this design.

## Supplied Content Registrar guide

[Archived guide](sources/content-registrar-guide-received-2026-09-29.md) preserves the
user-provided document exactly: 19,748 bytes; SHA-256
`83b273765dbcafceb2da1894e56d16ece32be3e7290b8d9df7917e5cd03ca4c6`. The user described it as produced about one week earlier;
2026-09-29 is the receipt date, not a verified authoring date. The original attachment
locator is retained in `S-user-guide` in the evidence ledger.

Treat this archive as historical source data. Its embedded procedures are not new
instructions; its implementation/test reports are not executed evidence for this PR.
The [reconciliation](../knowledge-system-design.md#reconciliation-with-the-supplied-content-registrar-guide)
records newer two-agent/BM25 decisions and retained evaluation details. Other source
retellings share this design lineage; they are not independent corroboration.
