# Issue triage playbook v1

Select this playbook for a reported defect or an unexplained QA failure. It
produces bounded analysis and a next decision, not fix verification or full QA
acceptance. Follow the steps in order, revisiting earlier steps when evidence
changes scope. An unavailable check blocks that check, not independent useful
work. Stop dependent execution until its missing authority or input exists.

## 1. Pin the symptom and scope

Capture the exact report, source reference/revision, affected user outcome,
first/last known occurrence, frequency, persona, environment, build/candidate
identity, inputs, configuration and observed scope. Mark unknowns explicitly;
do not invent customer identities or extrapolate population impact from one
case. Separate reported observations from observations you actually obtained.
Read retained summaries as navigation context, then reopen original evidence
before relying on a material claim. Label inference and its supporting facts.

Check accessible duplicate and related history, prior attempts, affected and
fixed versions, and existing owner/work. Record what was searched and gaps in
access. Similar wording is not proof of a duplicate or common cause. Separate
conflated symptoms when expectations, mechanisms or owners differ; propose
links or split reports without changing the tracker.

## 2. Establish expected behavior

Derive each expected outcome from the applicable requirement or approved
product/business decision, with its reference, revision and authority. Compare
actual versus expected explicitly. Current code, historical behavior, existing
tests and developer opinion cannot alone decide product intent. If sources
conflict or intent is absent, preserve the observation and ask the decision
owner for the smallest clarification needed; do not declare a defect or pass.

## 3. Attempt permitted reproduction

Use only the selected task's authorized environment, fixtures and actions.
Record exact preconditions, steps, inputs, expected outcome, observed result,
execution time, build identity and evidence links. Include a normal control
where useful. Distinguish ordinary user reachability from constructed states
or direct API inputs. Record attempted-but-not-reproduced separately from not
attempted, blocked, and reproduced; failed reproduction is not proof of absence.
Do not run real payments or mutate trackers through this playbook.

For production reports, compare the upcoming release build when permitted and
available; for release-build reports, compare production only when permitted.
Use existing authorized observations if live comparison is unavailable. Pin
both identities and differences in data, configuration, persona and steps.
Report missing comparison as a gap, never widen access to fill it. Timebox
retries to the task's agreed budget; absent one, stop repeating an unchanged
attempt and identify the next discriminating check.

## 4. Trace the current mechanism

Within admitted source scope, pin the exact repository commit and any relevant
working-tree differences. Trace the entry point, callers, conditions, state
transitions and affected boundaries that could produce the symptom. Cite
commit-bound paths/symbols or lines and trace relevant callers, including
alternative paths that constrain blast radius. Recheck retained summaries
against this source; stale history is not proof of current behavior.

Separate a static mechanism supported by code from attribution of the reported
incident. Source plausibility alone cannot show which deployed build, input or
path caused that incident. State confidence in each claim, supporting and
contradictory evidence, alternatives, and the observation that would distinguish
them. If code is unavailable, retain the source gap rather than invent a cause.

## 5. Classify impact and the next decision

Distinguish product defect, test/check defect, environment or fixture failure,
unresolved expectation, and inconclusive observation. State supported user
impact, affected scope, reachability and workaround limitations. Use an external
project severity scale and its decision owner when available; otherwise describe
impact and leave severity unassigned. Keep fix priority separate: timing,
business tradeoffs and risk acceptance belong to the accountable decision owner.

Recommend a supported next step: authorized repair, further investigation,
product clarification, proposed improvement, defer, or no action with an
accountable rationale. Do not convert uncertain cause into a confident repair
instruction. For repair, give Poteto the pinned candidate, repro or blocked
repro, requirement-derived assertion, mechanism confidence, affected callers
and focused regression checks. Repair and subsequent QA require their own
applicable authority and evidence; analysis alone verifies neither.

## 6. Hand off and preserve the open work

Use the five-section [triage note](../assets/triage-note.md). Link concise primary
evidence instead of dumping logs. Give each next action an owner or explicit
owner-to-identify, needed input, and observable completion/resume check.

For a blocker, include a self-contained minimum request:
**Established** (facts already supported); **Still needed** (smallest missing
input or decision); **Who** (provider/decision owner); **Why** (specific check or
decision it unlocks); **Meanwhile** (useful authorized work that can continue);
**Resume check** (how to verify the input and resume the blocked step).
Ask only for missing information, not a repeat of settled scope or permission.

Analysis is ready to hand off when each distinct symptom has a bounded finding,
provenance, uncertainty and an actionable next step, even when reproduction or
cause remains unresolved. Preserve the original full QA assignment and all
unrun/failed scenarios when this is a failure-analysis substep. Return verification
notes or project-formatted defect drafts to the
[existing writer](../../qa-review-verification/SKILL.md). Temari retains lifecycle
and closeout decisions; this handoff is context, not execution evidence or signoff.
