# Unlabelled archive query pilot, 2026-10-01

## Result

The new `journey-query` command ran once against a registered source in the
pinned mixed-source Registrar handoff. BM25 returned one document and its
retained first excerpt passed archive revalidation. The Keychain-backed
TypeSafe call returned one typed `jev-1.13.0` shadow judgment. The Jev result
did not change the BM25 order or add unsupported evidence. The private query,
source ID, file path, excerpt, handoff and report remain outside Git.

The report contains no expected gold path, recall score, graph trial or Jev
`required` flag. It records three explicit gaps from the archive/query path;
verified shortlist status applies only to the returned document. The source
was registered for hosted sharing and was not marked local-only.

## Verification and limits

Temari knowledge typecheck and all 38 Registrar-backed integration tests
passed on the final candidate. Tests cover unlabelled discovery, a synthetic
Jev response, local-only denial, and misspelled privacy fields rejected before
any hosted call. The labeled evaluation command retains its existing metrics
and graph trial, with the same strict privacy input validation.

This is a single-run operation. A retry after an ambiguous failure can repeat
a TypeSafe call; the planned runtime child-task coordinator must own claims,
leases and replay. Even with a lease, a crash after a provider response but
before durable completion can repeat that call. No exactly-once billing claim
is made.
