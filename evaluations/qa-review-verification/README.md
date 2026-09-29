# QA verification writer trials

Keep prompts, sanitized evidence, actual outputs, and assessments here when changing
`packages/workflow-runtime/public/skills/qa-review-verification/`. Follow the bundled
[maintenance workflow](../../packages/workflow-runtime/public/skills/qa-review-verification/references/maintenance.md).

The [0.3.0 integration trial](v0.3.0-integration.md) is an author self-review of
synthetic evidence. It establishes example behavior, not independent model quality
or a completed full QA execution route. For subsequent changes, replay its prompts
with the same evidence and save both versions' actual outputs and observed differences.

The [0.3.1 documentation-boundary trial](v0.3.1-documentation-boundary.md) retains
the fixed-input outputs and adds explicit documentation/source boundary examples.
The correction removes an ambiguous instruction; it does not claim that previously
correct notes became better or that additional evidence came from the writer change.

The [0.3.2 behavior-first style trial](v0.3.2-behavior-first-style.md) compares
synthetic successful behavior, missing evidence, and a nearby request that retains
its existing owner. It measures no independent model-quality gain.

The [0.3.2 behavior-first style trial](v0.3.2-behavior-first-style.md) compares
synthetic success, missing-evidence and nearby-owner examples, focusing on readability
without relaxing evidence or disposition rules.
