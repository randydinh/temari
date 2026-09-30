# Ticket acceptance QA playbook v1

Use this playbook for a full QA assignment with a named ticket, requirement revisions, candidate, and either an environment or an explicit environment blocker. Keep the canonical six-stage plan and review record.

A request to perform QA Review remains in this playbook when execution is blocked.
Complete the available investigation and scenario inventory, mark each missing
acceptance attempt honestly, and invoke the independent evaluator for a bounded
disposition. A useful evidence note is a delivery view of that record, not the
replacement for the review route. If assignment admission itself lacks a trusted
ticket revision, candidate, or invocation digest, report the exact blocker instead
of inventing one.

1. Read the pinned product decision for every required outcome. Record conflicting or absent intent as unresolved; current implementation and existing tests do not establish the expected behavior.
2. Derive scenarios from those outcomes, including required behavior absent from the candidate. Choose a check whose assertion would fail for a plausible wrong result. Retain the counterexample and the expectation source.
3. Select the applicable project verifier and its actual control surface. Record a missing verifier or environment as a capability gap. Execute only authorized checks on the assigned candidate and retain canonical observations.
4. Separate a product failure from a broken check, missing environment, or unresolved expectation. Keep unexecuted and failed required scenarios visible.
5. Give an independent evaluator the pinned intent, scenarios, assertions, observations, contradictions, and coverage gaps. A procedural evidence scan alone cannot approve product intent or assertion adequacy.
6. Report the QA disposition at its proven scope. A blocked evaluator, uncovered required outcome, or green command without a discriminating observation cannot produce a full pass.

The installed local worker currently checks evidence structure and incomplete scenarios. Until a trusted semantic evaluator and applicable project verifier are exercised, its result remains bounded and cannot establish a full product pass.
