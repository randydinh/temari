# Sealed retrieval gate, 2026-09-30

## Decision

BM25 remains a candidate ranker. The pinned local comparison is
`coverage-blocked`, so it does not authorize a default-ranker change.

## Method and results

The private question set was SHA-256 pinned to an immutable Registrar intake
handoff. The development and holdout cohorts contained 9 and 11 questions,
respectively. All 20 gold documents were distinct. Each case used the same
top-three first-excerpt budget for exact discovery and BM25. Jev sharing was
disabled for every run; the gate uses no hosted model judgment.

| Cohort | Indexed gold | Exact hits | BM25 hits | Case regressions | Unverified shortlists |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development | 8/9 | 4/8 | 5/8 | 0 | 0 |
| Holdout | 11/11 | 0/11 | 7/11 | 0 | 0 |

One development gold document was retained without searchable text because
the PDF extraction worker could not establish its required hard memory limit
on this macOS host. This is an extraction coverage gap, not a BM25 miss. The
Registrar preserved the original and reported the bounded reason
`pdf-memory-boundary-unavailable`; the gate excluded that question from both
rankers' diagnostic recall. It did not relax the memory boundary. The
development recall values are therefore 4/8 and 5/8, while the cohort still
has 9 questions and remains blocked.

## Gate policy and next decision

Promotion requires at least five questions with disjoint gold targets in each
cohort, full gold text coverage, verified returned shortlists, a net BM25 gain
in both cohorts, and no case-level regression. The one PDF gap blocks this
sample. Repair or replace PDF text extraction under an enforceable resource
boundary, then rerun the pinned gate on a new capture. Do not tune against the
holdout after seeing these results; a later promotion run needs a fresh
independent holdout cohort. This gate measures document discovery and first
excerpt integrity. It does not measure full-answer correctness or graph
relationship accuracy.

The private plan, intake handoff, source IDs, paths, source excerpts, and task
reports are intentionally kept outside this repository.
