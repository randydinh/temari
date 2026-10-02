# Local-only real-corpus PDF follow-up — 2026-10-02

This follows the first bounded Mac PDF worker in [PR #143](https://github.com/randydinh/temari/pull/143).
The input is the private **2026-09-30 copied corpus** used in the earlier
[pilot](real-corpus-pilot-2026-09-30.md), recaptured with merged Temari code.
It is a local exploratory check, not a current live-source audit or an
independent held-out quality benchmark. All three sources were registered as
`local-only`; the run made no TypeSafe or other hosted-model call.

## Captured sources

| Family | Text representations | Excluded | Limited | Original preservation |
| --- | ---: | ---: | ---: | --- |
| Temari Nx snapshot | 309 | 67 | 0 | complete-admitted |
| Non-Nx Python snapshot | 108 | 32 | 0 | complete-admitted |
| Six mixed documents | 5 | 0 | 0 | complete-admitted |

The mixed set contains Markdown, HTML, DOCX, two PDFs, and PNG. Both PDFs now
have a `pdf-text` representation. Pinned bounded reads reported total
representation lengths of 3,525 and 39,587 characters respectively, with
citations bound to the retained original and
representation hashes. `recover` returned byte-for-byte originals matching
the archived SHA-256 values. Both PDFs continue to report
`visual-evidence-unavailable` and `asset-inventory-partial`. The PNG retains
its original but has no text representation in this default capture;
`unsupported-format` and visual gaps remain explicit.

## Exploratory retrieval check

Two target-specific questions were written from the known PDF topics before
calling `discover`, then exact and BM25 used the same five indexed document
representations and were judged at a top-three success threshold. The first
PDF ranked **5 exact / 1 BM25**; the second ranked **3 exact / 1 BM25**. This
verifies that both real
PDF representations can enter the pinned BM25 shortlist. It is too small and
target-aware to justify changing the default ranker.

A designated no-answer future-fee probe still matched five documents in each
lexical mode. Its answer label has not been independently checked against the
corpus. A candidate match is not an answer; an answerability and abstention
gate remains necessary. No image or scanned-page meaning was
inferred. The prior copied corpus, target-aware questions, and one Mac/VM
cannot establish production retrieval quality, current OpConnect source
coverage, Windows behavior, or a lossless knowledge system.

## Reproducibility boundary and next gate

The private archive state and scripts remain outside version control in a
temporary local workspace. The three archived manifest hashes were
`ee04fec87afd32b34bdec21c1d64c2661805cc7703978b12db4a38a1b4b46662`,
`0a9bfbf4fd3c75f0626b90f7fb556c6f723a5a15e2e0bd406e9f105089c3cf7f`,
and `b1e5eff8e24dfb0767045f7734383d9deaf135e52e007531ac14c590652103d1`.
The next quality gate needs independently authored real tasks with answer and
no-answer labels, source revisions, visual cases, equal candidate/byte
budgets, and a second held-out cohort before ranker or graph promotion.
