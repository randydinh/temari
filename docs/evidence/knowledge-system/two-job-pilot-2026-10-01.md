# Runtime-owned intake and retrieval pilot

Date: 2026-10-01. Candidate: `codex/knowledge-two-jobs-20261001` before merge. The admitted corpus and full receipts remain in a private task directory outside Git. This note contains no source text, credential or local corpus path.

The coordinator stores one immutable, content-addressed job spec and two dependent child tasks in the existing runtime store. An explicit tick claimed intake, published and validated its handoff, then a second tick claimed search using that persisted handoff. The selected intake covered three registered snapshots: a Temari Nx checkout, a non-Nx Python checkout, and selected documents. Search narrowed to one of those sources.

The live search returned one ranked document and one verified first excerpt at requested top K of three. The registered-source sharing gate was `allowed`; one TypeSafe Jev `jev-1.13.0` judgment returned `judged`. The query report retained three explicit gaps and two source capability gaps, so the search child correctly ended `ISSUES` despite the verified excerpt. A third tick returned `action: none`, the same report identity, and no additional search invocation. This proves replay after completed work in this local pilot, not exactly-once provider billing after an interrupted request.

Static and integration checks on the final candidate: `pnpm nx run knowledge:typecheck --skipNxCache` passed and `pnpm nx run knowledge:integration --skipNxCache` passed 48/48. The integration suite includes expired lease recovery, bounded retries, hosted retry blocking, receipt tampering, capture-binding mismatch, report status/budget/sharing mismatch, and precreated false-block rejection.

This is an operator-run create/tick flow. It has no unattended scheduler, notifications or automatic judgment on whether an `ISSUES` result answers the worker's question. The PDF worker memory-boundary gap and image visual-meaning gap remain. Graph ranking is still a diagnostic route, pending a held-out comparison.
