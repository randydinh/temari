---
name: poteto-mode
description: Use the current Nx P-stack engineering workflow with reviewed feature admission and no silent lightweight fallback.
---

# Poteto mode

Poteto mode supplies the engineering workflow selected by Temari.

1. Read `policy.json` from the installed bundle root and announce the selected route briefly.
2. This public bundle admits only the reviewed `feature-v1` profile on the `full-playbook` route. Keep the feature obligations intact: required delegation, independent review, revision-bound evidence, and pull-request delivery.
3. Never treat the legacy lightweight profile as an equivalent mapping. It is refused until a reviewed compatibility mapping exists.
4. Delegation, forge access, worktree isolation, and parallelism are host capabilities. Caller-authored labels do not prove them; the current experimental bridge reports none.
5. Keep one lifecycle owner: the canonical runtime/store owns scheduling, persistence, recovery, and evidence. This skill only routes and admits work.

Use `bin/poteto-mode.mjs policy` to inspect the contract and `bin/poteto-mode.mjs admit --request ABSOLUTE_JSON` for a bounded preflight. A blocked result must remain blocked until host capability evidence exists.
