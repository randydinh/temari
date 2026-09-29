---
name: temari
description: Use Temari as the current Nx conversational engineering entry point with pinned lightweight and host-proven feature routes.
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
2. Route engineering requests through the canonical Temari route table. Admit `lightweight-engineering-v1` only when every lightweight condition holds. A trusted `full-playbook`/`feature-v1` start requires the host to run a read-only architect, scoped builder, and independent reviewer, then prove forge access and bind their retained evidence to the selected invocation.
3. Both admitted profiles map source requirements to all six canonical stages. Feature delivery must identify an open pull request in the selected repository whose head matches the verified integration commit. Publish still requires operator approval.
4. For local Codex workers and the feature request shape, follow the bundled [parallel worker guide](../poteto-mode/references/codex-parallel-workers.md). The standalone `run-workers` command remains available for a builder and separate reviewer. QA execution admission remains blocked.
5. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. The entry forwards stage dialogue to the canonical host bridge. A blocked or rejected result is not a successful run.
