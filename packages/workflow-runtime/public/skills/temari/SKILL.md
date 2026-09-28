---
name: temari
description: Use Temari as the current Nx conversational engineering entry point with a pinned lightweight route and fail-closed host capability checks.
---

# Temari

Temari is the conversational entry point for the current Nx workflow runtime.

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. The installed bundle admits `lightweight-engineering-v1` only when every lightweight condition holds and its fixed obligations match.
3. The lightweight source requirements map to all six canonical stages. Review and deliver remain mandatory, and publish still requires operator approval.
4. Treat host capability labels as unproven until the host provides independent proof. Full feature and QA routes remain blocked. The bundled bridge reports no capabilities.
5. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. The entry forwards stage dialogue to the canonical host bridge. A blocked or rejected result is not a successful run.
