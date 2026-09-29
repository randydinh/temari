# Deferred QA output comparison

## Task

- [ ] Compare independently generated output from the pinned v4.1 and Nx
      Temari packages on the same small, sanitized QA test-authoring task.

Use separate agent sessions with the same host, model, tool permissions, task
prompt, and starting fixture. Pin each package by source revision and manifest
digest. Keep both workspaces and run stores isolated. Do not change the active
Temari installation for this evaluation.

The first fixture should implement `summarizeReview(checks)`: an empty review
is `BLOCKED`; a failed required check is `FAILED`; incomplete required checks
are `BLOCKED`; otherwise the result is `PASSED`. Its initial tests should cover
an empty review, required failure, and required success, but omit the optional
failure case. Give both agents this exact task:

> Add a focused Node test showing that a failed optional QA check does not
> change the overall PASSED disposition when a required check passes. Do not
> modify production code or other files. Run npm test and report the result.

Before either run, fix the scoring rule. Require the new test to pass against
the original implementation and fail when the `required` guard is removed from
the failed-check branch. Also check changed-file scope, the actual assertion,
test output, retained evidence, and workflow disposition. Score the outputs
without version labels, then reveal the versions. Preserve prompts, patches,
terminal output, package identities, receipts, failed attempts, and the score.

## Prior bounded observation

On 2026-09-28, one Codex agent drove both packaged workflows against isolated
copies of this fixture. v4.1 source
`959c8f7be3d7b684207d9e626263d41540d5ecdc` and Nx source
`c3e3d6b57d3dd085821c400d8c4ec69936ee70fe` were given the same one-test
patch, with test-file SHA-256
`bf4033918345ebb2d40067aeed9510383a9f0960591d163962f9339d12c40f17`.
Both had four passing tests, and the added test failed against the seeded
mutation with `FAILED` rather than expected `PASSED`. v4.1 wrote a passing
final-boundary receipt after an initial run correctly refused pre-edit evidence
as stale. Nx wrote a six-stage `PASS` receipt on its staged run.

That observation checks each workflow's ability to retain the same correct
artifact. The patch was deliberately supplied by the same agent in both runs.
It does not measure independent output quality, full QA review,
or readiness to retire v4.1. A full QA review comparison must wait until the
Nx installed route can run an independent evaluator; its current local host
returns `BlockedOrIncomplete` for that route. This deferred test-authoring
comparison is an evaluation follow-up, not a new cutover gate.
