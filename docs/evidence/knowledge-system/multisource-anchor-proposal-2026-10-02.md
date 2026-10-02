# Multi-source anchor proposal, 2026-10-02

## Scope

PR #164 can identify unchanged graph records after A changes while B remains
on the same retained generation. This Knowledge-only proposal recomputes the
content-addressed impact receipt and checks each candidate anchor against
Registrar's retained text. An A anchor targets A v2; a B anchor targets the
identical pinned B v1. A source-aware receipt records original, representation,
span and quote hashes without source text. It computes the expected A v2+B v1
RevisionSet ID, but publishes no graph.

The run plan compared this bounded proposal with direct graph publication and
BM25 caching. Publication needs separate operator selection and replay rules;
caching changes Registrar storage and requires a latency benchmark.

## Actual Registrar fixture

The fixture explicitly sets A and B to `local-only`, captures A v1 and B v1,
publishes their exact graph and retracts one assertion. It changes A and
captures A v2. A stable node, B stable node and a cross-source relationship
with both verified endpoints become eligible. A B anchor over 2,048 code
points is deferred, its dependent relationship is deferred, and a
`supersedes` assertion is deferred. Changed A records remain in the impact
review queue; the retraction stays historical. A v1+B v1 still reads, while
the old graph refuses under A v2+B v1.

The test refuses a tampered impact receipt, tampered B publication, disabled
B registration and corrupted retained B representation bytes. Repeated calls
produce the same content-addressed proposal path. All candidates are placed
in exactly one eligible or deferred queue. The receipt says `proposal-only`,
`graphMutation: none`, `afterGraphId: null`, and
`currentOriginal: not-checked`.

## Verification and limits

The focused actual Registrar case passed 1/1; the uncached full Nx Knowledge
integration suite passed 96/96. Knowledge unit tests passed 43/43, and
typecheck, Nx sync, formatting and diff checks passed. Independent read-only
candidate review found no must-fix issue; exact-head package checks remain
pending. The adapter bounds inputs to the exact
2–8-source graph, 64 candidate records, 128 unique anchors, 1–2,048 code
point spans, 1,500 graph records and a 1 MiB receipt. Source admission,
publication, diff, impact and old graph pins are rechecked before emission.
No hosted model call or credential read occurs.

This proposal does not repin or publish an active graph, establish semantic
correctness, infer transitive effects, prove live currentness, improve measured
retrieval, or close production losslessness and PDF visual-coverage gates.
