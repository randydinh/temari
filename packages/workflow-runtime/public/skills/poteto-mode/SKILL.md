---
name: poteto-mode
description: Use the current Nx P-stack engineering workflow with pinned lightweight and host-proven feature admission.
---

# Poteto mode

Poteto mode supplies the engineering workflow selected by Temari.

For ticket verification notes, QA evidence audits, and release QA reports requested
during verification or handoff, load the bundled
[QA verification skill](../qa-review-verification/SKILL.md). Default ordinary ticket
comments to its compact template, preserve the current request's ticket-selection
constraints, and derive conclusions from the candidate-bound evidence. Keep
canonical QA records, independent review requirements, and blocked or narrow
dispositions intact.
This supporting writer also handles evidence-only local drafts; it does not admit
QA execution or convert a document into a runtime receipt. Test-case authoring
alone, code review, and defect repair retain their existing owners.

For work on an existing codebase, read the installed policy, then apply the
[Temari bounded codebase-context intake](../temari/SKILL.md) within the admitted
source scope before broad investigation. Registrar and graph results guide source
selection; current candidate code and requirements establish behavior. Retain an
explicit gap when a configured context source is unavailable or stale.

1. Read `policy.json` from the installed bundle root and announce the selected route briefly.
2. Admit the pinned `lightweight-engineering-v1` mapping only when every source route condition is true. A trusted `full-playbook`/`feature-v1` start requires host proof from a read-only architect, scoped builder, independent reviewer, and forge access. Preserve all six canonical stages.
3. The source final, commit, and review boundaries include every requirement for the selected profile. Feature delivery requires an open pull request at the verified integration commit. Publish requires separate operator approval. A PASS receipt does not grant it.
4. For feature worker execution, use the selected host adapter to collect independent architect, builder, and reviewer evidence. Full QA uses the Temari QA route's packaged separate evaluator and canonical local evidence store; it remains read-only for external systems.
5. Keep one lifecycle owner: the canonical runtime/store owns scheduling, persistence, recovery, and evidence. This skill only routes and admits work.

Use `bin/poteto-mode.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. A blocked result stays blocked until its missing proof exists.
