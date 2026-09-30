# QA verification changes

## 0.7.2 — 2026-09-30

- Record impact, severity, affected scope, reachability, and fix priority as
  separate judgments for supported failures.
- Preserve ambiguous product intent and potential user-experience improvements
  without silently turning either into a confirmed defect.

## 0.7.1 — 2026-09-30

- Route an explicit full QA Review request through the ticket acceptance playbook
  and installed evaluator even when acceptance fixtures or decisions are missing.
- Keep an unadmitted route and its exact missing input visible; do not relabel a
  full-review request as evidence-only drafting or imply an evaluator ran.
- Derive ticket selection from each request without a standing reviewer filter;
  distinguish sprint planning and defect triage from acceptance signoff.

## 0.7.0 — 2026-09-29

- Package the local QA evaluator and its worker in the installed Temari artifact.
- Route a full, versioned QA assignment through the installed evaluator with an
  existing canonical local evidence store; retain the evaluator output and final
  disposition in the local run.
- Keep external writes denied and reject caller-supplied evaluator claims.

## 0.6.0 — 2026-09-29

- Carry the full-review scenario inventory and all eleven area decisions without
  turning scenario count into a quota or a writing-only note into completion.
- Prefer user-facing functional checks where suitable, with a nonproduction
  integration or controlled failure check for behavior a UI flow cannot prove;
  provide a runnable manual handoff when execution remains external.
- Preserve Testmo case before-images, corrected associations, readbacks and prior
  run history when an expected result or automation mapping was wrong.
- Verify a baseline actually contains the behavior before claiming a regression,
  and capture actionable Registrar/graph corrections when context is stale.
- Preserve target-profile identity, permission and safe evidence boundaries for
  browser checks; distinguish proposed scenarios, generated tests and observed
  attempts, and triage ambiguous failures before calling them product defects.
- Permit a requirement-backed regression test to fail on the broken baseline
  and pass on the repaired candidate; preserve both attempt results.
- Require a revisioned product-intent baseline and independently derived oracles;
  retain missing capabilities and preexisting rule violations even when current
  code and tests agree, with conflicts explicit until resolved.
- Render confirmed developer defects in the selected project's exact bug template;
  keep missing fields and uncertain severity explicit instead of replacing the
  tracker standard with a QA note or custom report.

## 0.5.0 — 2026-09-29

- Establish specification examples and resolve conflicting product rules before
  changing cases or automation.
- Put ticket, case revision, automation identity, and actual run/result in the
  scenario matrix; verify authorized case writes by readback.
- Check the oracle, fixture realism, observation boundary and normal control before
  presenting a finding as a confirmed bug; keep blocked prerequisites distinct.
- Check authorized QA fixture creation before labeling a required scenario blocked.
- Preserve the user's note-review gate and the separate comment and Done transition.
- Identify repository, source and target branch, pull request and test ownership for
  cross-repository QA changes.
- Require actual automated or manual coverage for a Passed QA record; a case
  definition or gap binding alone cannot supply executable coverage.

## 0.4.0 — 2026-09-29

- Make the product or business outcome and its authoritative source explicit for each
  ticket before comparing code or test output.
- Require a scenario-level evidence link for a full ticket decision, including actual
  execution, Testmo case and run identities, and unresolved acceptance boundaries.
- Turn blocked results into executable handoffs and use the owner's established bug
  format for confirmed developer-facing defects.
- Keep evidence-only writing visibly separate from a requested full QA Review.

## 0.3.3 — 2026-09-29

- Within admitted source scope and bounded queries, use configured Content
  Registrar records and an existing codebase graph when available. Preserve their
  provenance and gaps, and check material behavior against the selected candidate
  and authoritative product requirement.
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
