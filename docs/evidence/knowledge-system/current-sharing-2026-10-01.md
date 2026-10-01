# Current source sharing pilot — 2026-10-01

The owner selected TypeSafe Jev for registered sources by default unless a
source is marked `local-only`. The source setting now lives in Registrar's
existing registry. Temari's Jev path checks it against the pinned publication
before credential lookup and before every hosted request attempt. An immutable
handoff can deny more sharing than the current setting, never less.

On a copy of the prior three-source pilot state, a fresh intake published all
three selected sources: the Nx Temari tree, a non-Nx Python tree, and selected
documents. An unlabelled BM25 query over the Nx source returned one ranked
archive item and a TypeSafe `jev-1.13.0` judgment, with one attempted request.
The same copied Registrar source was then set to `local-only` without changing
the handoff. A second query still returned one ranked item and verified local
evidence, reported `current-local-only`, and recorded zero Jev request attempts.
The original private pilot state was not changed. Both reports retained
explicit retrieval and capability gaps; this is no claim of complete recall.

Actual Registrar integration also checks current-policy denial for direct and
labeled search, denial before credential lookup, and revocation between 429
and 529 retries. A separate durable two-child job test changes source sharing
after intake and confirms the search child returns `ISSUES` with a truthful
current-policy denial. Unit tests use the production Registrar-backed guard
shape; they distinguish zero outbound attempts from a request attempted before
revocation. The Registrar suite passed 330 tests. The Temari knowledge unit
suite passed 43 tests, typecheck passed, and the full actual-CLI integration
suite passed 53 tests with the final report-time check included.

The policy check precedes each attempted POST, but a revocation cannot retract
a POST already in flight or make a separate registry read and network send
atomic. `local-only` is enforced by the Temari Jev path; Registrar's generic
local CLI/MCP reads remain available. Registrar code changes its implementation
digest, so older archive publications require verified rebind and fresh intake
handoffs before use with this version. Existing live lexical scan receipts may
need `sources refresh` after the Registrar upgrade; retained archives remain
independent of that refresh.
