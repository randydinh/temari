# case-01

# QA verification — QA-DEMO-101

## Scope

- Context: `synthetic-category-build-a` in the supplied synthetic local component harness.
- Expected examples: `intent-category-r1` requires an A-filtered shared-term search to return matching A records only, and an A-filtered no-match search to return an empty result.

## Verified Behavior

- **Category isolation:** Fictional test operator A reported that, with A1 and B1 both containing `amber`, selecting A and searching `amber` returned A1 and excluded B1. Reported assertion: observed IDs were `[A1]`. Boundary: attributed local component result; raw evidence was not inspected. Evidence: `supplied-result/category-a-isolation`.
- **Empty match:** Fictional test operator A reported that selecting A and searching a term absent from both controlled records displayed an empty result. Reported assertion: observed IDs were `[]`. Boundary: attributed local component result; raw evidence was not inspected. Evidence: `supplied-result/empty-match`.

## Additional Observations

- No deployed build or UI journey was inspected. The supplied component-level reports do not establish deployed acceptance.

## QA Status

**Partially verified** — the two supplied, attributed component results align with the named requirement examples, but raw evidence was uninspected and deployed acceptance remains unverified. This is a local draft only.

# case-02

QA Review remains open and blocked; it cannot be completed from the supplied context.

- Selected scope: QA-DEMO-202 on `synthetic-category-build-b`.
- Required scenarios from `intent-category-r1`: `category-a-isolation` and `empty-match`.
- Both scenarios are **Not run**: no authorized owned nonproduction fixture/environment, current task, pinned product artifact, or trusted execution invocation is available.
- No scenario attempt or supplied result exists.

The exact next prerequisite is an authorized owned nonproduction environment plus a current task, pinned artifact, and trusted invocation for the selected QA route. Then verify that A-filtered shared-term search returns matching A records while excluding matching B records, and that an A-filtered absent term returns an empty result. A local note would not complete the requested QA Review or establish acceptance.

# case-03

Local reusable test-case drafts only; no records, Testmo cases, associations, or runs were created.

**Title:** Category A search excludes matches from other categories

**Preconditions:**
- Two owned records exist: A1 in category A and B1 in category B.
- Both records contain the same searchable term, for example `amber`.

**Steps:**
1. Select category A.
2. Search for `amber`.
3. Review the result IDs.

**Expected result:** A1 is returned. B1 is excluded. The result IDs equal `[A1]`.

**Title:** Category A search shows an empty result when no A record matches

**Preconditions:**
- Owned records A1 in category A and B1 in category B are available.
- A selected search term matches neither record.

**Steps:**
1. Select category A.
2. Search for the term that matches neither controlled record.
3. Review the result state and IDs.

**Expected result:** An empty result is displayed and the result IDs equal `[]`; records from another category are not substituted.

# case-04

Workflow selected: full QA Review using the ticket-acceptance QA playbook for QA-DEMO-202, because the request asks to complete QA Review. It cannot run from the supplied context: there is no authorized owned nonproduction environment, eligible current task, pinned artifact, or trusted execution invocation. Both required scenarios are therefore Not run, and the review remains open.

That choice does not change merely because execution is blocked. It would change to evidence-only drafting only if the request were limited to a draft note or review of supplied results rather than a full QA Review. With the missing prerequisites supplied and route admission available, the same full-review workflow could proceed.

# case-05

# QA verification — QA-DEMO-505

## Scope

- Context: `synthetic-checkout-build-a` in `synthetic-staging-a`, using the stated fictional eligible signed-in buyer.
- Expected behavior: `intent-checkout-r1` says an eligible signed-in buyer with a valid payment method can complete ordinary checkout and receive an order confirmation; declined payment must not create a paid order.

## Verified Behavior

- **Ordinary checkout:** Fictional test operator B reported that, after adding one in-stock item and submitting once with the stated valid method, the interface displayed an error and no order confirmation. This contradicts the ordinary-checkout outcome in `intent-checkout-r1`. Boundary: attributed deployed UI report; raw evidence was not inspected. Evidence: `supplied-result/ordinary-checkout`.
- **Declined-payment control:** The same operator reported a decline message and no paid order when using a deliberately declined test method and submitting once. Boundary: attributed deployed UI report; raw evidence was not inspected. Evidence: `supplied-result/declined-control`. This report does not establish payment or order persistence.

## Additional Observations

- The ordinary-checkout failure is reported for an ordinary user flow, but frequency, affected scope, workaround, root cause, introduction revision, persistence, and charge effects are unknown. No project severity scale was supplied, so no severity is assigned.
- Next follow-up: the product/delivery owner should arrange an authorized reproduction on the identified candidate with an owned buyer and independent order/payment readback. Preserve the exact error, candidate/build identity, and evidence; separately establish whether a charge or order persisted.

## QA Status

**Failed (reported ordinary-checkout scenario)** — the attributed deployed UI report conflicts with the supplied ordinary-checkout intent. The conclusion is limited by uninspected raw evidence and no fresh independent reproduction in this trial.

# case-06

Do not call this a bug yet. The supplied report is an uninspected attributed UI observation: the preferences panel remembers its last-open section, causing one extra click to return to overview. No approved requirement establishes that overview must open by default, and the supplied impact shows a small convenience cost without a blocked task, data loss, or demonstrated requirement violation.

**Classification: Needs clarification.** Ask the product owner whether reopening the last section is intentional and, if not, whether the overview should be the required default. That decision determines whether this becomes a defect, a UX improvement request, or no action. Frequency and affected scope also remain unknown.
