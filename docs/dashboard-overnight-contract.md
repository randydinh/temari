# Dashboard overnight build contract

User instruction: keep going, build the remaining dashboard, and follow the
[P-stack overnight guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/07-overnight.md).

## Finish condition

The run finishes when all of the following are demonstrated on the actual local dashboard:

1. A natural goal produces a retained, validated worker plan with bounded ownership, dependencies, fixed host checks, and independent review. Its implementation can start through the existing isolated coding runtime; malformed or out-of-scope plans cannot execute.
2. Durable once and recurring schedules dispatch each admitted due occurrence idempotently, prevent overlap, retain missed-run policy and execution history, and recover after restart. Operators can pause, resume and cancel schedules and observe actual task execution.
3. A separate knowledge map shows real configured Registrar sources, pinned publications, documents, paths and supported graph relationships. Selecting a relationship shows provenance and qualifiers. Missing, revoked, corrupt or stale evidence is explicit.
4. Meaningful integration checks and browser journeys pass for these capabilities, independent review has no unresolved actionable findings, documentation and README links are current, and the local dashboard is refreshed.

The broad task remains `temari-task-dashboard`. Build in the existing managed
worktree on `codex/task-continuity`; preserve other checkouts and chats. Local
commits and reversible fixes are authorized. Existing source application,
publication and canonical acceptance boundaries remain in effect. The installed
Archon pin stays at 0.10.1. Worker findings and native status do not prove semantic
completion.

## Delivery sequence

- Record the baseline, frame types and verification gates.
- Implement and verify bounded planning and its task journey.
- Implement and verify durable scheduling and recovery.
- Implement and verify read-only Registrar map projections and selection.
- Integrate the simple browser flows, exercise the real services, independently review, refresh the local dashboard, and save the final handoff.

Independent modules may be developed in parallel with explicit file ownership;
controller, UI and shared Nx configuration have one owner. Verify each integrated
unit before depending on it. Keep one append-only decision trail at
`.audit/dashboard-overnight.tsv`; retain command logs and exact candidate evidence
under `evaluations/task-continuity`.

## Continuing and stopping

Continue the active session until the finish condition passes. A recurring
heartbeat is pending explicit cadence/scope approval after automatic approval
review rejected its creation. Do not bypass that rejection. If a genuine external
block prevents progress, retain its evidence and the exact next action. A failed
experiment or plateau calls for a corrected approach; it does not relax the finish
condition.
