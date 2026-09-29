# QA verification — {{ticket ID}}: {{title}}

**Outcome:** {{scoped disposition and observed behavior; remaining acceptance gap}}
**Ticket:** {{canonical link}} · **Recorded by:** {{reviewer}} · **As of:** {{time + timezone}}
**Workflow state:** {{observed state + time}} · **Recommended QA disposition:** {{recommendation}}

## Scope and expected behavior

{{Change / original failure, behavior covered, relevant excluded variants.}}

- Requirement / acceptance source: {{ticket section, comment, spec revision or decision link}}
- Scope eligibility: {{requested reviewer label/filter; confirmed membership and capture time}}
- Related source / PR: {{commit-pinned links and comparison base when relevant}}
- Verification depth and rationale: {{static sufficient / smoke / focused integration / broader regression; affected outcome + failure risk + minimum proof; provisional or historically unknown where appropriate}}

## Candidate and setup

| Item                          | Evidence                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Application and environment   | {{each app, environment, safe URL; runtime/browser/device/protocol as relevant}}            |
| Reviewed/tested source        | {{repo + branch/release + full SHA; actual checkout; comparison base}}                      |
| Freshness                     | {{remote head + timestamp + receipt at start and closeout; or unknown/historical}}          |
| Working copy and dependencies | {{clean snapshot or named dirty overlay; relevant lockfile/config/flags}}                   |
| Deployed build                | {{deployment receipt and observed build/artifact; schema/firmware when relevant; unknowns}} |
| Fixture/persona               | {{private alias + role/company type + ownership + preconditions + safe fixture reference}}  |

For multiple applications, identify source and deployed identity separately for each.
Unknown facts remain explicit; omit non-applicable details with a reason.

## Verification and observed behavior

Use one row per meaningful check/variant. Give exact safe inputs, ordered actions and
observation windows, or an inspected case revision plus run inputs and deviations.

| Check / requirement | Boundary, executor and time                                          | Exact steps / inputs                  | Expected                        | Observed                                   | Result                                     | Evidence                          |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------- | ------------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------------- |
| {{behavior/path}}   | {{source/local/deployed/attributed human/not executed; author/time}} | {{actions or case revision + inputs}} | {{source-grounded expectation}} | {{actual observation; none if unexecuted}} | {{Pass/Fail/Blocked/Not run/N/A + reason}} | {{sanitized artifact/run/anchor}} |

**Behavior summary:** {{conclusions supported by the rows; no generalization across untested variants.}}

For a bug fix, use these rows or identify the matching rows above. Omit this subsection
for other change types. Preserve missing evidence explicitly; proposed checks are not results.

| Bug-fix comparison       | Candidate and inputs                                           | Observation and provenance                                                     | Evidence / remaining limit                 |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Before fix               | {{original candidate + failure-triggering inputs, or unknown}} | {{directly reproduced / reported / not reproduced / unavailable; author/time}} | {{original failure evidence; limitations}} |
| After fix, same scenario | {{fixed candidate; same inputs or stated differences}}         | {{expected vs observed; actual result, or not run}}                            | {{run/artifact; acceptance limit}}         |
| Normal/control scenario  | {{candidate + relevant normal input}}                          | {{expected vs observed; actual result, or not run}}                            | {{run/artifact; reason if not applicable}} |

## Test cases and execution links

| Case                                                                     | Relationship and asserted subset                                               | Actual run/result                                      | Remaining coverage                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------- |
| {{Testmo repository/project + case ID/link, or not found/not inspected}} | {{definition / local mapping / verified native association; exact assertions}} | {{run/result link + date/build, or not run/not found}} | {{manual/integration paths still needed}} |

Case existence and publication state are separate from execution status.

## Failures, risks and gaps

- In-scope failure: {{expected vs observed, failing evidence, impact, linked defect or draft ID}}
- Adjacent observation/risk: {{boundary and uncertainty; avoid invented requirements}}
- Blocked / not run / ambiguous: {{missing input/decision, consequence, owner/next action}}
- Accepted exception, if any: {{decision owner + dated link + rationale + follow-up; otherwise pending}}
- Cleanup: {{owned records/sessions restored or invalidated + evidence; unresolved item/recovery owner; no secrets}}

## QA disposition

{{Verified for named scope / Partially verified / Failed for named scope / Blocked /
Needs clarification / Source review only. Supporting evidence and next step before broader acceptance.}}

Evidence access: {{private packet or sanitized shareable links; unavailable/uninspected evidence}}.
Supersedes / carries forward: {{earlier note/run, candidate and rationale; never relabel prior results as new}}.
