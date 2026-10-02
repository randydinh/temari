# Sealed copied-corpus retrieval diagnostic, 2026-10-02

## Decision

Keep the existing ranker defaults. On this copied, local-only corpus, BM25
found more agent-selected source documents than exact discovery at the same
top-three result and 16,000-byte response limits. This is a diagnostic of
archived document discovery. It does not establish answer correctness, a
human-task retrieval rate, no-answer behavior, or a production promotion.

## Method

An independent author wrote five development and five holdout questions by
reading the previously copied Temari Nx source, small non-Nx Python source,
and mixed document corpus before seeing search results. Each case had one
distinct gold document and scoped all three registered local-only sources.
The question set was sealed at SHA-256
`c80d264e1ee271da8cbf6d31b7dab791a8e4eccd9bfebb33ea1b3566f495aa4a`
before evaluation. Questions, source IDs, paths, and source text remain in
the private local task directory.

The evaluator checked the question-set hash before and after its run, checked
that all ten gold paths had archived text, and ran exact and BM25 discovery
against the same three pinned Registrar generations. It requested three
results and a 16,000-byte response for each arm. Every returned result was
read again by manifest and representation hash; the original citation hash
was checked too. No Jev call or hosted source sharing occurred.

| Cohort | Indexed gold | Exact hits at 3 | BM25 hits at 3 | BM25 regressions | Verified returned citations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development | 5/5 | 1/5 | 5/5 | 0 | 30/30 |
| Holdout | 5/5 | 1/5 | 4/5 | 0 | 30/30 |

BM25 improved four development cases and three holdout cases over exact
discovery. The held-out miss was a Temari code question whose chosen source
file was absent from BM25's top-three results. This failure remains unresolved;
the holdout is now inspected and cannot be reused as a blind promotion set.
The author-selected gold paths are diagnostic labels, not independently
validated user-task answers. Each result verifies a source pin, not whether
its passage answers the question.

## Limits and next gate

This evaluator used Registrar's direct archived-snapshot API on the previously
copied corpus. It did not run Temari's canonical retrieval-gate handoff, and
its result cannot be assigned that gate's `promotion-eligible` status. It also
did not test Jev judgments, graph expansion, scanned-PDF meaning, PNG visual
meaning, or an answerability/abstention decision. Sequential single-host
wall times are recorded privately for reproducibility but do not establish a
latency advantage.

For a default change, run Temari's pinned gate on a fresh, independently
selected and answer-validated question set with text and visual coverage
marked explicitly. Add no-answer cases and score whether the system abstains
without treating a lexical match as proof of an answer. Keep the model and
sharing constraints: Jev is the only hosted model, and registered sources
remain local-only when marked so.
