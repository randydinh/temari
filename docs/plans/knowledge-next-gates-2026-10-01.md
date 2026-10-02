# Temari Knowledge: next verified gate

This continuation starts from merged `origin/main` at
`773f8f11aa7cb7fc5d1e1770b6ef56150d89258c` in the clean isolated
worktree. The primary checkout has unresolved conflicts and is outside this
run. The [morning audit](../evidence/knowledge-system/overnight-audit-2026-10-01.md)
remains the baseline for delivered work and open finish predicates.

## Bounded intake and selected route

Poteto `feature-v1` is selected because this changes the graph evaluation
boundary. Its source, verification, independent review and PR obligations
apply. The scope is `libs/knowledge` and the bundled Registrar CLI. The query
was how a reviewed v2 graph root is evaluated after a source recapture, and
what exact evidence would admit its reviewed child. The existing design-only
snapshot at `docs/knowledge-system/graphify-out/graph.json` guided source
selection; it is not a current code graph. No configured Content Registrar
archive of this checkout was available. The direct source selection is
`archive-graph-handoff.ts`, `archive-graph-reviewed-change.ts`, their actual
Registrar tests, and the morning audit. The context budget was these four
implementation/test files plus the audit and selected graph nodes; current
code and CLI behavior establish the result.

## PDF gate

The actual macOS archive worker still reports
`pdf-memory-boundary-unavailable`: Darwin rejected RLIMIT_AS, RLIMIT_DATA and
RLIMIT_RSS at the attempted hard cap. Docker, Colima, Podman, Lima and QEMU
are absent on this host. A pinned local Linux worker with cgroup v2 memory
and swap caps is the preferred route; a remote worker requires a separate
source-sharing design and cannot accept local-only material. A watchdog or
parser-only run does not meet the existing PDF finish condition. Keep this
gate open and preserve the worker's fail-closed behavior.

## Selected child-graph increment

**Hypothesis.** A metadata-only receipt that binds both the reviewed fresh
v2 root and an operator-reviewed child, their private drafts, the exact v2
publication and current registration can let the diagnostic graph trial
evaluate a changed-content link without admitting an arbitrary child graph.

**Finish predicate.** The actual Registrar CLI captures v1, changes a
Markdown document in v2, publishes a reviewed fresh v2 root and a reviewed
child. At equal top-K and lexical input, the root omits the newly linked
target while the child adds it with revalidated archived evidence. Tampered
receipts or drafts, wrong parent or RevisionSet, mismatched generation,
unexpected child delta, bad lexical hash and revoked registration refuse.
The new receipt contains hashes, counts and status only, not source text or
query. The result must leave BM25 lift, semantic correctness, authenticated
review and operational query changes explicitly unclaimed.

**Throughput checkpoint.**

1. Blocking first steps: pin clean main, read current root/child contracts,
   and prove the macOS PDF boundary remains unavailable before choosing work.
2. Independent workstreams: the architect compared the PDF route and graph
   choices read-only; the graph code and its actual-CLI fixture are coupled and
   have one implementation owner; a separate reviewer inspects the integrated
   commit.
3. Shared mutable state: Registrar archive publications and graph drafts are
   immutable, but the integration checkout and decision log have one writer
   each. The code worker owns only `libs/knowledge` files; the coordinator
   owns the run record and PR.
4. Smallest safe decomposition: one bounded child-evaluation API and one
   actual-CLI journey, followed by typecheck, unit and integration Nx targets.

The user policy remains Jev as the only hosted model and registered sources
shareable unless marked local-only. This increment makes no hosted-model call.
It does not close the broader production-losslessness, real-task held-out
quality, refresh scheduling, safe recovery, Windows or plugin-lifecycle gates.
