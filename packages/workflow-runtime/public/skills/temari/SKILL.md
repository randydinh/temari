---
name: temari
description: Use Temari as the current Nx engineering entry point with a pinned lightweight route, versioned QA domain route, and local Codex worker utility.
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

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. The installed bundle admits `lightweight-engineering-v1` only when every lightweight condition holds and its fixed obligations match.
3. The lightweight source requirements map to all six canonical stages. Review and deliver remain mandatory, and publish still requires operator approval.
4. Use `bin/temari.mjs qa` for a full QA assignment. The route fixes independent review, revision-bound evidence, a six-stage plan, and read-only actions. It freezes the review input allowlist. The bundled host cannot launch a separate evaluator, so the installed route records a BLOCKED attempt and no evaluator round.
5. For independent local Codex workers, follow the bundled [parallel worker guide](../poteto-mode/references/codex-parallel-workers.md). The public `run-workers` command launches a builder and separate reviewer with retained host observations. Those observations are not yet bound to a full-feature lifecycle receipt or forge delivery.
6. Treat host capability labels as unproven until the host provides independent proof. Full feature admission and QA execution remain blocked; the lifecycle bridge reports no capabilities.
7. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. The entry forwards stage dialogue to the canonical host bridge. A blocked or rejected result is not a successful run.

For QA, pass a versioned full assignment, an unexecuted review draft, and the canonical invocation to `bin/temari.mjs qa` with the same external request and artifact digest flags. The result retains a QA disposition separately from the workflow receipt. A caller-supplied evaluator ID, round, context claim, or capability list is rejected.
