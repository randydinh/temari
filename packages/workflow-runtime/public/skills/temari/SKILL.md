---
name: temari
description: Use Temari as the current Nx conversational engineering entry point with lightweight, host-proven feature, and versioned QA routes.
---

# Temari

Temari is the conversational entry point for the current Nx workflow runtime.

When the requested output includes ticket verification notes, a QA evidence audit,
or a release QA report, use the bundled
[QA verification skill](../qa-review-verification/SKILL.md) for that deliverable.
Carry the user's reviewer-label filter into evidence selection before opening ticket
details. Reuse canonical QA records and preserve their scope and disposition.
Evidence-only drafting produces a local document; it does not admit a QA execution
route or complete its review obligations. Test-case authoring alone and generic code
review keep their existing routes.

## Bounded codebase context intake

After reading the installed policy and identifying the selected repository and
candidate, use context providers only within the admitted task authority. When a
Content Registrar source is configured for that scope, select a bounded query and
documents, then read relevant source-backed requirements and product decisions.
When an existing knowledge graph covers the admitted repository and candidate,
query affected components, callers, and boundaries before broad file exploration.
Record the source scope, query, selection, budget, revisions or graph snapshot,
useful citations, and coverage gaps. Treat graph relationships and indexed
summaries as navigation; verify material claims against the current ticket,
document, and source. A provider is optional and does not decide a QA disposition
or expand the task's authority. If it is unavailable, stale, or lacks the needed
corpus, state the gap and continue with scoped direct inspection. Do not silently
substitute an old candidate, widen source access, or build a new graph as part of a
read-only task.

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. Admit `lightweight-engineering-v1` only when every lightweight condition holds. A trusted `full-playbook`/`feature-v1` start requires the host to run a read-only architect, scoped builder, and independent reviewer, then prove forge access and bind their retained evidence to the selected invocation.
3. Both admitted profiles map source requirements to all six canonical stages. Feature delivery must identify an open pull request in the selected repository whose head matches the verified integration commit. Publish still requires operator approval.
4. For local Codex workers and the feature request shape, follow the bundled [parallel worker guide](../poteto-mode/references/codex-parallel-workers.md). The standalone `run-workers` command remains available for a builder and separate reviewer.
5. Use `bin/temari.mjs qa` for a full QA assignment. The route fixes independent review, revision-bound evidence, a six-stage plan, and read-only actions. It freezes the evaluator input allowlist and launches the bundled evaluator in a separate local process. The invocation supplies an existing local `evidenceRoot`; a passed scenario must retain its canonical execution evidence there.
6. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. Engineering entries forward stage dialogue to the canonical host bridge; the QA entry invokes the packaged local evaluator. A blocked or rejected result is not a successful run.

For a selected durable engineering task, follow [task tracking](references/task-tracking.md)
to retain the actual conversation, recovery point and outcome automatically.
Select the task explicitly, preserve its current version, and keep tracking outside
the execution request. Feature tracking uses the original project scope while
the host verifies the integration checkout. A handoff never establishes completion.

For QA, pass a versioned full assignment, review draft, canonical evidence root, and canonical invocation to `bin/temari.mjs qa` with the same external request and artifact digest flags. The result retains a QA disposition and evaluator evidence. A caller-supplied evaluator ID, round, context claim, or capability list is rejected. The route never writes to external systems.

The QA request may pin `review.intentSources` as requirement reference, revision, authority reference, and expected outcome. It may select `review.projectVerifierId: "temari-public-v1"` only for a matching Temari workspace candidate. The installed entry loads the ticket acceptance playbook, QA evidence skill, and selected verifier text into a digest-bound handoff; `guidance.execution: "not-observed"` means no verifier was run by that loading step. The bundled local worker checks procedural evidence but has no independent product-intent or assertion-adequacy assessor, so it cannot produce a full QA pass. Retain the `BlockedOrIncomplete` result until a trusted semantic evaluator and the applicable project control actually run.

For the registered `temari-public-policy-v1` execution profile, select a separately
relocated, manifest-pinned product artifact and an eligible current task. Add
`--qa-execution-selection ABS_JSON --expected-qa-execution-selection-sha256 HEX`
and the explicit task-tracking pair to `qa`. The selection fixes the named profile,
task, product manifest and environment; it cannot supply commands, proof, expected
values or evaluator identities. The host executes the actual CLI policy command
and launches the finite policy assessor in a separate process. This verifies the
advertised Temari QA owner, read-only contract and capability-admission contract;
it does not verify other applications or arbitrary natural-language requirements.

The canonical runtime executes and retains the six stages. Inspect both its
mechanical receipt and the QA disposition: a completed evaluation can report
`Failed` or `BlockedOrIncomplete` even when its workflow receipt is `PASS`.
The task outcome retains the exact QA record/proof and receipt for independent
review. Task tracking records context and does not complete a canonical TaskRun.
The host first proves its fixed worker transport with the frozen NotRun draft;
that unresolved capability probe admits only this QA host's `subagents`. It is
separate from product proof and admits no general model, Codex, forge or parallel
capability. Resume verifies the original retained probe.

Use `qa-resume` for a nonterminal checkpoint with the same trusted inputs and a
fresh task tracking key/current version. Delivery retains canonical QA record
and proof before terminal persistence. Use `qa-result` with the same full pinned
flag pairs and a fresh task key/current version to recover local result
publication from a completed mechanical PASS. The reader verifies original
capability capture, all four stores, unchanged candidate and delivered record;
it launches no controls and never overwrites a different result. Non-deliver
terminal outcomes, drift and orphan stages remain refused. Other product
profiles retain the unavailable disposition.
