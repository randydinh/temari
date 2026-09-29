---
name: qa-review-verification
description: Draft or review per-ticket QA verification notes and release QA reports from requirements, source reviews, and actual execution evidence. Use for QA Review closeout, verification handoffs, and evidence audits; not for authoring reusable test cases alone or generic code review.
metadata:
  version: '0.3.0'
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

Label the verification boundary on every result:

| Boundary                  | Permitted claim                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Source review             | Implementation supports or contradicts an expectation; behavior was not executed.  |
| Local execution           | Named assertions ran on pinned source; state host, mocks/substitutions and limits. |
| Deployed execution        | Specified behavior was observed on the identified environment/build and persona.   |
| Attributed human evidence | Named person reported a scoped result; identify whether evidence was inspected.    |
| Not executed              | Explain blocked prerequisites, deliberate omissions or unsupported scope; no pass. |

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

Use **Pass / Fail / Blocked / Not run / Not applicable (reason)** for individual checks.
Use **Verified (named scope) / Partially verified / Failed (named scope) / Blocked /
Needs clarification** for the conclusion. State **Source review only** when nothing ran.
A partial pass or source review cannot close an untested acceptance boundary. An accepted
exception needs a real decision owner and rationale; a follow-up ticket alone does not
accept risk. Keep existing workflow state separate from recommended QA disposition.
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
