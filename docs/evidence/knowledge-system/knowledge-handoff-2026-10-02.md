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

## 06:07 UTC Markdown reference-image continuation

GitHub reports [#160](https://github.com/randydinh/temari/pull/160) merged at
`358d8e9f6fa746620bef51db425654f1ed9aa564` after independent exact-head
review of clean commit `d3df7cd0886bbf470874c3b8fa3af82c0c424118`.
The reviewed and merged trees match. Final actual-Registrar Knowledge
integration passed 92/92, unit tests 43/43, uncached typecheck and Nx sync
passed. Canonical package/check reported the reviewed head with `dirty:false`,
and a stock Node import of its public export succeeded. GitHub listed no
branch checks. The local merge command hit the occupied `main` worktree during
cleanup; the remote PR state confirms the merge.

The [simple reference-image receipt](reference-image-inventory-2026-10-02.md)
resolves bounded full and collapsed Markdown image references through simple
single-line definitions to pinned archived assets, while recording explicit
gaps. Its actual `local-only` Registrar fixture deleted the live originals
before archive reads and made no TypeSafe call. Conservative parsing does not
cover all CommonMark or Markdown dialects, HTML images, rendering, visual
meaning or continuous freshness. The five broader finish predicates above
remain open.

## 06:33 UTC Markdown raw-HTML image continuation

GitHub reports [#162](https://github.com/randydinh/temari/pull/162) merged at
`814a4699060be04670a81dff8febea9b5fa285f3` after independent exact-head
review of clean commit `6f581f2e9af16fde7aed3e50de0ae606c9aaa6d9`.
The reviewed and merged trees match. Final actual-Registrar Knowledge
integration passed 94/94, focused explicit `local-only` capture/delete/read
and recovery cases passed 2/2, unit tests 43/43, uncached typecheck and Nx sync
passed. Canonical package/check reported the reviewed head with `dirty:false`,
and a stock Node import of its public export succeeded. GitHub listed no
branch checks. The local merge command hit the occupied `main` worktree during
cleanup; the remote PR state confirms the merge.

The [Markdown raw-HTML image receipt](markdown-html-image-inventory-2026-10-02.md)
records bounded simple `<img src="...">` declarations in archived Markdown
with pinned target metadata and explicit gaps. The actual Registrar fixture
set `local-only`, deleted live originals before archive reads, and made no
TypeSafe call. This does not establish browser or Markdown rendering, full
HTML coverage, visual meaning or continuous freshness. The five broader
finish predicates above remain open.

## 07:00 UTC multi-source graph impact continuation

GitHub reports [#164](https://github.com/randydinh/temari/pull/164) merged at
`bf68c54c7aa7f043b5bd379a5379abf2a40f79f0` after independent exact-head
review of clean commit `0df9d59fa5ab33fdd382e6a3f662ae335d4b4cc7`.
The reviewed and merged trees match. Final actual-Registrar Knowledge
integration passed 95/95, focused explicit `local-only` two-source fixture
passed 1/1, unit tests 43/43, uncached typecheck, Nx sync, formatting and diff
checks passed. Canonical package/check reported the reviewed head with
`dirty:false`, and a stock Node import of its public export succeeded. GitHub
listed no branch checks. The local merge command hit the occupied `main`
worktree during cleanup; the remote PR state confirms the merge.

The [multi-source graph impact receipt](multisource-graph-impact-2026-10-02.md)
reads an exact old 2–8-source RevisionSet and one changed source generation to
queue cross-source relationships for review, unchanged records as candidate
repins, and changed or added paths for discovery. It neither modifies a graph
nor proves a relationship correct. The actual fixture used `local-only`
sources and made no TypeSafe call. Automatic repair, continuous freshness and
the five broader finish predicates above remain open.

## 07:24 UTC multi-source anchor proposal continuation

GitHub reports [#166](https://github.com/randydinh/temari/pull/166) merged at
`832b4f50149e0ea2baf0be45057b606caff65e05` after independent exact-head
review of clean commit `b6da100ed802daaee214b11928e6f3ee44a7f7a7`.
The reviewed and merged trees match. Final actual-Registrar Knowledge
integration passed 96/96, focused explicit `local-only` two-source fixture
passed 1/1, unit tests 43/43, typecheck, Nx sync, formatting and diff checks
passed. Canonical package/check reported the reviewed head with `dirty:false`,
and a stock Node import of its public export succeeded. GitHub listed no
branch checks. The local merge command hit the occupied `main` worktree during
cleanup; the remote PR state confirms the merge.

The [multi-source anchor proposal](multisource-anchor-proposal-2026-10-02.md)
recomputes #164's pinned impact receipt and checks candidate A v2/B v1 anchors
against retained Registrar text. It keeps only eligible records in a proposal
and explicitly defers unsupported or dependent records. The actual fixture
used `local-only` sources and made no TypeSafe call. This does not repin or
publish an active graph, prove relationship meaning, or establish continuous
freshness. The five broader finish predicates above remain open.

## 07:56 UTC relocated Mac real-corpus continuation

GitHub reports [#168](https://github.com/randydinh/temari/pull/168) merged at
`cde71a1670998e653bec773fe707309b51562298` after independent exact-head
review of clean commit `72d5bce884b256484a98618b2dd3c57a11e800ba`.
The reviewed and merged trees match. The public-entry artifact passed Nx
package/check at the clean base, relocated checks before and after use, and a
cold bundled Registrar setup in a fresh temporary home. GitHub listed no
branch checks. The local merge command encountered an occupied `main`
worktree, while the remote PR state confirms the merge.

The [sanitized relocated-corpus evidence](relocated-real-corpus-2026-10-02.md)
records a fixed 16-file sample across non-Nx, mixed-document and Nx sources.
Three complete-admitted `local-only` captures retained 16/16 original hashes
and byte counts. Three family BM25 diagnostic queries returned one
archive-verified pinned citation each; one fixed nonce diagnostic returned no
ranked result. An archived PNG and PDF recovered to their original hashes.
Three mixed files still had no text representation under the default Mac
capture path, and visual meaning remains a gap. The direct TypeSafe Jev
credential was not read or invoked: the private failing credential shim
recorded zero calls with `TYPESAFE_API_KEY` unset.

This establishes Mac package wiring on the sampled local-only corpus only.
The queries were agent-authored and previously inspected, so they are not
independent answer-quality labels or grounds to promote BM25. No Windows
installation, graph semantics, continuous freshness, production recovery,
plugin lifecycle or production losslessness is proven. All five broader
finish predicates above remain open.

## 08:30 UTC BM25 scale continuation

GitHub reports [#170](https://github.com/randydinh/temari/pull/170) merged at
`b72b2c9a9233842ff68c7c73a4f0b3571f17a197` after independent exact-head
review of clean commit `31fd3ec54b02f82bb8c34beb1a73d771a1c1a183`.
The reviewed and merged trees match. Actual Registrar Nx Knowledge integration
passed 96/96, unit tests 43/43, uncached typecheck and Nx sync passed. The
final opt-in script repair was rerun through focused and full benchmark
journeys. The public-entry package/check reported the exact clean head with
`dirty:false`, and its relocated stock Node Knowledge export loaded. GitHub
listed no branch checks. The local merge command encountered an occupied
`main` worktree; remote state confirms the merge.

The [synthetic local-only BM25 scale note](bm25-scale-2026-10-02.md) records
seven fresh-process discovery samples at 100, 500 and 1,000 selected documents.
Median observed times on this Mac were 127.425, 674.979 and 1463.777 ms.
All 24 top citations matched pinned archive reads, index digests were stable
within each scope, and a 33-term query refused under the 32-term cap. The
timer includes process startup and archive selection; source count grows with
document count. These observations are neither an isolated FTS build cost nor
a production latency target, cache decision, answer-quality result, or reason
to promote BM25 as default. The runner used synthetic `local-only` sources and
made no hosted Jev or Keychain call. All five broader finish predicates above
remain open.

## 09:10 UTC archived standalone HTML image continuation

GitHub reports [#172](https://github.com/randydinh/temari/pull/172) merged at
`c37ea22672cd7b16dbeb47ebc1cf30eee0d4bf8d` after independent exact-head
review of clean commit `2801293ced3588007ce419b7a0cbc04450cf9091`.
The reviewed and merged trees match. Final actual Registrar Nx Knowledge
integration passed 98/98; focused cases 2/2, unit 43/43, uncached typecheck,
Nx sync and scoped formatting passed. The exact-head public-entry package
reported `dirty:false`; its manifest check and a relocated stock Node import
of the new export passed. GitHub listed no branch checks. The local merge
command encountered an occupied `main` worktree; remote state confirms the
merge.

The [archived HTML image receipt](html-image-inventory-2026-10-02.md) checks
one explicitly recovered `.html`/`.htm` original against its pinned manifest
hash and byte count, records bounded simple single-line `<img>` declarations
with Unicode spans and quote hashes, and links source-relative local targets
to retained original hashes and byte counts from the complete paged manifest.
The actual `local-only` fixture deleted live HTML and PNG before recovery,
proved a target on a later manifest page, and exercised tamper, admission,
path, ambiguity and size refusals. The current adapter deliberately refuses
`registered-sources` sharing. It neither determines browser rendering nor
interprets image meaning; OCR, visual coverage, Windows, graph recovery and
all five broader finish predicates above remain open. No hosted Jev call or
Keychain read occurred.

## 09:38 UTC archived HTML sharing continuation

GitHub reports [#174](https://github.com/randydinh/temari/pull/174) merged at
`ce4ea89d5f68de5fbcfb4ff6cf2beed39e8995a9` after independent exact-head
review of clean commit `3b043186111b70e2620fbf7c737b875bd85ab642`.
The reviewed and merged trees match. Final actual Registrar focused HTML cases
passed 3/3, uncached Nx Knowledge integration 99/99, unit tests 43/43,
typecheck, Nx sync and scoped formatting passed. The exact-head public-entry
package reported `dirty:false`; its manifest check and relocated stock Node
Knowledge export passed. GitHub listed no branch checks. The local merge
command encountered an occupied `main` worktree; remote state confirms the
merge.

The [sharing admission note](html-image-sharing-2026-10-02.md) describes how
the local HTML declaration inventory now accepts either `local-only` or
Registrar's default `registered-sources` mode. New schema-2 metadata receipts
record the current mode and preserve the earlier local-only coverage literal;
schema-1 receipts remain historical local-only records without a mode field.
The actual default-mode fixture deleted live HTML and PNG, recovered the exact
HTML original and checked retained image pins. A deterministic mid-run mode
change refused. These are start/end policy observations, not an atomic
sharing snapshot or permission for a hosted Jev call. The adapter made no
hosted call or key read. It does not prove browser rendering, visual meaning,
continuous freshness, Windows behavior, graph recovery, answer quality, or
production losslessness. All five broader finish predicates above remain
open.

## 10:05 UTC paired archive and root-graph recovery continuation

GitHub reports [#176](https://github.com/randydinh/temari/pull/176) merged at
`8652bff9c9e49a436017a552799d72a9979b2569` after independent exact-head
review of clean commit `3acf1744126ad6a172da215ae35a3bf030387d55`.
The reviewed and merged trees match. Final actual Registrar focused recovery
passed 1/1, uncached Nx Knowledge integration 100/100, unit tests 43/43,
typecheck, daemonless sync and scoped formatting passed. The exact-head
public-entry package reported `dirty:false`; its manifest check and relocated
stock Node graph reader passed. GitHub listed no branch checks. The local
merge command encountered an occupied `main` worktree; remote state confirms
the merge.

The [paired recovery proof](graph-recovery-2026-10-02.md) exports one retained
archive generation and one parent-null root graph as separate packages,
imports them into a fresh pre-provisioned `local-only` Registrar workspace,
and checks exact graph and RevisionSet IDs, three pinned records, derived
projection, archived reads and byte-exact original recovery after live files
change. Wrong-order, tampered-package and disabled-registration cases refuse.
The synthetic packages are deleted in the fixture's `finally` cleanup. A
daemonless Nx sync gate also exposed one missing generated workflow-runtime
TypeScript reference; Nx sync added only that reference.

This is a one-root, one-source deterministic replay proof, not an atomic
backup or production recovery system. It does not restore registration
policy, access grants, erasure state, child graph history, retractions or
arbitrary derived views, and establishes no RPO/RTO, Windows support,
semantic correctness or production losslessness. It used no Jev call or key
read. All five broader finish predicates above remain open.

## 10:30 UTC root and retracted-child replay continuation

GitHub reports [#178](https://github.com/randydinh/temari/pull/178) merged at
`231c032c6432d8095cbeed3810f35e5a7631d3f8` after independent exact-head
review of clean commit `27466aa3cf350b31a0c7c4b818a6974b7951f5e8`.
The reviewed and merged trees match. The final actual Registrar child case
passed in uncached Nx Knowledge integration 100/100; unit tests 43/43,
typecheck, daemonless sync, scoped format and diff checks passed. The
exact-head public-entry package reported `dirty:false`; its manifest check
and relocated stock Node graph reader passed. GitHub listed no branch
checks. The local merge command encountered an occupied `main` worktree;
remote state confirms the merge.

The [retracted-child replay proof](graph-retraction-replay-2026-10-02.md)
extends the earlier synthetic `local-only` test to one root and one child
that retracts a relationship. Ordered archive, root OKF and child OKF imports
into a pre-provisioned destination preserve exact graph and RevisionSet IDs,
the parent pointer, stored record and retraction ledger, and checked derived
projections after live originals change or disappear. Child-before-root,
tampered child, disabled source and retired-assertion resurrection cases
refuse without extra graph state; reimporting the root leaves the retirement
in place. The raw synthetic packages are removed in `finally`.

This covers only one ordered source lineage. It does not establish atomic
backup, arbitrary graph history, policy or erasure restore, RPO/RTO, Windows
support, semantic quality, visual meaning or production losslessness. No
hosted Jev call or key read occurred. All five broader finish predicates
remain open.

## 10:57 UTC fixed-source BM25 component continuation

GitHub reports [#180](https://github.com/randydinh/temari/pull/180) merged at
`66e59a0ed3abbeea282d3102c2fe1d86853df334` after independent exact-head
review of clean commit `d81b49168830b80e3817e9fd616d861cbd49fe83`.
The reviewed and merged trees match. Actual Registrar Nx Knowledge
integration passed 100/100, unit tests 43/43, daemonless typecheck and sync
passed; scoped format and diff checks passed. An initial daemon typecheck
reported stale sync, while the daemonless check passed. The integration
target succeeded, although a subsequent shell wrapper statement failed.
The exact-head public-entry package reported `dirty:false`; its manifest
check and relocated stock Node Knowledge export passed. GitHub listed no
branch checks. The local merge command encountered an occupied `main`
worktree; remote state confirms the merge.

The [fixed-source BM25 component note](bm25-cost-2026-10-02.md) describes
one synthetic `local-only` source with pinned 100, 500 and 1,000-document
generations. Seven samples after one warmup measured fresh CLI discovery,
in-process discovery and a process-local wrapper around the BM25 rank helper;
48 top citations were independently checked against retained archive reads,
with stable index digests. Median in-process discovery was
41.401/846.399/3276.202 ms; wrapped helper median was
0.656/1.915/3.421 ms on this Mac. Raw samples and host details stayed off
repository. The paired residual includes mixed archive and Python work; the
sequential CLI and in-process blocks cannot isolate startup. These times are
not an SLO, cache decision, default-ranker promotion or answer-quality gate.
No hosted Jev call or key read occurred. All five broader finish predicates
above remain open.

## 11:32 UTC manifest hash reuse continuation

GitHub reports [#182](https://github.com/randydinh/temari/pull/182) merged at
`cbbbee00048472cc40624e88b9788576f0fca267` after independent exact-head
review of clean commit `65aead3f363cc922933430f7974b3f8ee715c565`.
The reviewed and merged trees match. The expanded two-source actual Registrar
case passed, uncached Nx Knowledge integration passed 100/100, unit tests
43/43, daemonless typecheck and sync passed. Registrar payload verification
passed 6/6. The exact-head public-entry package/check reported `dirty:false`,
and a relocated stock Node Knowledge CLI help command loaded. GitHub listed
no branch checks. Local merge cleanup met the occupied `main` worktree;
remote PR state and tree confirm the merge.

The [per-discovery hash note](bm25-manifest-hash-2026-10-02.md) records a
single-call reuse of the selected archive manifest hash already computed for
the continuation binding. `_selection`/`_load` validation and final
`_recheck` remain. The two-source fixture checks exact and BM25 pins, order,
pagination and policy/integrity refusals. The bundled Registrar source and
manifest pins were updated to preserve installer integrity. The opt-in
synthetic `local-only` diagnostic matched fixture settings and selected bytes
across before/after runs, with 48 independently checked top citations per
run. In-process medians for 100/500/1,000 documents changed from
41.401/846.399/3276.202 ms to 7.007/30.857/59.601 ms on this Mac. Runs
were sequential with new source/generation identities, so these observations
are not an SLO, a pure hash-cost estimate, or an answer-quality decision. No
hosted Jev call or key read occurred. All five broader finish predicates
above remain open.

## 12:03 UTC read-only recovery dependency continuation

GitHub reports [#184](https://github.com/randydinh/temari/pull/184) merged at
`617a0cc4641d87361f1785dac1b03b109dd9eb94` after independent exact-head
review of clean commit `5bf6f4057fba3febafe871883efeedc55ac11778`.
The reviewed and merged trees match. Focused actual Registrar recovery passed
1/1, uncached Nx Knowledge integration 100/100, unit tests 43/43, daemonless
typecheck and sync, scoped format and diff checks passed. The exact-head
public-entry package/check reported `dirty:false`; relocated stock Node
Knowledge CLI help and packaged Knowledge export loaded. GitHub listed no
branch checks. Local merge cleanup met the occupied `main` worktree; remote
state and tree confirm the merge.

The [dependency-plan note](graph-recovery-dependency-plan-2026-10-02.md)
describes a read-only, metadata-only check of one small archive bundle and up
to four small OKF packages. It verifies declared source/generation/manifest
closure, unique graph IDs, one root and root-first parent order, then returns
package hashes. The existing synthetic `local-only` archive/root/retracted
child fixture planned shuffled packages and used that order for actual
Registrar replay. Missing or mismatched selectors, orphan/duplicate/cyclic
graphs, over-budget packages and a final-component symlink refused before
destination mutation. Tampered OKF content can pass this plan but Registrar
import refuses it. The planner does not validate all payloads or current
admission, or bind later path bytes to the receipt. Its 8 MiB archive and
1 MiB OKF caps exclude valid larger Registrar exports; ancestor symlinks and
atomicity are outside scope. No hosted Jev call or key read occurred. This
does not establish production backup, erasure, RPO/RTO, semantic quality,
Windows operation or a lossless system. All five broader finish predicates
above remain open.
