# Graph retrieval diagnostic gate, 2026-10-01

## Decision

Graph ranking remains opt-in. The new sealed gate reports a diagnostic result
and always sets `promotionEligible: false`. Its graph arm currently verifies
the BM25 shortlist before reading linked targets, so it does more physical
work than the BM25 arm. Equal final top-K and excerpt limits alone cannot
establish equal retrieval cost.

## Local pilot

An operator ran the gate against the pinned Markdown link graph and retained
Registrar handoff from the earlier 70-file pilot. The two cases were selected
after inspecting the graph and are diagnostic examples, not a held-out cohort.
At top three, one case improved from zero to one gold hit with no unverified
excerpt; the other remained zero to zero. The gate returned
`insufficient-sample` and `promotionEligible: false`. No TypeSafe call was made.
The private plan, source IDs, paths, graph artifacts and reports remain outside
Git.

## Verification and limits

Temari knowledge typecheck and all 37 Registrar-backed integration tests
passed on the final candidate. The private diagnostic gate completed with no
unverified cases.

The Registrar-backed integration fixture exercises a graph gain and a
misleading edge that displaces a BM25 gold document. The gate checks exact
question and handoff hashes, source scope, text coverage, complete BM25
discovery, content-addressed shortlist and graph checkpoints, selected excerpt
budgets, and graph read-attempt accounting. It rejects case-level gold loss,
including a swap between two relevant documents at equal total hit count.

Before a ranking change, run a fresh, independent development and holdout
question set with at least five cases each, non-improving graph expansion
controls, complete text coverage and no case regression. Then make BM25 and
graph arms execute independently under the same physical read/projection
budget. The current receipt is not a full-answer or semantic relationship
quality assessment.
