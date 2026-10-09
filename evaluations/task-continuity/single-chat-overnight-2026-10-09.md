# Single-chat overnight integration contract

## Goal

Produce a locally verified integration candidate for Temari's single-chat
dashboard experience. The candidate must combine the bounded Talk orchestration
bridge with the managed reviewed-local-candidate route and its pinned Codex
configuration boundary on the current Temari base.

## Finish predicate

The local candidate is ready for user review when all of these conditions hold:

1. The current-main-based integration contains the Talk bridge and the complete
   managed route, including the final configuration-boundary repair.
2. The integration checkout is clean and every source change is committed.
3. Focused Talk, task-continuity, host-adapter, and managed-candidate checks pass,
   together with their applicable Nx typechecks and `git diff --check`.
4. An independent reviewer reports no unresolved actionable findings against the
   integrated candidate and the stated single-chat boundary.
5. The durable task records the candidate commit, verification evidence, review
   outcome, and exact next action.

## Authority and exclusions

Local commits, reversible repairs, worker delegation, and read-only review are
authorized. This run must not push, open or merge a pull request, publish an
artifact, modify a live product, or call a live model. Native worker success is
supporting evidence only; it does not satisfy Temari feature closeout.

## Bounds

Use at most three integration repair cycles for the same failing gate. If the
same material blocker remains after the third cycle, retain its evidence and
record the exact user or external action required. Append material decisions and
gate results to `.audit/single-chat-overnight.tsv`.

## Integration outcome

The combined local candidate is
`ca31b99798b3137c8e2706da43867c5db53af4d4`. The managed route's nine commits
were replayed on the Talk bridge, followed by one merge-diagnostics repair and
one read-only Git-routing repair. The full runtime suite passed 311 tests, and
the focused Talk, UI, host-adapter, Archon, managed-candidate, shutdown, typecheck,
and diff gates passed. Independent re-review reported no actionable findings.

This finishes the branch-integration prerequisite. It does not finish the
single-chat journey: the next implementation slice is a trusted, host-configured
DashboardController launcher that materializes the one-builder managed profile,
dispatches it through the reviewed-local-candidate path, and projects verified
native state back to Talk without accepting executable inputs from the browser
or model.

## Trusted launcher outcome

The trusted launcher is integrated through
`58161aa4995772936d2b872780f0b19f3b31f811`. It keeps the ordinary 2–4 worker
planner unchanged and adds a separate one-builder managed profile, immutable
host-owned preparation, typed route dispatch, one-shot readiness, exact result
verification, and same-task Talk projection to `NEEDS_REVIEW`.

Two review rounds closed all actionable findings. Generic dispatch cannot start
the protected route. The bridge runtime is an absolute, canonical, digest-pinned
host input carried through preparation, durable intent, Archon admission, and all
native nodes. Owned subprocesses execute the current absolute `process.execPath`;
Bun and Node differ only in their argument shape. Model-free regressions cover
PATH shadowing, missing or drifted runtime identities, duplicate and lost starts,
readiness refusal, result drift, concurrent task edits, and exact completion
projection.

The fixture proves source composition. Live admission still requires a frozen
external host profile and source selection. Automatic observation, sustained
supervision, and installed promotion remain follow-up work.
