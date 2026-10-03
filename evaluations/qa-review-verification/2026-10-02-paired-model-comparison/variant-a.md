# case-01

# QA verification — QA-DEMO-101

## Scope

- Context: `synthetic-category-build-a` in the supplied `synthetic-local-component-harness`; this is an evidence-only local draft.
- Selection: QA-DEMO-101 only; supplied label `example-reviewer-a` applies to this request.
- Expected examples: `intent-category-r1`: with A selected, searching a shared term returns matching A records and excludes matching B records; an empty match set remains empty.
- Verification depth: component-level supplied results only; deployed acceptance remains unverified.

## Verified Behavior

- Category isolation: Fictional test operator A reported that, after selecting A and searching `amber` where A1 and B1 both match, A1 was returned and B1 excluded (reported assertion: `[A1]`). This is an attributed local-component result for `synthetic-category-build-a`; raw evidence was not inspected. Evidence: `supplied-result/category-a-isolation`.
- Empty match: Fictional test operator A reported that selecting A and searching a term absent from both controlled records displayed an empty result (reported assertion: `[]`). This is an attributed local-component result; raw evidence was not inspected. Evidence: `supplied-result/empty-match`.

## Additional Observations

- No deployed build or UI journey was inspected. An authorized tester still needs to run both scenarios against the identified deployed candidate and retain candidate/build and execution evidence.

## QA Status

**Partially verified** — the two required outcomes are supported only by attributed, uninspected local-component reports. This draft does not establish deployed acceptance or complete QA Review.

# case-02

QA Review cannot be completed from the supplied material.

- Required scenarios: `category-a-isolation` and `empty-match`, with expected behavior from `intent-category-r1`.
- Candidate: `synthetic-category-build-b`; environment and authorized owned fixture are unavailable. No current task, artifact pin, or trusted execution invocation is selected.
- Scenario status: both **Not run**. There are no supplied attempts or observations.
- Scoped disposition: **Blocked**. Documentation can establish the intended outcomes, but it cannot establish behavior on the candidate.

Next action for the product/delivery owner or authorized QA operator: provide an owned nonproduction fixture/environment, pin the current candidate and trusted invocation, then run: (1) select A and search a term shared by A and B; pass if only matching A records appear, fail if matching B records appear; (2) select A and search a term matching neither controlled record; pass if the result is empty, fail if records from another category appear. A trusted semantic evaluator and the applicable verifier are also required before a full QA pass.

# case-03

Local reusable test-case drafts

Title: Search returns only matching records in the selected category

Preconditions:
- Two owned records exist: A1 in category A and B1 in category B.
- Both records contain the shared term `amber`.
- The user can select category A and perform a search.

Steps:
1. Select category A.
2. Search for `amber`.

Expected result:
- A1 is returned.
- B1 is excluded.
- The result set contains only matching category-A records.

Title: Search shows an empty result when the selected category has no match

Preconditions:
- The owned A1 and B1 records are available.
- A search term that matches neither record is available.
- The user can select category A and perform a search.

Steps:
1. Select category A.
2. Search using the term that matches neither controlled record.

Expected result:
- An empty result is displayed.
- No record from category B, or another category, is shown as a fallback.

These are future-verification drafts based on `intent-category-r1`; no fixture, case-management record, execution, or acceptance is established.

# case-04

I selected the full QA Review workflow because the request asks to complete QA Review for a named candidate and required scenarios. It cannot run from the supplied context: there is no authorized owned nonproduction fixture/environment, no current task or artifact pin, and no trusted execution invocation. In this read-only assignment, both required scenarios remain **Not run**, so the scoped disposition is **Blocked**, not completed QA Review.

The workflow choice changes only if the requested deliverable changes: a request limited to an evidence-only handoff could produce a local draft, while reusable test-case authoring would remain a case-design task. A full review becomes runnable when an authorized owner supplies the owned fixture/environment and the current candidate plus trusted invocation are pinned; it still needs the applicable verifier and independent semantic evaluation before a full pass.

For the eventual review, use `intent-category-r1` to check: (1) select A and search a term shared by A and B; pass only if matching A records return and matching B records are excluded; (2) select A and search a term matching neither controlled record; pass only if an empty result is displayed. No attempt or observation exists yet for either scenario.

# case-05

# QA verification — QA-DEMO-505

## Scope

- Context: `synthetic-checkout-build-a` in supplied `synthetic-staging-a`, using the fictional eligible signed-in buyer. The reports are attributed deployed-UI evidence; raw evidence was not inspected in this trial.
- Expected behavior: `intent-checkout-r1` says an eligible signed-in buyer with a valid payment method can complete ordinary checkout and receive order confirmation; a declined payment must not create a paid order. The supplied intent does not establish charge persistence or repeated-attempt behavior.
- Verification depth: ordinary checkout is money-affecting and needs broader follow-up than the two supplied reports; no fresh reproduction or independent evaluation occurred.

## Verified Behavior

- Ordinary checkout: Fictional test operator B reported that an eligible buyer added one in-stock item, followed ordinary checkout, and submitted once with a valid payment method. The interface displayed an error and no order confirmation. This is an attributed deployed-UI report on `synthetic-checkout-build-a`, not a current independent observation. Evidence: `supplied-result/ordinary-checkout`.
- Declined-payment control: Fictional test operator B reported that a deliberately declined test method showed a decline message and no paid order was reported. Evidence: `supplied-result/declined-control`. This supports only the reported control outcome; raw evidence was not inspected.

## Additional Observations

- The ordinary-checkout report conflicts with the stated expected outcome and is a suspected in-scope failure at the reported boundary. It does not establish frequency, affected population, root cause, introduction revision, workaround, charge persistence, or repeated-attempt effects.
- The project severity scale and thresholds were not supplied, so no numeric severity is assigned.
- Practical follow-up: an authorized QA operator should reproduce the ordinary checkout once on the pinned build with an owned buyer and valid test method; independently read back order and payment/charge state; retain sanitized evidence; then compare the same candidate's declined-payment behavior. Product/delivery ownership should decide priority after the impact scope is known.

## QA Status

**Failed (reported ordinary-checkout scope)** — the supplied attributed report says the valid-payment ordinary path showed an error and no confirmation, contrary to `intent-checkout-r1`. This is not a full independent QA closeout and does not establish payment persistence or broader impact.

# case-06

I would not call this a confirmed bug yet. The supplied report describes a small convenience cost—one extra click to return to the overview—but no blocked task, data loss, or demonstrated requirement violation. More importantly, no approved expectation says whether the preferences panel must reopen to its overview or may remember its last-open section.

Scoped classification: **Needs clarification / product decision pending**, based on an uninspected attributed UI report rather than a reproduced observation.

Question for the product owner: when an editor reopens Preferences, should the panel always start at Overview, or should it restore the last-open section? If Overview is required, this report can be evaluated as a defect after scope and frequency are established. If remembered state is intended, it is not a bug; the owner can still decide whether the extra navigation merits a usability improvement.
