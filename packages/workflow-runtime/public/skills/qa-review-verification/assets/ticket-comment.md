# QA verification — {{ticket ID}}

Use concise bullets under these four core sections. Add the optional Change Summary only
when it explains a meaningful behavior change without repeating Scope or Verified Behavior.
Omit non-applicable bullets; retain unknown required facts and material limits. Proposed
checks belong under Additional Observations.

## Scope

{{Change or original failure; affected behavior and relevant variants.}}

- Context: {{environment + candidate/build or unknown; relevant role/device/protocol; execution or historical note date}}
- Selection: {{ticket link + requested reviewer-label membership; use a linked scope record if available}}
- Verification depth: {{level + brief risk-based reason; reported scope/unknown rationale for historical notes}}

## Change Summary (optional)

**Before:** {{reported or reproduced prior behavior, with attribution.}}
**After:** {{observed result, or identify this as an expectation if not observed.}}

## Verified Behavior

- Group related outcomes under short behavior-area headings when useful. Write the observable system behavior first, then its boundary, candidate, scoped result and evidence link. Attribute reports; do not turn QA actions into a behavior claim.
- {{Bug fixes only: before-fix reproduction or reported failure → same scenario after fix → relevant normal/control result. Identify absent evidence rather than filling it in.}}

## Additional Observations

{{Material failure, omitted variant, missing evidence, requirement decision or cleanup item;
effect on acceptance and next action. Link detailed evidence/Testmo case and actual run
separately when inspected; keep proposed checks distinct from observed behavior. Keep an
in-scope failure or blocker visible in Verified Behavior and QA Status; do not bury it as
an optional follow-up.}}

## QA Status

**{{Scoped disposition}}** — {{what the evidence establishes and what remains required}}.
{{Keep existing workflow/approval separate when it differs or evidence is missing.}}
