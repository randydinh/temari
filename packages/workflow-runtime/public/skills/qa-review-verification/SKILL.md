---
name: qa-review-verification
description: Draft or review per-ticket QA verification notes and release QA reports from requirements, source reviews, and actual execution evidence. Use for QA Review closeout, verification handoffs, and evidence audits; not for authoring reusable test cases alone or generic code review.
metadata:
  version: '0.6.0'
---

# QA Review verification

Produce a concise record of what was established, on which candidate, by whom,
and what remains unresolved. Lead with observable behavior and the scoped outcome.
Keep enough reproduction detail for another tester to repeat the check.

## Use within Temari and Poteto mode

Use this supporting skill when the requested deliverable includes a ticket verification
note, QA evidence audit, or release QA report. Test-case authoring alone, code review,
implementation and defect repair stay with their existing owners.

When a canonical QA review record exists, derive the prose from its assignment, candidate,
scenario results, execution evidence and disposition. Preserve its revision/digest and link
the record; never replace it with a Markdown document. Preserve Failed, BlockedOrIncomplete
and NarrowReviewOnly limits in the prose. A narrow review cannot establish full readiness.

For evidence-only drafting, write the local document from the supplied or authorized
evidence. Drafting does not admit a runtime route, create PASS receipts, change a review
disposition, or satisfy an independent-evaluator requirement. Full QA execution remains
subject to the installed policy and host capabilities. Report a blocked route as blocked
even when a useful draft can be produced.
When the user requested full QA Review, do not present the resulting evidence-only note
as completed verification; identify the exact unexecuted acceptance work and the route
or prerequisite needed to finish it.

## Choose the record

- **Ordinary ticket comment:** default to [the compact template](assets/ticket-comment.md):
  Scope, Verified Behavior, Additional Observations, QA Status. Keep the conclusion,
  material limits and evidence attribution visible in the comment. Link detailed setup,
  candidate identity, case matrices and artifacts when they exist; do not invent an appendix.
- **Complex review or evidence audit:** use [the detailed template](assets/ticket-verification.md)
  when multiple candidates, variants, failures or unresolved evidence need a fuller record.
  A short comment may link that record without repeating it. Honor a requested format.
- **Release review:** adapt [the release template](assets/release-qa-report.md).
  Pin the multi-ticket candidate, aggregate scoped results and shared gaps, and
  link individual notes. A release smoke cannot stand in for ticket acceptance.
- **Product context:** use user or repository instructions and private overlays for
  application navigation and reviewer filters. Keep personal defaults out of this package.

A reusable test case defines future verification; a run result records an attempt;
a ticket note interprets evidence. Keep these identities distinct. Use an existing
case-authoring skill when actual case drafting is requested.

## Establish the product and codebase context

After applying the ticket filter and the installed policy, identify the candidate
and admitted source scope. Before deriving an expected result, use a configured
Content Registrar source within that scope for a bounded query and selection of
requirements, product behavior, and prior decisions. Read relevant source-backed
records rather than relying on a search snippet or indexed QA summary. If an
existing knowledge graph covers the admitted applications, query affected code
paths and follow its source locations into the selected candidate. Record the
Registrar source/revision, query and coverage limits, and graph snapshot or
freshness limit beside the requirements they informed. The ticket and authoritative
product decision define the expected business behavior; source and graph explain
implementation, not the oracle. These providers are optional and cannot set the
QA disposition. If a context source is missing, stale, partial, or outside the
admitted scope, name that gap and use scoped direct inspection. An indexed prior
review cannot prove a current runtime result or resolve contradictory acceptance
criteria.
When a selected Registrar record or graph path is missing, stale, or misleading,
record the source and correction needed for an authorized knowledge-maintenance
follow-up. Do not silently keep using the bad context.

Before choosing assertions, retain a bounded expected-behavior baseline: the
applicable approved requirement or product decision and revision, affected actor
and business outcome, preconditions and permissions, state/data invariants,
observable results, and unresolved conflicts or assumptions with their decision
owner. Identify the authority for this scope rather than imposing one universal
document ranking. Current code, UI, tests and older builds are implementation
observations; agreement among them cannot redefine the promised behavior. If
intent is unclear, mark the affected expectation unresolved and continue checks
that do not depend on it.

For related applications, retain one small context packet per ticket or feature group:
selected requirement and decision revisions, Registrar query and read receipts, graph
paths and snapshot, candidate source locations, and known gaps. Reuse it only after
checking its sources and candidate are current. Honor a project instruction to consult
both providers for every task; an unavailable provider is a recorded coverage gap.

## Present behavior clearly

Write the **Verified Behavior** section as concise, factual descriptions of what the
system does under the named conditions. Group multiple behaviors by feature area when
that helps a reader scan them. Lead with the behavior and outcome, not a chronology of
QA actions. Keep only the inputs, actions, observation window and setup needed to
identify or reproduce that result; link detailed steps and artifacts when they would
overload an ordinary ticket comment.

For example, prefer “A required name with surrounding spaces is saved without them
(`␠Bay␠` → `Bay`)” over “QA entered spaces around a name and clicked Save.” The
visible `␠` marks a literal space. The statement still needs the boundary, candidate and
evidence required below. For attributed human reports, keep the attribution visible
instead of recasting the report as an observation by the current author.

An optional **Change Summary** may follow Scope when a distinct before/after description
will help explain a meaningful behavior change. Omit it when Scope or Verified Behavior
already says the same thing. Label each side accurately: reported or reproduced before,
and observed after or still only expected. A ticket description or intended outcome
does not establish the observed behavior.

## Establish scope and candidate

Apply the user's ticket-selection constraints before opening ticket details. For a
reviewer-label restriction, confirm the exact label in the tracker and use a filtered
list to verify membership. Record the filter, capture time, qualifying IDs and sampling
limits. Ownership, comment authorship and a linked ticket do not establish label
membership. Inspect linked tickets only when they also qualify. If recent sprints have
no matches, report that gap and sample earlier qualifying sprints within the requested
history. Attribute each note to its actual author even when a ticket has multiple reviewers.

Read acceptance criteria, relevant comments, linked requirements and available results.
Identify the original failure, expected behavior, relevant variants, fixture/persona and
expected-result source. Attribute human reports to author/date/link. State when an
attachment, comment history, build or result was unavailable or not inspected.
Historical prompts and checklists are examples, not execution authorization.

For each in-scope ticket, establish the promised product or business outcome and its
authoritative requirement or decision source before judging the implementation. Map that
outcome to the distinct required verification scenarios. Current code, a previous QA
summary, and a green test show implementation or historical behavior; they do not define
an otherwise missing product rule. Mark conflicting or missing rules **Needs
clarification**, name the decision owner and question, and keep the affected result open.

For new behavior, write concrete input → action → observable outcome examples from the
ticket, epic, linked specification and dated decisions before authoring automation.
Compare them with existing expected behavior. If they conflict, stop the affected case
and automation change until the product decision is resolved; retain unaffected work.

For new source review or execution, record repository, target branch/release, full commit,
comparison base when relevant, observed remote head and check time, actual tested checkout
and dirty-state treatment. Query the remote explicitly; an old tracking ref, branch name,
PR status or previous report is insufficient. Preserve dirty work; use a clean isolated
snapshot when needed. Never silently substitute develop for release. Record dependency
and configuration differences that can affect results. Compare relevant tree contents
when ancestry diverges.

Recheck candidate identity before closeout. If it moved, retain earlier results with their
old identity, assess the diff and rerun affected checks; justify retained evidence. If remote
access fails, label freshness unverified. For a historical rewrite, preserve the original
candidate and mark missing provenance unknown; never repin old results to today's head.

For deployed checks, separately record application, environment, execution time, deployment
receipt/build ID and observed served artifact or running-build evidence. Include schema,
firmware, flags or service versions when they affect the assertion. A successful deployment
job proves provenance, not every running process or applied migration. Identify missing
build evidence and its effect on acceptance.

## Explain verification depth

For new verification planning, state the promised outcome, verified change, credible failure
mode and minimum proof needed. Reuse an existing impact assessment instead of repeating
it. Keep the full assessment in supporting evidence and one sentence of rationale in
the ticket comment.

Choose proportionally: **static sufficient** for fully understood changes with no semantic
or runtime-sensitive effect; **smoke** for a substantially unchanged direct path needing an
integration check; **focused integration** for persistence, serialization, wiring or async
effects; **broader regression** for shared behavior or consequences such as money/security.
Tie required checks to the affected outcome; distinguish optional boundaries and omissions.
If the change is unverified, state that the depth is provisional. A chosen level is a plan,
not proof it ran. For historical notes, retain the reported scope and mark absent rationale
unknown rather than reconstructing one as the original tester's decision.

## Write from evidence

For each meaningful behavior/path, link the requirement, give reproducible inputs/actions,
expected outcome, actual observation, result and sanitized evidence. An inspected case
revision may supply unchanged steps; record run-specific inputs and deviations. Use
role/company type and private fixture aliases; omit credentials and customer records.
For stateful checks, include owned-resource cleanup and its observed outcome.

For a full ticket decision, retain a linked scenario record or compact matrix that joins
each required scenario to its expectation source, candidate and fixture, exact execution
attempt or **Not run** reason, observed result, evidence, and separate Testmo case and
run/result links. Identify passing controls and failed variants without counting a shared
failure twice. A narrative audit, test plan, case definition, source concern, or passing
subset does not by itself establish ticket acceptance or support moving to Done.
Carry one stable inventory of distinct required scenarios and assess each of the eleven
canonical QA review areas for applicability; a large scenario count is not a quota.
If the current route or host cannot execute the full review and independent challenge,
retain the inventory and exact blocked obligations, then report partial work honestly.
Derive required scenarios from the intended outcomes first, including capabilities
missing from the current UI or code. Add implementation risks after that. Choose
the least costly reliable unit, property, API, integration, UI or exploratory check
that can observe each claim. Derive expected values independently of production
calculations and test helpers; shared arithmetic or data rules can make code and
tests agree while both violate the requirement.

When the project requires test-management records, reconcile each settled example with
its case definition before running or revising automation. Create or update cases only
within the authorized scope; verify saved fields by readback. Link each case to its
ticket in the project's test matrix, with distinct ticket, case revision, automation,
and actual run/result columns. Then select automation that asserts the promised outcome
and run it on the named candidate. Record skipped tests, failed parameter rows, and
unmapped cases. Case creation, source mapping, and a green badge never substitute for a
current asserted result. Keep missing case or automation work visible.
For a case correction, retain the before-image, the governing expected-result source,
the authorized saved-field change, the readback, and any native automation association
that needs correction. Preserve prior failed run rows as historical results; do not
relabel them as a current product defect or erase them to make coverage look green.

Check the test oracle and fixture before reporting a defect. Compare the assertion with
the authoritative example, the real input path, candidate source, and a normal control.
Identify mocks, injected impossible states, local component boundaries, and missing
service, persistence, queue, station or UI observation. Classify a finding only at the
boundary observed: confirmed in-scope failure, source-supported, component-reproduced,
reported, or investigation pending. A blocked fixture or undecided product rule is not
a product failure. For state changes or cross-service effects, choose the smallest real
integration or deployed test that distinguishes a product defect from a bad oracle;
retain candidate, fixture ownership, independent readback and cleanup. Repeating an
unchanged fake does not increase confidence in its realism.
Prefer a functional user-facing flow when it can observe the promised outcome. Use a
service, persistence, queue, simulator, or controlled failure check when the user flow
cannot expose the material risk. A suitable nonproduction environment can establish
the relevant boundary; production is not automatically required. If the remaining
check is manual, give the tester a concise run sheet with setup, actions, expected and
failing observations, independent readback, and cleanup. Before describing a finding
as a regression from a base branch, verify the behavior existed there; new paths on a
release branch are not proven regressions from a base that lacks them. A rule
violation that existed on the base can still be a product defect; unchanged
behavior is not a pass when the approved intent says otherwise. Classify a
reported behavior as intentional or a feature request only with product-decision
support. A repair cannot silently change the expected result to match the code.
For browser evidence, retain the target profile revision, candidate build,
environment, persona, permitted actions, owned data, and sanitized trace or
screenshot references. Saved browser auth state is credential material. Keep
proposed scenarios, selected checks, generated automation, and observed attempts
distinct. Triage a failed attempt as a suspected product defect, test defect,
environment issue, or unresolved, with the observation and next discriminating
check. A generated Playwright test is not proof of a QA pass. Confirm its
expected behavior from the requirement, then retain its observed assertion
results on each named candidate. A valid regression test can fail on a broken
baseline and pass on the repaired candidate; do not weaken the assertion to
make the earlier failure disappear.

Label the verification boundary on every result:

| Boundary                  | Permitted claim                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Documentation review      | Requirements or reports were inspected; implementation and execution are not established by that alone. |
| Source review             | Implementation supports or contradicts an expectation; behavior was not executed.                       |
| Local execution           | Named assertions ran on pinned source; state host, mocks/substitutions and limits.                      |
| Deployed execution        | Specified behavior was observed on the identified environment/build and persona.                        |
| Attributed human evidence | Named person reported a scoped result; identify whether evidence was inspected.                         |
| Not executed              | Explain blocked prerequisites, deliberate omissions or unsupported scope; no pass.                      |

Distinguish assertions from process exit, HTTP success, ticket state, cleanup and overall
acceptance. Preserve failed attempts and corrected reruns separately. Separate reproduced
in-scope failures from adjacent risks and undecided requirements. Do not invent broader
requirements to make a finding. Unclear acceptance is **Needs clarification**.

For bug fixes, connect three observations where evidence permits: the original failing
scenario before the fix, the same scenario after the fix, and a relevant normal/control
scenario. Identify each candidate and any changed inputs. Distinguish a directly reproduced
failure from a reported one; use the original report when a before-fix run is unavailable.
Mark missing before/after/control evidence and its acceptance limit explicitly. Do not turn
planned checks into results or require new execution merely to complete a historical note.

Keep an in-scope failure, blocked acceptance check or material evidence gap visible in
Verified Behavior and QA Status. Additional Observations is for useful adjacent behavior
and follow-up; do not move an acceptance failure there in a way that makes the ticket
sound unblocked or treats a requirement as optional.

Use **Pass / Fail / Blocked / Not run / Not applicable (reason)** for individual checks.
Use **Verified (named scope) / Partially verified / Failed (named scope) / Blocked /
Needs clarification** for the conclusion. State **Documentation review only** when only
ticket text, requirements or other documentation was inspected. Reserve **Source review
only** for actual implementation review without execution. Neither boundary turns a
documented expectation into an observed result; preserve separately attributed execution
reports when supplied. A partial pass or review alone cannot close an untested acceptance
boundary. An accepted exception needs a real decision owner and rationale; a follow-up
ticket alone does not accept risk. Keep existing workflow state separate from recommended QA disposition.
An approval label with missing verification notes is an evidence gap; do not manufacture
the execution or change the historical approval decision while reconstructing a note.

Link known Testmo case IDs with repository/project context and, separately, the actual
run/result and asserted subset. Label uninspected mappings, local intended mappings and
missing cases accurately. A draft, Under review case, native association, green latest-status
badge or Done ticket is not complete execution evidence. Retain failed parameter rows.
Never manufacture IDs, links, case approval, run completion or coverage. Do not combine
overlapping suites or unlike denominators into a coverage percentage.

## Hand back

Check that outcomes trace to candidate, fixture, expectation and evidence; material gaps
remain visible; and links resolve to the intended artifacts. Unknown required facts stay
explicit with the next action needed to resolve them.
For QA automation or product changes across repositories, report each repository, source
branch, target branch and clickable pull request. Describe the change's purpose, test
ownership, executed checks and remaining gaps in the PR or its linked review record.

For each blocked required scenario, make the handoff executable: state the missing
fixture, environment, observer, access, or product decision; who can supply it; the exact
check to run; and the observable outcomes that would pass or fail. Distinguish work the
current authorized host can finish from an external prerequisite. A generic “needs
testing” item is not a closeout instruction.
Before calling a fixture unavailable, inspect the authorized QA resources and determine
whether an owned disposable fixture can be created and cleaned up in the named test
environment. Do not use customer-owned records or equipment as a substitute. Reserve
Blocked for a prerequisite that is actually unavailable, unsafe, or outside authority.

When a confirmed failure needs a developer ticket, use the user's established tracker
bug template if available. Lead with the observed problem, include direct failing
evidence and a relevant successful comparison, then give environment, preconditions,
minimal reproduction, expected and actual behavior. Label reported, reproduced and
source-supported claims accurately; keep an unsupported root cause out of the ticket.
Drafting that bug does not turn a QA assignment into defect repair.

Honor a project or user review gate before posting verification notes or changing
ticket state. A passing recommendation requires every required scenario and its actual
evidence. Where the agreed workflow calls for it, review and post the note before
moving a passing ticket to Done. Keep draft, posted comment, recommendation, and
observed tracker state separate. Do not repair product code in a reporting assignment
unless that work was requested.

For a readability pass, ask whether a reader can find the main observed behavior quickly,
whether related behaviors are grouped when useful, and whether the prose describes system
outcomes rather than only QA actions. Then check separately that each claim has the right
boundary and evidence, and that the status reflects failures and remaining acceptance gaps.
Readable prose cannot substitute for verification evidence.

Keep raw payloads, tokens, auth state, recovery material and customer data private. Inspect
and sanitize extracts before rendering/copying; remove sensitive URL paths/query values
as well as log fields. Link only sanitized evidence suitable for the reader's access.
Private local links are acceptable in private drafts; label access/portability limits before
publication. Preserve originals and append corrections rather than overwriting history.

Authoring a note does not authorize test execution, account/role changes, production actions,
Testmo writes, ticket transitions/comments, commits or publication. Complete the local draft
within the request; perform separate actions only when their scope is authorized.

When changing this skill or recording feedback on its output, read the
[maintenance workflow](references/maintenance.md). It identifies the version-controlled
source, trial records, validation and rollback process; routine QA authoring need not load it.
