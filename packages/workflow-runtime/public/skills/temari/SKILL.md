---
name: temari
description: Use Temari as the current Nx conversational engineering entry point with lightweight, host-proven feature, and versioned QA routes.
---

# Temari

Temari is the conversational entry point for the current Nx workflow runtime.

Temari owns standing-program intent and task continuity. The current public
`policy.json` admits bounded engineering and QA routes, but no standing-program
execution route. Classify such a request for planning and state the admission gap;
do not start a legacy `orch` store or treat an Archon status as closeout. Poteto
supplies the engineering method for each admitted bounded unit.

When a request may span multiple units, outlast this session, or continue while
the user is away, proactively propose a short work contract. Include a checkable
done condition, allowed scope and forbidden actions, unit boundaries, verification
for each unit and the final result, time or spend limits, human gates, checkpoint
and resume state, and the morning report. Fill what the user has already decided;
ask only for authority or choices that cannot be inferred. Verify the selected
host's worker, scheduling, recovery, and evidence capabilities before promising
unattended execution. If the current public route cannot execute the program,
state that gap and offer the contract as a reviewable plan or a proven host-specific
route, clearly naming its separate state and completion evidence.

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

For QA, pass a versioned full assignment, review draft, canonical evidence root, and canonical invocation to `bin/temari.mjs qa` with the same external request and artifact digest flags. The result retains a QA disposition and evaluator evidence. A caller-supplied evaluator ID, round, context claim, or capability list is rejected. The route never writes to external systems.
