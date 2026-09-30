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
