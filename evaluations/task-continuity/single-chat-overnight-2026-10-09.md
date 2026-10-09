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

## Automatic observation outcome

Automatic managed observation is integrated through
`ce6b5f7e6820f31e65c8162b971808886cb3f8a5`. A host-owned loop starts after the
dashboard server listens, observes bounded batches without overlap, reuses exact
native references after restart, and stops without cancelling native work.
Unchanged native state does not append task events or Talk attention. A retained
successful readiness event is required before any caller may finalize, while a
readiness refusal permits status observation only.

Native success remains visibly in verification until the exact managed result is
retained and reopened; only then does the task project `COMPLETE`/candidate ready,
while canonical completion remains `NEEDS_REVIEW`. Observer problems are bounded,
sanitized, and scoped to the affected task. Independent review initially found
four polling and projection defects; all were repaired and final re-review passed.

The source candidate now proves the complete fixture-only single-chat path. A
real use still needs an operator-selected frozen profile/source and an installed
or source dashboard process. No live model/product run or external delivery was
performed in this contract.

## Real Codex-host product journey

Later user authorization admitted a fresh live journey against the clean
`Go to the Forest` SwiftUI product baseline at
`b4d9d6c6a350d491f23314ae2fd4364daf805949`. The bounded request added a
Forest Guardian completed-quest summary derived from persisted
`journal.entries.count`. Its host policy owned only `DomainModels.swift`,
`ContentView.swift`, and `QuestProgressTests.swift`.

The current ChatGPT-bundled Codex CLI (`0.162.0-alpha.2`) produced the validated
one-builder plan with `gpt-6.1-sol` at high reasoning. Managed preparation,
Archon dispatch, automatic observation, the isolated builder, protected
baseline/acceptance checks, and independent exact-candidate review all ran
through the dashboard controller. All 12 retained child steps succeeded. The
result is candidate `18216646f88d4f5bb43a49c131ddb12d0ec7616f`; the source
checkout remained unchanged.

Coordinator review found exactly 31 added lines in the three admitted files.
The independent reviewer reported PASS. The protected Swift behavior contract
and unsigned generic-simulator `build-for-testing` both passed. Task evidence is
verified with canonical receipt SHA-256
`6e42d7fa799ed827b3f75421ba3b65021fb21d448153a090799d311b45e7af90`.
The task remains `NEEDS_REVIEW` by design because this managed route has no
generic source-application or publication authority.

The live journey exposed three bounded host gaps:

1. Talk's protected Codex model adapter is pinned to `0.155.0-alpha.16.4` and a
   separate API credential, so it cannot drive the current ChatGPT-authenticated
   `0.162.0-alpha.2` host. This main Codex chat supplied the intent and drove the
   same controller API instead.
2. The inherited Codex user configuration must remain the actual host path,
   while the mutable account model cache cannot serve as a stable protected
   input across a model call. The successful run used the actual config and an
   immutable snapshot of the admitted account catalog.
3. Archon still probes Claude for optional title generation and warns when a
   detached local clone lacks `origin/HEAD`. Both warnings were non-authoritative;
   every admitted worker remained pinned to Codex and the managed candidate
   completed.

## Packaged Codex candidate

Clean Temari source `66fcfd41033d9595861ee2e003762a0b644c06f0` produced a
public plugin artifact with manifest SHA-256
`a684e80dedc48ddd46ff248c0d74d0ea82523c17fa477fdaedf37f2acbdf9dbf`.
The source artifact and the installed Codex cache copy both passed the strict
external-manifest checker. Codex reports
`temari@temari-single-chat-candidate` installed and enabled. The existing stable
`temari@personal` install remains present, so this candidate installation does
not silently replace the user's stable plugin selection.
