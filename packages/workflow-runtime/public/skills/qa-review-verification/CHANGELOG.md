# QA verification changes

## 0.3.3 — 2026-09-29

- Ask for source-backed Content Registrar records and an available codebase graph
  before deriving ticket or implementation context. Preserve their provenance and
  gaps, and check material behavior against the selected candidate and authoritative
  product requirement.
- Keep indexed QA summaries and graph relationships as navigation, not acceptance
  or runtime proof.

## 0.3.2 — 2026-09-29

- Write Verified Behavior as concise, observable outcomes, grouped by area where useful;
  retain boundary, candidate and evidence attribution.
- Add a non-duplicative optional Before/After Change Summary and label reported,
  reproduced, observed and expected behavior accurately.
- Keep in-scope failures and acceptance gaps prominent; do not recast them as optional
  Additional Observations.
- Add a readability check alongside the existing evidence and disposition checks.

## 0.3.1 — 2026-09-29

- Label ticket/requirements-only work as Documentation review only. Reserve Source
  review only for actual implementation review without execution.
- Preserve attributed execution reports separately from the current author's review
  boundary. Reading a documented expectation does not establish a runtime result.
- Record a fixed-input author comparison with visible unchanged outputs; no independent
  quality gain or new product verification is claimed.

## 0.3.0 — 2026-09-29

- Bundle the verification writer and all three templates in the Nx public artifact.
- Connect Temari and Poteto verification/handoff requests to the bundled writer.
- Preserve canonical QA record identity, blocked/narrow dispositions, and evaluator
  requirements when rendering notes. Document drafting grants no runtime admission.
- Retain the 0.2.0 compact format, verification-depth rationale, bug-fix comparison,
  evidence attribution, and exact reviewer-label filtering.
- Keep product navigation, real ticket examples, and personal reviewer defaults in
  private overlays. Maintain generic trials in the monorepo.

## 0.2.0 — source baseline

The standalone writer introduced compact Scope / Verified Behavior / Additional
Observations / QA Status comments, proportional verification rationale, and explicit
before-fix / after-fix / control evidence. This Nx port carries those behaviors
forward; its history starts with the integration commit in this repository.
