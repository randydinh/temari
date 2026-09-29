# QA playbooks for Temari

Design recommendation, 2026-09-29. This document proposes architecture and acceptance checks. It does not install a QA agent or admit a new runtime route. The user clarified that “workbooks” meant **playbooks**, organized like P-stack.

## Recommended architecture

Use one QA domain entry point that selects a task playbook. Each playbook loads reusable skills when its steps need them. Temari owns routing and the canonical run; Poteto owns engineering work. This follows P-stack's mode → playbook → situational skill structure.

```mermaid
flowchart TD
    U[Standalone QA request] --> T[Temari]
    P[Poteto engineering run] -->|Named candidate and QA assignment| Q[QA domain entry]
    T --> Q
    Q --> B[Select QA playbook]
    B --> S[Load required skills for the current step]
    S --> A[Project profile and tool adapters]
    A --> E[Canonical evidence and QA record]
    E --> V[Independent evaluator when required]
    V -->|Scoped disposition| T
    V -->|Verification result| P
    B -->|Bounded implementation or repair request| P
    P -->|New candidate to verify| Q
```

The QA agent is the role executing this workflow. A playbook is an ordered task recipe with entry conditions, branches, outputs, and completion criteria. A skill is a reusable capability. An adapter connects that capability to a project or tool. These do not each require a separate autonomous agent.

### What follows P-stack

- A small entry point chooses an explicit playbook and records its steps.
- Each step names the skill or reference it needs, its expected output, and a meaningful skip condition.
- Shared principles and capabilities have one owner. Playbooks compose them instead of repeating instructions.
- Project knowledge lives in a bounded profile and feature map; control adapters supply actual execution.
- Completion depends on evidence for the requested outcome.

### What stays specific to Temari

Keep the existing six-stage runtime, admission policy, revision-bound evidence, QA disposition, and independent evaluation rules. Do not import Cursor automation APIs, model names, blanket external-write permission, or a second scheduler from upstream P-stack. Runtime stages organize the run; QA playbooks describe the domain work inside them.

## Product and business intent determine correctness

The user made this a first-class requirement: the implementation may violate the product's requirements and must be scrutinized accordingly. Every QA playbook must carry the relevant intended outcome and its source into planning, execution, and judgment. Code, current UI behavior, existing tests, and a previous release are observations of implementation; none independently establishes the expected product behavior.

### Establish the expected-behavior baseline

Before selecting assertions, identify the smallest relevant set of:

- User or business outcome, affected actor, and why the outcome matters.
- Requirement, acceptance criterion, domain rule, or approved product decision, with source and revision.
- Preconditions, permissions, important state transitions, and invariants that must remain true.
- Observable success/failure criteria, including data effects and measurable quality constraints where specified.
- Assumptions, conflicting requirements, missing decisions, and the owner who can resolve them.

Do not impose one universal ranking on every document. Record which product authority applies to this scope, including approved changes that supersede old requirements. A report's expected behavior is a claim to investigate; QA should check both the reported observation and the proposed expectation. Label inferred rules as hypotheses. When intent is ambiguous, preserve the gap and continue checks that do not depend on it. Do not invent a rule, declare the implementation correct, or silently change acceptance criteria to unblock a pass.

This baseline can be a concise referenced section of the existing requirement artifact. It does not require another project-wide specification or parallel ledger. Refresh the affected expectations when product intent changes and retain the prior revision and rationale.

### Decide what to test from outcomes and risks

Create the initial scenario set from intent before using current code structure to add implementation risks. For each important outcome, examine applicable categories:

| Product question                                                        | Useful test design                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Can the actor complete the intended job and obtain the promised result? | A representative journey with independent expected results, including persisted data or downstream outcomes where relevant.                                                                            |
| Are business rules and boundaries enforced?                             | Equivalence classes, boundary values, decision tables, and independently calculated results.                                                                                                           |
| Are actions correct for each role, tenant, and lifecycle state?         | Permission matrices and state-transition scenarios, including denied and invalid transitions.                                                                                                          |
| Is data correct across retries and integrations?                        | Persistence/readback, duplicate requests, ordering, partial failures, reconciliation, and recovery when applicable.                                                                                    |
| Does the product behave usefully under failure or degraded conditions?  | Deliberate error inputs or controlled fault injection with justified expectations for recovery and user-visible state.                                                                                 |
| Is required behavior missing from the implementation?                   | Requirement-to-capability coverage review followed by an observable attempt where possible. Preserve missing behavior as a gap or defect; do not drop it because no existing screen or test covers it. |
| Are important qualities met?                                            | Accessibility, latency, throughput, compatibility, or other measurements against an applicable stated criterion.                                                                                       |

Select by business impact, likelihood, changed dependencies and uncertainty. A comprehensive inventory of implemented controls is not complete requirement coverage. Test count, line coverage and a green pipeline do not establish that the intended outcome is satisfied.

### Decide how to test each claim

Use the least costly reliable method that observes the required behavior. Pure business rules often fit unit or property tests; service contracts and stored effects fit API/integration tests; critical user journeys need UI/end-to-end checks; exploration can uncover unanticipated gaps. Combine levels where one cannot establish the whole claim. Do not require a browser for every requirement or replace a user-visible claim with a source-code check.

For every selected scenario, specify the requirement, input/fixture, expected result and its derivation, execution surface, observation, and evidence. Derive expected values independently of the implementation under test. Calling the same production helper to compute both actual and expected values can hide a shared error. A UI and database agreeing with each other can still violate the business rule.

Distinguish product defects, test defects, environment failures, and unresolved expectations. A known-bad build is useful evidence, but it is not required to establish a newly discovered violation of a supported requirement. Baseline/patch comparison strengthens the claim that a change caused a fix. If the old build was already wrong, preserving its behavior is not a successful product outcome.

### Example from the supplied category-search demonstration

Assume the approved intent is that users can search within a selected category. Create controlled records in two categories with the same search term. Selecting category A and searching must return the matching A records and exclude matching B records. Clearing or changing the category, empty results, and persistence after navigation are additional scenarios only when supported by the relevant requirements or risk analysis.

An implementation that ignores the category fails the stated outcome even if its existing tests and endpoint return exactly what its code was written to return. A regression test must retain that business assertion and may correctly fail until the application is repaired.

### Effect on Benny and evaluation

Benny's feature map supplies useful user paths and execution mechanics. Add requirement references and the expected-behavior baseline upstream of its triage/reproduction steps. Require evidence before classifying disputed behavior as intentional or treating a report as a feature request. Have Poteto repair the implementation against the same expectation; QA then evaluates the new candidate without allowing the repair to redefine success.

The independent evaluator should receive the pinned intent, uncertainty/conflict record and scenario evidence as well as the implementation revision. It must check whether assertions actually establish the intended result. Merely checking agreement between the agent's report and its generated tests is insufficient.

## Initial playbook catalog

These are proposed families. Implement the first useful vertical slice and add another family when a real task needs it. A catalog entry does not imply executable support.

| Playbook                                   | Trigger and output                                                                                                                                                                                      | Skills needed                                                                                                       | Conditional work                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Test design and coverage review**        | Product intent, requirements or a ticket need scrutiny, reusable cases, coverage gaps, or a testability assessment. Output the expected-behavior baseline, reviewed scenarios/cases and open questions. | Requirement and expected-behavior analysis; risk assessment; case design; existing Testmo guidance when applicable. | Source tracing supplies observed behavior and technical risks. Browser only if observation is needed. No execution pass implied.                            |
| **Ticket acceptance verification**         | Verify a named candidate against ticket requirements. Output scenario results and a scoped disposition.                                                                                                 | Risk assessment; scenario selection; applicable execution adapter; failure triage; QA report.                       | Test implementation through Poteto; API/log checks; specialist audit when risk calls for it.                                                                |
| **Exploratory testing**                    | Investigate an unfamiliar feature or seek unknown failures. Output a bounded charter, session evidence, suspected/reproduced defects, and coverage follow-up.                                           | Charter/scenario design; execution; triage.                                                                         | Promote useful discoveries to reusable cases or automation. Do not claim exhaustive coverage.                                                               |
| **Issue triage and reproduction**          | A reported symptom needs classification, dedupe, reproduction, or ownership routing. Output a reproduction verdict with evidence and next owner.                                                        | Intake; source tracing; defect triage; applicable execution adapter.                                                | Tracker search if available; existing-fix verification if a patch exists; bounded Poteto repair if authorized.                                              |
| **Fix verification**                       | A concrete patch or revision claims to resolve a defect. Output baseline/candidate comparison and nearby regression results.                                                                            | Reproduction; change-impact assessment; execution; evidence review.                                                 | Test maintenance/creation through engineering. If baseline cannot run, retain that limitation and use another justified oracle; do not invent causal proof. |
| **Automation engineering and maintenance** | Implement tests, repair a test defect, investigate flakes, or curate a suite. Output reviewed test changes and evidence that assertions detect the intended failure.                                    | Existing framework guidance; test-quality review; risk assessment.                                                  | CI, page objects, migration, or mutation testing only as needed. The engineering implementation runs under Poteto's owner and admission.                    |
| **Release and regression review**          | Assess a release across several tickets and dependencies. Output scoped coverage, risk decisions, execution results, and readiness recommendation.                                                      | Change-impact assessment; suite selection; execution aggregation; QA reporting.                                     | Cross-application integration, specialist checks, and broader regression according to changed risks.                                                        |
| **Focused audit**                          | An explicit accessibility, performance, visual, security, or SEO question. Output findings tied to that discipline's criteria.                                                                          | Only the requested audit skill and required execution/evidence adapter.                                             | Separate substantial disciplines into playbooks when their workflow actually differs. A generic checklist cannot replace specialist evidence.               |

Case authoring alone retains its existing direct skill route. Known-defect repair and test implementation retain engineering ownership. The QA entry can coordinate these as subtasks, but must not reclassify all testing-related requests into a full QA review. This preserves current route exclusions.

## Skill boundaries and loading

Skill names and descriptions are normally visible during selection; that does not mean every skill body, reference, or tool is initialized. Design and measure selective loading at those separate levels.

| Layer                   | Load policy                                                            | Content                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA entry contract       | For every QA-domain run                                                | Product-intent reference and expected-behavior basis, requested outcome, selected playbook, authority, scope, evidence rules, and completion semantics. |
| Selected playbook       | One primary playbook; explicit branch to another when the task changes | Steps, dependencies, branch/stop conditions, outputs, and evaluation requirements.                                                                      |
| Reusable capability     | At the first step that needs it                                        | Requirements/oracle analysis, risk/scope, case design, execution, failure triage, or evidence reporting. Reuse existing suitable skills first.          |
| Tool/framework guidance | Only for the selected stack and operation                              | Playwright, API runner, mobile/station controls, Testmo, tracker, Seq, or CI.                                                                           |
| Project context         | Relevant profile/feature-map section                                   | Candidate/environment identity, permitted fixture actions, personas, feature behavior, test entry points, and cleanup.                                  |
| Specialist references   | Only when the risk or explicit task requires them                      | Accessibility criteria, lab performance method, visual comparison, security checks, or migration details.                                               |

Keep scope and authority in the small shared contract. They must not depend on whether a leaf skill remembered to load a safety reference. Permission for test-data mutation is specific to the run/environment; a historical profile does not grant fresh permission. Authorized fixtures can be created and cleaned up when the selected task requires them.

Create a separate skill when it has a distinct trigger and output and at least two concrete consumers, or a significant tool/permission boundary. Keep a single-task substep as a playbook section or reference. Avoid a skill for every testing technique and avoid multiple routers matching the same request.

Reuse the available `assess-change-impact`, `testmo-test-cases`, `qa-review-verification`, and Playwright guidance. Candidate new capabilities are requirement/oracle analysis, exploratory scenario design, execution coordination, and defect triage. Final boundaries should follow pilot usage, not a target skill count.

## Playbook contract and example

Each playbook should state:

1. When to select it and when another owner applies.
2. Required inputs and information that may remain unknown.
3. Steps with conditional skill loads and expected artifacts.
4. Branches for failures, missing capabilities, existing work, or changes in scope.
5. What “done” means for this task and what it does not establish.
6. Evidence and evaluator requirements.

For **fix verification**:

| Step      | Action                                                                                                                                   | Load only what is needed                                                | Completion evidence                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Identify  | Bind reported behavior, source requirement, baseline, patch, environment, and fixture state. Check whether someone already owns the fix. | Project profile and report intake.                                      | Candidate references and agreed discriminating behavior.                          |
| Scope     | Select the original symptom and affected nearby behavior.                                                                                | Change-impact assessment.                                               | Required scenarios with rationale.                                                |
| Reproduce | Observe the baseline using the relevant user/API/system surface. Reset and repeat where useful.                                          | Selected execution adapter.                                             | Attempt records with expected/observed state; or an explicit baseline limitation. |
| Verify    | Exercise the patched candidate with equivalent inputs and run the selected regression checks.                                            | Same adapter; CI/test guidance only if needed.                          | Candidate-bound results. An old baseline pass cannot count for the patch.         |
| Judge     | Classify unresolved failures and evaluate the evidence.                                                                                  | Failure triage; independent evaluator required by admitted QA contract. | Confirmed resolution, remaining defect, or bounded inconclusive result.           |
| Deliver   | Produce the evidence-linked QA note and authorized external updates.                                                                     | QA reporting; tracker adapter only for an authorized write.             | Saved report and readback for actual writes.                                      |

Test generation may happen before execution or while reproducing a known defect. A sound regression test should fail on the broken baseline and pass on the fixed candidate. Never change an assertion merely to agree with current implementation or disable a test merely because a retry budget expired.

## Canonical records, not parallel ledgers

Use `QaAssignment` for scope/authority and `QaReviewRecord` for scenarios, coverage bindings, attempts, evaluation, and disposition. A human-readable playbook run report should be a view of those records. Testmo cases remain reusable case definitions; test attempts remain execution evidence.

The current record does not explicitly carry a QA playbook ID/version, loaded capability list, or profile revision. If needed, add the minimum versioned metadata at the canonical plan boundary or a referenced immutable artifact after checking its existing schema. Do not claim these are existing fields. Do not overload `reviewRevision` to mean the playbook version.

Existing scenario fields (`requirementRefs`, `sourceRevision`, `expectedBehavior`, and `behavioralReason`) provide a starting point for intent traceability. Their presence alone cannot prove source authority, reconcile contradictory requirements, or validate an assertion's expected value. Specify those semantics and retain supporting requirement artifacts before adding fields. Requirement discovery and resolution of ambiguity can be reusable skills; honoring the approved intent is part of the shared QA contract on every relevant run.

Design-only work can finish with reviewed cases. It must not manufacture browser attempts or a full QA pass to satisfy a generic template. The current full-assignment contract requires a ticket and revisions; release-wide and exploratory work may need a justified parent scope or a later schema extension. Do not hide that mismatch behind a fabricated ticket.

## How Benny fits

Upstream [Benny](https://github.com/cursor/plugins/tree/adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/automations/benny) is a dormant Cursor automation pack. Its direct operational files implement Slack triage and reproduction with optional bounded repair. They are deliberately not registered slash skills. Local Temari host documents mention missing Benny dependencies; no executable Benny integration or installed policy entry was found in this review.

Adapt these parts:

- Triage distinguishes bugs, performance, feature requests, questions, and routing uncertainty.
- Search for duplicates and existing patches before creating competing work.
- Respect an existing fix owner. Verify an existing artifact instead of authoring over it.
- Use an explicit app-control contract and a project feature map.
- Observe the state that distinguishes broken from correct behavior and retain before/after evidence.
- Use stable source identity, idempotent writes, and saved-state readback in an eventual communications adapter.

Keep these conditional:

- Two independent UI reproductions, video, and media review are useful for UI defects when proportionate. API-only failures and test-design tasks require other evidence. Infrequent defects may need statistical or log evidence.
- A map gap should trigger bounded discovery or a scoped block for the affected action. It should not universally block safe exploratory learning.
- A missing baseline limits the claim that the patch caused the resolution; it does not erase useful observations of the patched candidate.
- A compensating tracker action after a failed message must be authorized and preserve audit history. Do not import blanket issue-deletion permission.

The future flow is **intake adapter → QA triage/reproduction playbook → bounded Poteto repair → QA fix verification**. Slack polling, markers, channel permissions, and notification rules belong to an optional adapter. They do not belong in every QA playbook. This review does not enable a Slack automation or authorize posting.

**Benny decision:** adapt its defect-handling playbooks inside the QA domain, with the expected-behavior baseline established before classification and reproduction. Preserve Benny as the source of these patterns; do not create a competing QA owner. Adopt a standalone Benny-branded event automation only if a later intake requirement needs it. The feature map is navigation and execution guidance; it must link to product intent without becoming the source of truth merely because it describes the current app.

## Evaluation before admission

Compare the proposed playbooks against current practice on the same pinned tasks. Record quality, context/tool use, latency, human corrections, and maintenance cost. Fewer loaded instructions are a hypothesis for efficiency, not a measured improvement yet.

Required distinguishing examples:

- Case-only work selects case design and never starts a browser or tracker write.
- API-only verification avoids UI, SEO, and screenshot dependencies.
- A known broken candidate yields a valid failing regression test; the same test passes after the real repair.
- Test maintenance fixes a locator without weakening the business assertion. An application defect remains visible.
- Missing environment yields `Blocked`/`NotRun` evidence while independent planning can continue.
- Existing patch and ownership gates prevent competing repairs.
- Authorized fixture setup/cleanup works; unauthorized mutation is blocked at execution.
- Changed candidates invalidate affected prior conclusions.
- A false-positive demo finding is rejected when its expected behavior lacks support.
- An implementation and its existing tests agree with each other but contradict an approved requirement; QA identifies the product violation and preserves the expected behavior.
- A required capability is absent from the feature map and implementation; QA retains it as an uncovered requirement or supported defect.
- Conflicting or missing product intent yields an explicit unresolved expectation; unrelated verified outcomes remain usable.
- A baseline contains a longstanding bug; unchanged behavior does not receive a product pass merely because no regression occurred.
- A generated assertion reuses the same erroneous calculation as production; independent expected values expose the ineffective test.
- A narrow outcome, procedural receipt, or green command exit cannot become a full QA pass.

Start with ticket acceptance and issue reproduction/fix verification. Reuse direct case-authoring skills immediately. Admit each executable playbook only when its adapters and evaluator contract have been demonstrated on the host. Add release-wide and specialist workflows as real needs justify them.
