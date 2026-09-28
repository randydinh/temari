---
name: temari
description: Use Temari as the current Nx entry point for pinned lightweight engineering and the versioned QA domain route.
---

# Temari

Temari is the conversational entry point for the current Nx workflow runtime.

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. The installed bundle admits `lightweight-engineering-v1` only when every lightweight condition holds and its fixed obligations match.
3. The lightweight source requirements map to all six canonical stages. Review and deliver remain mandatory, and publish still requires operator approval.
4. Use `bin/temari.mjs qa` for a full QA assignment. The route fixes independent review, revision-bound evidence, a six-stage plan, and read-only actions. It freezes the review input allowlist. The bundled host cannot launch a separate evaluator, so the installed route records a BLOCKED attempt and no evaluator round.
5. Treat host capability labels as unproven until the host provides independent proof. Full feature remains blocked. The bundled bridge reports no capabilities.
6. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. The entry forwards stage dialogue to the canonical host bridge. A blocked or rejected result is not a successful run.

For QA, pass a versioned full assignment, an unexecuted review draft, and the canonical invocation to `bin/temari.mjs qa` with the same external request and artifact digest flags. The result retains a QA disposition separately from the workflow receipt. A caller-supplied evaluator ID, round, context claim, or capability list is rejected.
