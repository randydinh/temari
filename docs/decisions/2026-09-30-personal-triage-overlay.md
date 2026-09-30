# D-2026-09-30: Personal triage is an overlay, not a workflow

Status: accepted

## Decision

File/folder organization and email triage are served by the private
`personal-triage` Codex skill overlay. It is deliberately outside this
repository and provides only read-only discovery plus draft planning by
default. It does not introduce a Temari route, workflow stage, runtime store,
host capability, credential, or connector implementation.

QA-ticket triage reuses Temari's existing `qa-review` domain. Early ticket
triage is a draft intake; full coverage, validation, or readiness uses the
canonical QA assignment and its independent-review, revision-bound-evidence
obligations. Poteto remains the owner of any engineering repair.

## Authorization boundary

All email and ticket connector effects remain draft-only until the user
explicitly authorizes the exact send, saved draft, label/archive/delete,
comment, edit, assignment, or state-change action. File organization likewise
requires approval of the proposed move/rename/delete batch before mutation.

Notion QA/SDLC content is read only after an authorized Notion connection is
available. It supplies bounded requirement and process context that maps into
the existing QA assignment; it does not become a second workflow, data store,
or shared-repository artifact.

## Consequences

- Personal preferences and private material remain in the local overlay under
  the existing overlay policy.
- Missing connectors degrade to an explicit intake/checklist rather than a
  simulated result.
- Canonical plans, receipts, evidence, scheduling, and recovery remain owned
  by the existing workflow engine and runtime.
