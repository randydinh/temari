---
name: temari
description: Use Temari as the current Nx conversational engineering entry point with explicit route admission and fail-closed host capability checks.
---

# Temari

Temari is the conversational entry point for the current Nx workflow runtime.

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. The public bundle currently admits only the reviewed `full-playbook` / `feature-v1` mapping with explicit feature obligations.
3. Do not silently downgrade to `lightweight-engineering` or redirect `qa-review` into the feature route. Those routes are explicitly unsupported by this public bundle until their mappings and owners are reviewed.
4. Treat host capability labels as unproven until the host provides independent proof. The bundled experimental bridge currently reports no capabilities, so feature admission is expected to block rather than start a lifecycle.
5. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the installed contract and `bin/temari.mjs admit --request ABSOLUTE_JSON` only as a preflight. A blocked or rejected result is an honest boundary, not a successful run.
