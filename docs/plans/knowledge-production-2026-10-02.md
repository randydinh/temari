# Temari Knowledge production completion

Started 2026-10-02 from merged `origin/main` `c7a574660c87a0c2663684c69b3c3d41ffccea7b` in the isolated worktree. The prior overnight run and its audit remain closed. This plan tracks the user's request to finish the system; each increment is separately reviewable, while the system finish predicate remains open until all gates below have evidence.

## Boundaries

- Direct TypeSafe Jev is the only hosted model. Registered sources may be sent unless marked local-only. Do not inspect the Keychain key during local work.
- Keep the original bytes, revision pins, source scope and explicit unsupported-modality gaps. A local test cannot stand in for a production or Windows result.
- Use the isolated checkout. Do not alter the conflicted primary checkout.
- P-stack capability index is absent in this checkout, so do not alter a P-stack execution boundary without its required audit.
- Each unit needs a hypothesis, artifact, focused verification, keep/revert decision and remaining finish predicate in `.audit/knowledge-production-2026-10-02.tsv`; implementation requires independent review and a verified, clean PR.

## Production finish gates

1. Representative, independently labeled answer, citation and abstention quality for Nx, non-Nx and mixed documents, including no-answer, contradiction and visual cases. Measure BM25, graph and Jev contribution on a sealed holdout.
2. Scanned, visual and mixed-format meaning with bounded parser behavior and explicit gaps when unsupported.
3. Recurring source freshness, safe idempotent recapture, graph-impact review and authenticated graph corrections. Demonstrate precision, recall and stale-relationship repair over time.
4. Atomic or otherwise proven recoverable data, policy, erasure and derived-view lifecycle, with measured RPO/RTO and revocation checks.
5. Default plugin installation, disconnect, uninstall, reinstall, retention and purge on supported hosts, including actual Windows evidence.

## First dependency chain

The existing due-gated source audit returns `recapture-needed` but does not initiate capture. The current operator recapture API checks that a binding is unused. If Registrar commits capture and Temari fails to persist a complete result **after its publication**, the result needs a separate reconciliation API. The first increment reconstructs only that missing Temari result from a caller-pinned, complete local publication and a current Registrar inspect. A prior replay design was rejected because replay could become a new capture if Registrar state changed between checks. Crashes before publication remain a separate gap. Then connect a pinned audit to recapture and graph-impact review, then add a real recurring trigger with source-level serialization. None of those increments alone proves live currentness or automatic graph correctness.

Human-labeled questions and an accessible Windows host were requested asynchronously. Continue independent source-lifecycle work while those gates are unresolved.

## Next unit option comparison

Extending the existing freshness job to capture on `recapture-needed` would change the meaning of its persisted one-shot spec and terminal `ISSUES` state. Calling recapture directly after reading the audit has no durable claim or restart boundary. Prefer a separately persisted, linked recapture child job that pins the completed freshness stage/audit, prior publication and old graph, and exposes a review-needed impact receipt. It must use a deterministic request key, refuse unknown attempts before publication, and never publish graph changes. The first version can serialize ticks of one spec; source-wide serialization across distinct specs and a real recurring trigger are separate required units.

The first recovery increment merged as [#191](https://github.com/randydinh/temari/pull/191) with a matching reviewed/merged tree. Its result reconstruction requires a complete publication. The linked child job must renew its lease during ordinary capture and verify fencing before publishing a stage. A stale worker cannot certify the job even if Registrar completed capture. A fixed task ID for source and prior publication rejects competing specs for that prior generation. A later source-head ledger remains necessary to serialize different prior generations.

For the following unit, repeated invocation of fixed one-shot specs is insufficient for recurrence. Compare a long-lived internal poller with a host-triggered one-cycle reconciler. Prefer a runtime-owned source-head compare-and-swap ledger and reconciler first: reserve against an exact current publication, advance only after a complete recapture handoff, and pause on unknown, revocation or conflict. Then install and observe a host trigger across due intervals. The absent P-stack capability index prevents assuming an execution-boundary change is admitted; first restore its required context or keep this as a read-only design. Neither step alone proves live currentness or graph semantics.

Read-only audit found an unmerged [PR #118](https://github.com/randydinh/temari/pull/118) containing the missing P-stack index, graph and generator. Its September 30 inventory is stale relative to merged main and the PR also changes runtime and skills. Do not merge it wholesale for this prerequisite. Restore and revalidate only the audit artifacts in a dedicated documentation increment before any runtime scheduler or installer boundary change.
