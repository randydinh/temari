---
name: qa-triage
description: Investigate reported defects and QA failures, separate observed symptoms from causal hypotheses, and produce an actionable analytical handoff. Use for issue triage, not full QA signoff or defect repair.
---

# QA Triage

Use the ordered [issue triage playbook](references/issue-triage-v1.md) for a
reported symptom or an uncertain failure discovered during QA or engineering.
Return the compact [triage note](assets/triage-note.md), with linked evidence
and a concrete next action. Keep distinct issues separate.

This is packaged analytical guidance within existing Temari QA, not an
executable profile, policy entry, evaluator, receipt, or new lifecycle. Temari
owns intent, authority, scope and lifecycle; [Poteto](../poteto-mode/SKILL.md)
owns authorized repair. Investigation does not authorize code changes, tracker
mutations, production operations, or real payments. Use only admitted sources
and permitted reproduction surfaces; project identities, severity scales,
customer facts and environment permissions remain external inputs.

A full QA Review stays a full review when triage helps explain a failure.
Preserve every required scenario, blocked check and independent evaluation
obligation. Triage notes cannot establish ticket acceptance or a QA pass.
For verification notes or project defect formatting, pass the analysis to the
existing [QA verification writer](../qa-review-verification/SKILL.md); do not
create a competing report format or infer permission to publish it.
