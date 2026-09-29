---
name: poteto-mode
description: Use the current Nx P-stack engineering workflow with pinned lightweight admission and local Codex parallel workers.
---

# Poteto mode

Poteto mode supplies the engineering workflow selected by Temari.

For ticket verification notes, QA evidence audits, and release QA reports requested
during verification or handoff, load the bundled
[QA verification skill](../qa-review-verification/SKILL.md). Default ordinary ticket
comments to its compact template, preserve the user's reviewer-label filter, and
derive conclusions from the candidate-bound evidence. Keep canonical QA records,
independent review requirements, and blocked or narrow dispositions intact.
This supporting writer also handles evidence-only local drafts; it does not admit
QA execution or convert a document into a runtime receipt. Test-case authoring
alone, code review, and defect repair retain their existing owners.

1. Read `policy.json` from the installed bundle root and announce the selected route briefly.
2. Admit the pinned `lightweight-engineering-v1` mapping only when every source route condition is true. Preserve its fixed serial obligations and all six canonical stages.
3. The source final, commit, and review boundaries include every lightweight requirement. Publish requires separate operator approval. A PASS receipt does not grant it.
4. For independent local Codex workers, follow the bundled [parallel worker guide](references/codex-parallel-workers.md). Its router selects read-only reports or scoped write integration from the assignments. The public `run-workers` command launches a builder and separate reviewer and retains host observations. Those observations are not yet bound to a full-feature lifecycle receipt or forge delivery, so full feature and QA admission remain blocked. The current lifecycle bridge reports no capabilities.
5. Keep one lifecycle owner: the canonical runtime/store owns scheduling, persistence, recovery, and evidence. This skill only routes and admits work.

Use `bin/poteto-mode.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. A blocked result stays blocked until its missing proof exists.
