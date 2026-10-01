# Temari Knowledge overnight audit — 2026-10-01

This is the morning handoff for the isolated run in
`/private/tmp/temari-knowledge-overnight-20261001`. Its tested source branch
started at `ef5553a942e64bbffbc551e74be31f0368b8f58f`; the latest merged
main observed for this audit is `5ddd98353244e93f06c43aa1544cc668c412050f`.
The conflicted primary checkout was not used for the run.

## Reconciliation

At the reconciliation check, the append-only [decision log](../../../.audit/knowledge-overnight-2026-10-01.tsv)
had 92 data rows, each with six fields. Its 11 delivery rows named PRs #127–137;
audit and handoff rows were appended after that check.
GitHub reports all 11 merged, and the corresponding merge commits appear in
the isolated checkout's main ancestry. The two repin selection rows with
rounded future timestamps have a later correction row; the original rows were
preserved. The log records the blocked macOS PDF experiment and repaired test
fixtures separately from delivered changes.

| Increments | Merged evidence | What the evidence establishes |
| --- | --- | --- |
| Preservation and source state | [#127](https://github.com/randydinh/temari/pull/127), [#129](https://github.com/randydinh/temari/pull/129), [#130](https://github.com/randydinh/temari/pull/130) | Pinned generation diff, point-in-time local original audit, and bounded immutable audit pages. PDF originals and explicit unsupported gaps remain visible. |
| Source lifecycle and integrity | [#132](https://github.com/randydinh/temari/pull/132), [#133](https://github.com/randydinh/temari/pull/133), [#135](https://github.com/randydinh/temari/pull/135) | Operator-triggered recapture handoff, original capture binding consistency on historical loads, and no-capture resume from a complete persisted v2 result. |
| Graph maintenance | [#128](https://github.com/randydinh/temari/pull/128), [#134](https://github.com/randydinh/temari/pull/134), [#136](https://github.com/randydinh/temari/pull/136), [#137](https://github.com/randydinh/temari/pull/137) | Read-only impact and repin proposals, an explicitly reviewed fresh v2 root with new IDs, and a receipt-pinned one-hop diagnostic under the matching v2 archive. |
| Retrieval measurement | [#131](https://github.com/randydinh/temari/pull/131) | Synthetic five-development/five-holdout exact-vs-BM25 gate mechanics at top two, with verified shortlists. This is not independent real-task quality evidence. |

The latest final `knowledge:integration` run passed 72/72 actual-Registrar
cases, `knowledge:test` passed 43/43, and `knowledge:typecheck` passed. The
final [verification notes](../../../libs/knowledge/VERIFICATION.md) and
the run's [plan](../../plans/knowledge-overnight-2026-10-01.md) record the
focused checks and limits of each increment. For #136 and #137, canonical
package/check artifacts reported the exact reviewed heads with `dirty:false`,
and stock Node imported each new export. Independent exact-head reviews found
no blocking issue. GitHub reported no branch checks for those PRs, so local
Nx and review evidence carry those claims. Logs and private test receipts are
outside the plugin bundle.

## Finish predicates still open

1. **Searchable PDF text on this macOS host.** The actual worker cannot
   establish its required hard memory limit with Darwin `setrlimit`, and no
   pinned Linux worker was available. The first-unit finish condition is not
   met. Searchable PDFs preserve original bytes but report
   `pdf-memory-boundary-unavailable`; scanned or image-only inputs do not
   receive invented text. Parser-only or Linux behavior is not macOS proof.
2. **Representative lossless coverage and retrieval quality.** The earlier
   three-source [real-corpus pilot](real-corpus-pilot-2026-09-30.md) exercised
   Nx, a small non-Nx Python repository, and mixed documents, but its PDFs
   lacked text on this Mac. Its nine questions and the synthetic ten-question
   gate do not establish an independent held-out task benchmark. No-answer,
   visual meaning, image-only and embedded-image cases lack a production
   answerability gate. BM25 remains opt-in; no default ranker changed.
   Native Graphify semantic extraction for non-code material was not run under
   the Jev-only hosted-model policy; the local graph snapshot was also absent
   from this isolated checkout.
3. **Continuous source and relationship evolution.** Currentness is a
   bounded point-in-time observation. Recapture, v2 graph publication and
   evaluation require explicit operator action. The fresh-root review
   attributes a reviewer but does not authenticate one; unchanged quotes do
   not prove semantic validity. The v2 graph trial accepts operator-supplied
   lexical candidates and gold, so it does not measure BM25 lift or enable
   unlabelled production graph expansion. A read-only follow-up found that
   evaluating a reviewed *child* of the fresh v2 root needs a separate pinned
   child-receipt chain; the current wrapper selects only the fresh root. The
   changed-content link recovery path has not been exercised end to end.
4. **Operations and host coverage.** Safe backup/restore still needs an
   erasure and authorization ledger plus derived-view reconciliation. Recovery
   from a missing persisted capture result, automatic leases/retries, and
   source scheduling are open. Windows installation and operation have not
   been verified on Windows. Default optional-plugin disconnect, uninstall,
   reinstall and archive-retention behavior remain future work.

The direct TypeSafe Keychain route remains the only hosted-model path for this
knowledge workflow; none of the overnight increments called a hosted model.
Registered sources may be sent unless marked local-only, and current source
admission is rechecked on the new paths. The older pilot contains the separate
evidence for live Jev judgments. No Vercel key or other hosted model was used.

## Next measured work

First prove an actual macOS searchable-PDF capture within a hard worker
memory/swap boundary while preserving explicit scanned/image-only gaps. Then
run a genuinely independent, source-scoped real-task evaluation across text,
code, no-answer and visual cases at equal candidate and byte budgets before
considering a BM25 or graph default. Separately design runtime-owned source
refresh and a receipt-pinned reviewed-child evaluation after changed content,
then verify recovery and Windows
on their actual hosts. Package lifecycle work should follow those core
journeys so install/disconnect/uninstall/reinstall can preserve archives and
audit history deliberately.

This run delivered verified local increments, not a production lossless
knowledge system.
