# QA review — {{release / sprint}}

**Recommendation:** {{ready for named scope / hold / conditional decision; blocking reasons}}
**As of:** {{time + timezone}} · **Coordinator:** {{name}}
**Scope:** {{captured ticket query/list + capture time, count, included/excluded apps; QA Review vs Done distinguished}}
**Selection rule:** {{exact reviewer label and other filters; verified membership; full inventory or sample and omissions}}

## Candidate and deployment identity

| Application | Target branch/release + full SHA | Remote check at start / close | Tested source and dependencies/config | Deployment evidence         | Observed build/schema/firmware    |
| ----------- | -------------------------------- | ----------------------------- | ------------------------------------- | --------------------------- | --------------------------------- |
| {{app}}     | {{identity}}                     | {{times + receipt}}           | {{checkout/overlay/lockfile}}         | {{job/artifact or unknown}} | {{observation + time or unknown}} |

{{Head movement, changed dependencies, superseded conclusions and affected reruns.
Keep comparison branches separate from the release candidate.}}

## Ticket decisions

Link each ticket's verification-depth rationale and bug-fix comparison where applicable.
Report outstanding required checks separately from optional boundary coverage; a planned
verification level does not imply completed execution.

| Ticket and per-ticket note | Workflow state | QA disposition        | Verified boundary               | Material failure/gap | Case and result links                          | Next owner/action |
| -------------------------- | -------------- | --------------------- | ------------------------------- | -------------------- | ---------------------------------------------- | ----------------- |
| {{ID + links}}             | {{state}}      | {{scoped conclusion}} | {{source/local/deployed/human}} | {{gap}}              | {{definitions separate from runs, or unknown}} | {{who/what}}      |

## Shared regression and post-deploy evidence

| Suite / smoke / integration | Candidate + environment + persona | Execution time and evidence | Passed / failed / blocked / skipped / not run | Denominator and substitutions                | Acceptance limit / cleanup |
| --------------------------- | --------------------------------- | --------------------------- | --------------------------------------------- | -------------------------------------------- | -------------------------- |
| {{scope}}                   | {{identity}}                      | {{receipt}}                 | {{actual results; retain failures}}           | {{assertions/scenarios/operations; overlap}} | {{scope and cleanup}}      |

{{Keep source review, local mocks/components, deployed tests and attributed human reports
separate. Smoke does not prove every ticket, role, protocol or side effect. Do not add
overlapping or unlike counts into one coverage percentage.}}

## Release risks and remaining work

- Blocking failure/acceptance gap: {{evidence, impact, owner/next action}}
- Unexecuted/unclear acceptance: {{fixture/build/schema/spec/authorization missing; effect on recommendation}}
- Accepted exception: {{actual decision owner, dated decision and rationale; do not infer from a follow-up}}
- Cleanup/restoration: {{resolved and unresolved owned records/sessions, evidence and recovery owner}}
- External records: {{observed Testmo case maintenance, associations and results separately; actual changes by this task}}

## Closeout record

{{Candidate freshness recheck; per-ticket records; manifest/index for a large packet;
corrections preserving prior runs; evidence accessibility; uninspected attachments.
Recommendation limits and release decision owner. Authoring completion is separate from release acceptance.}}
