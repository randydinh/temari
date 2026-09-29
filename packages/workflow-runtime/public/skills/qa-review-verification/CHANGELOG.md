# QA verification changes

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
