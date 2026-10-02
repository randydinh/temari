# Temari Knowledge handoff, 2026-10-02

This updates the historical [2026-10-01 overnight audit](overnight-audit-2026-10-01.md)
after later merged increments. The work ran in an isolated checkout; the
conflicted primary checkout was not used. The original reconciliation below
observed `origin/main` at `344b57553b03ae7039ee4215a85388cd65b50ee6`.
The later update below observes main at
`6f310ebb8f49b38d83826063c68e2cb92c0bd721`.

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

## Update after archive recovery, image inventory, and freshness audit

GitHub reports [#149](https://github.com/randydinh/temari/pull/149),
[#151](https://github.com/randydinh/temari/pull/151), and
[#152](https://github.com/randydinh/temari/pull/152) merged. Their reported
result commits (`c988b6b`, `c776b46`, `6f310eb`) are ancestors of the observed
main. Each increment had an independent exact-head review and a clean canonical
package/check before merge; GitHub reported no branch checks for these PRs.

| Increment | Verified result | Boundary |
| --- | --- | --- |
| [Archive-only recovery](archive-only-recovery-2026-10-02.md), #149 | An actual Registrar export/import restored one pinned generation under a separately pre-provisioned identical source registration and `local-only` setting. Exact archived citations and original bytes survived live edit/deletion; tampered blobs, wrong origin, and disabled reads refused. Full Knowledge integration passed 78/78. | This does not restore source policy, graph or derived views, retention/erasure state, or establish production RPO/RTO or Windows recovery. |
| [Visible Markdown image inventory](visible-image-inventory-2026-10-02.md), #151 | An actual Registrar fixture resolved a retained PNG on a later manifest page, pinned its hash/byte count and recovered exact bytes. The metadata-only receipt distinguishes missing, external/unsupported, and outside-source references. Full integration passed 79/79. | No image interpretation, OCR, reference-style/HTML inventory, or embedded PDF/DOCX image coverage. |
| [One-shot freshness audit](freshness-job-2026-10-02.md), #152 | A due-gated caller can run one pinned local audit under a fenced child-task lease and receive a durable point-in-time `unchanged`, `recapture-needed`, or `unknown-needs-review` decision. Expired pre-stage scans are capped at two; a published stage can complete without rescanning. Full integration passed 87/87. | No recurring trigger, automatic recapture, atomic filesystem snapshot, exactly-once scan across a pre-stage crash, or live freshness guarantee. |

The current #152 head also passed Knowledge unit tests 43/43, Nx sync and
typecheck, a clean canonical package/check, and a stock-Node import of its
public export. These checks used the actual bundled Registrar on this macOS
host. The new three increments made no hosted Jev call and did not change the
direct TypeSafe Keychain or registered-source/local-only policy.

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
3. **Continuous graph and source evolution.** Connect the now-leased one-shot
   audit to a verified recurring trigger; design and test automatic recapture
   crash/retry and next-generation selection; reconcile dependent indexes and
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

## 04:41 UTC DOCX package-media continuation

GitHub reports [#154](https://github.com/randydinh/temari/pull/154) merged at
`d02bdedf05ff595184dee5aaff2d4ee18b713159` after independent exact-head
review of clean commit `0fe0b2e396939b8ff7adf43c572cc34dbc90bcfb`.
The final-source actual-Registrar integration passed 88/88, Knowledge unit
tests 43/43, typecheck and Nx sync passed. Canonical package/check reported
that exact commit with `dirty:false`, and the stock Node Knowledge export
loaded. GitHub listed no branch checks for #154. The local `gh pr merge`
command returned an error while trying to switch to `main` because another
worktree owns it; the remote PR state and merge commit confirm the merge.

The [DOCX package-media inventory](docx-media-inventory-2026-10-02.md) checks
one explicitly recovered original against its retained manifest entry and
current source registration. It emits bounded `word/media/*` hashes and byte
counts only. It does not determine whether document XML displays a member or
what an image means. The fixture used `local-only`; this increment made no
TypeSafe call. The broader five finish predicates above remain open.

## 05:10 UTC DOCX declared-reference continuation

GitHub reports [#156](https://github.com/randydinh/temari/pull/156) merged at
`ddf974f92cd0f6246571ecdc44c5f6829c2c71c3` after independent exact-head
review of clean commit `4f305bc964c8234905abe1568683942f8fa49e9b`.
Final actual-Registrar Knowledge integration passed 89/89, unit tests 43/43,
typecheck and Nx sync passed. The canonical package/check reported that exact
head with `dirty:false`; a stock Node import of its public export succeeded.
GitHub listed no branch checks. As with #154, the local merge command returned
an error switching to `main`, but the remote PR state confirms the merge.

The [declared DOCX reference receipt](docx-drawing-refs-2026-10-02.md) maps
main-document DrawingML `r:embed` declarations through internal image
relationships to pinned media and records unresolved or linked cases as gaps.
It was verified on a `local-only` Registrar source without a TypeSafe call.
It covers syntax in one DOCX part, not rendering, image meaning or full DOCX
visual coverage. The five broader finish predicates remain open.

## 05:37 UTC DOCX header/footer continuation

GitHub reports [#158](https://github.com/randydinh/temari/pull/158) merged at
`e8eca407676bda5a718bd60ae8e0eb142815b3af` after independent exact-head
review of clean commit `f351c1fe7602b8d3e17ee2a2dbe4faeeb9c27c2a`.
Final actual-Registrar Knowledge integration passed 90/90, the focused local
capture/delete/recover case passed 1/1, unit tests passed 43/43, typecheck
and Nx sync passed. Canonical package/check reported that exact head with
`dirty:false`; a stock Node import of its public export succeeded. GitHub
listed no branch checks. The local merge command hit the occupied `main`
worktree during cleanup, but the remote PR state confirms the merge.

The [declared header/footer receipt](docx-header-footer-refs-2026-10-02.md)
links direct section declarations through selected part relationships to
pinned package media. Its residual-media field is scoped only to selected
header/footer parts. The fixture used a `local-only` source and made no
TypeSafe call. This does not determine which header or footer Word renders on
a page, image meaning or full DOCX visual coverage. The five broader finish
predicates remain open.
