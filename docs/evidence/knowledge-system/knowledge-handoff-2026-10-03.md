# Temari Knowledge overnight handoff, 2026-10-03

This handoff audits the private Knowledge release and installer work from the clean isolated Temari worktree. The conflicted primary checkout and the separate reconciliation/Windows recovery checkouts were not edited. Direct TypeSafe Jev remains the sole hosted model; registered sources may be shared unless marked local-only. No TypeSafe key was read or used in these release checks.

## Merged and verified

| Unit | Merged PR | Evidence |
| --- | --- | --- |
| Private standalone release 0.1.0 | [Temari #201](https://github.com/randydinh/temari/pull/201) | Reproducible, digest-checked archive, isolated Mac CLI local-only intake/BM25 citation, zero Jev requests, disable/removal/reinstall path. SHA-256 `8cf8a4598f719ddeba7f7e64a0cf92d2ac54edfa22cb4b86034757b39649a01a`. |
| Successor guard | [Temari #203](https://github.com/randydinh/temari/pull/203) | Requires a higher version for changed release bytes; refused publication leaves no final archive. |
| Registrar upstream reconciliation | [Registrar #7](https://github.com/randydinh/content-registrar/pull/7), [#8](https://github.com/randydinh/content-registrar/pull/8) | Read-only currentness snapshots/page delivery and opt-in bounded Lima PDF route. Registrar full suite 352/352 after #8; PDF checks were synthetic, not live guest extraction. |
| Bundled upstream and private release 0.1.1 | [Temari #205](https://github.com/randydinh/temari/pull/205) | All 33 Registrar payload files match private upstream `d73f626`; no downstream overlays. The trusted 0.1.0 archive advances to a reproducible 0.1.1 archive SHA-256 `6859336960a6eca0c608ad2fb3a276ba8ef0df4df58e48f995ea3081897081b6`. Isolated Mac recipient captured and retrieved one local-only BM25 citation, with zero Jev requests; disable/remove/reinstall preserved the disabled provider. Nx release 12/12 and plugin 2/2. |
| Catalog policy and private release 0.1.2 | [Temari #206](https://github.com/randydinh/temari/pull/206) | The private catalog requests `INSTALLED_BY_DEFAULT`; two identical archives SHA-256 `709783cee705373df1ba1358e0fbba703d305ee13157976e37bbcf801399d583`; Nx release 12/12 and plugin 2/2. On isolated macOS Codex CLI, adding that marketplace left the plugin uninstalled. Explicit add/remove worked. Desktop behavior was not tested. |
| Mac private install helper | [Temari #207](https://github.com/randydinh/temari/pull/207) | Caller-pinned local archive, exact Codex marketplace/plugin state, private receipt bound to Codex home, idempotent install, persistent user removal and explicit reinstall. Focused Nx 7/7; actual isolated Mac CLI cold/idempotent/remove/reinstall passed. It is opt-in and does not run Python setup or a hosted model. |

All seven PRs above report `MERGED`. Temari #205, #206 and #207 merged trees equal their independently reviewed exact-head trees; the earlier PRs have their reviewed/merged pins in the append-only decision log. The three retained release archives were rehashed at handoff and match the values above. The overnight log had 22 data rows before this handoff and now has 24, each with six fields; the mistaken 15:03 UTC event timestamp has an appended 14:53:03 UTC correction without rewriting history. PR attachment requests for #203, #205, #206, #207 and private Registrar #7/#8 were refused by the app because this long chat exceeds 100 attachment identities; the PR links remain in the log and this handoff.

## Next implementation boundary

The installer helper requires an absolute private release archive and external digest. Temari's distribution does not yet bundle that archive, and `temari init` does not invoke the helper. To make Registrar truly default for a supported Temari install, package the reviewed private archive with the distribution, pin its digest, call the helper from initialization, and test first install, repeat initialization, manual removal, explicit reinstall, failure recovery and version upgrades on an isolated Mac. Keep Python setup and TypeSafe credential entry explicit. Preserve the user's uninstall choice; a catalog policy alone did not install the plugin on the tested CLI. Desktop and Windows need their own host evidence. Public redistribution terms remain unresolved even though the current Temari repository is private.

## Production finish predicates still open

1. Independently labeled answer, citation and abstention quality across Nx, non-Nx, mixed documents, no-answer, contradiction and visual cases; compare BM25, graph and Jev on a sealed holdout.
2. Scanned and visual document meaning, with bounded parsers and explicit unsupported cases. Searchable PDF text and media inventories do not prove visual meaning.
3. Recurring source freshness, safe recapture, graph-impact review, authenticated corrections and measured stale-relationship repair over time.
4. Recoverable data, policy, erasure and derived-view lifecycle with measured RPO/RTO and revocation evidence.
5. Default plugin installation and full disconnect/uninstall/reinstall/retention/purge on supported hosts, including actual Windows and desktop evidence.

No unit in this run proves a production lossless knowledge system. The next work should start from merged `origin/main`, not the conflicted primary checkout, and read this handoff plus the append-only decision trail before new implementation.
