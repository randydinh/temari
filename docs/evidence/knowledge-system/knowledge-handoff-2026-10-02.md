# Temari Knowledge handoff, 2026-10-02

This updates the historical [2026-10-01 overnight audit](overnight-audit-2026-10-01.md)
after later merged increments. The work ran in an isolated checkout; the
conflicted primary checkout was not used. At this reconciliation,
`origin/main` is `344b57553b03ae7039ee4215a85388cd65b50ee6`.

## Reconciliation

The append-only [decision log](../../../.audit/knowledge-overnight-2026-10-01.tsv)
had 112 six-field data rows before the two new handoff audit rows. GitHub reports
PRs #127–138, #141, and #143–147 merged; all 18 GitHub-reported PR result
commits are ancestors of the observed main. PRs #139–140 and #142 also appear
in main, but belong to other Temari work and are outside this knowledge
delivery accounting. The log
has delivery rows for #127–137, #141, #143, #145–147. PR #138's historical
audit and PR #144's copied-corpus evidence are documented in their artifacts;
they lack distinct delivery rows in the original trail. This reconciliation
preserves that discrepancy rather than changing prior entries.

| Area | Current verified result | Boundary |
| --- | --- | --- |
| Archive preservation and lifecycle | Pinned capture, generation diff, point-in-time currentness, bounded audit paging, operator recapture and deterministic resume have actual Registrar integration tests from #127–135. | No continuous freshness, production backup/restore or erasure ledger. |
| Relationships | Reviewed fresh v2 roots and receipt-pinned child evaluation reached main in #136, #137 and #141. | Semantic reviewer identity is unauthenticated; automatic relationship correction and unlabelled graph expansion are not proven. |
| Mac searchable PDFs | [#143](https://github.com/randydinh/temari/pull/143) proved opt-in searchable-PDF text capture through a pinned local Linux guest with enforced memory/swap bounds, retained originals and explicit scanned/image gaps. [#144](https://github.com/randydinh/temari/pull/144) recaptured two PDFs from a prior copied local-only corpus and verified pinned text reads and original recovery. | The VM route is opt-in and host specific. Scanned pages and visual meaning remain gaps. |
| Bundled installer | [#145](https://github.com/randydinh/temari/pull/145) repaired the Registrar payload inventory and digest pins; the relocated Mac Knowledge install passed 63/63 public-entry cases. | No actual Windows installation or operation proof. |
| Retrieval | [#146](https://github.com/randydinh/temari/pull/146) recorded a pre-sealed, agent-authored ten-question copied-corpus diagnostic at top three: exact 1/5 and BM25 5/5 development; exact 1/5 and BM25 4/5 holdout, with 60/60 citation checks. | Agent-selected gold is not human-validated task quality. The inspected held-out miss cannot remain blind; BM25 stays opt-in. |
| Negative feedback | [#147](https://github.com/randydinh/temari/pull/147) adds a local, pinned receipt for all displayed first excerpts failing to answer, or an observed empty shortlist. Positive feedback receipts stay unchanged. | Labels are synthetic in tests; full documents and corpus absence are not assessed. |

The final #147 head passed actual-Registrar `knowledge:integration` 77/77,
`knowledge:test` 43/43, `knowledge:typecheck`, and Nx sync. Its clean
canonical package/check reported `dirty:false` at the reviewed head, and a
relocated stock-Node import of the Knowledge export passed. An independent
reviewer found no must-fix issue at that exact head. GitHub listed no branch
checks for #147, so these are local verification and review results.

The direct TypeSafe Keychain route remains the only hosted Jev path in this
workflow. Current registration and local-only sharing decisions gate hosted
text. The new PDF and feedback increments made no hosted calls; the earlier
[real-corpus pilot](real-corpus-pilot-2026-09-30.md) contains the separate
live Jev shadow evidence. No Vercel credential is used.

## Finish predicate still open

1. **Representative answer quality.** Collect real knowledge-worker questions
   with independently checked answers and cited evidence across Nx, non-Nx,
   mixed documents, no-answer, contradiction and visual-only cases. Run the
   canonical pinned Temari gate at equal budgets, include answerability and
   abstention scoring, then separately measure Jev and graph contribution.
   One copied-corpus diagnostic is insufficient to promote a default.
2. **Visual and format coverage.** Inventory image assets inside containers,
   test linked images under explicit admission, and assess OCR and visual
   meaning separately. A searchable PDF's text does not cover a scanned page
   or chart. Preserve unsupported meaning as a gap.
3. **Continuous graph and source evolution.** Schedule bounded source audits
   and recapture with durable runtime leases; reconcile dependent indexes and
   graph assertions. Authenticate semantic corrections, then measure relation
   precision, recall, stale-edge repair and rollback on changed generations.
4. **Operational recovery.** Exercise backup/restore of bytes, manifests,
   derived views and access/retention state with tested RPO/RTO, revocation and
   erasure checks. Operator-triggered recapture and no-capture resume are not
   an automatic production recovery service.
5. **Host and plugin lifecycle.** Verify Windows installation and operation on
   Windows. After core journeys pass, implement and test default-plugin
   disconnect, uninstall and reinstall with explicit archive-retention and
   purge behavior.

The present system has verified preservation and retrieval increments, but
the production **lossless knowledge system** finish condition is not met.
