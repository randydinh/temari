# Parallel coding dashboard: local verification

Verified on 2026-10-01, macOS arm64. The live coding route ran from source commit
`5a3f7ae`. Subsequent bounded reviewer-context hardening is covered by the focused
regressions and independent source review below. Latest `origin/main` was
`ef5553a`, already incorporated; this turn's fetch found no new incoming decisions.

## Delivered behavior

The dashboard can prepare a fixed host plan with 2–4 implementers, disjoint typed
ownership, explicit preparation and verification commands, and one independent
reviewer. Workers edit isolated clones. The supervisor retains their patches,
integrates a separate candidate, runs combined verification, commits that tree,
and binds the reviewer to that exact commit. Progress, findings, logs,
cancellation and partial results stay attached to the durable task.

Worker or reviewer PASS leaves the task **NEEDS_REVIEW**. The coordinator still
assesses the original goal. The dashboard does not apply the candidate, push it,
create a PR or provide generic serial acceptance for this route. See the
[design and configuration guide](../../docs/dashboard-implementation-design.md)
and [operator journey](../../docs/task-dashboard.md).

## Executed checks

| Check | Observed result | Retained output |
| --- | --- | --- |
| `runtime:task-test` | 60 passed; no failures or skips | [Task, ledger, HTTP and controller checks](2026-10-01-dashboard-implementation/task-tests.log) |
| `host-adapters:test` | 121 passed; no failures or skips | [Adapters and shared write-runner regression](2026-10-01-dashboard-implementation/host-adapters.log) |
| `runtime:dashboard-test` | 20 passed; no failures or skips | [Controller and investigation supervisor](2026-10-01-dashboard-implementation/dashboard-tests.log) |
| `runtime:dashboard-implementation-test` | 29 passed; no failures or skips | [Coding supervisor and shared write runner](2026-10-01-dashboard-implementation/implementation-tests.log) |
| `runtime:task-typecheck` | Passed, including coding supervisor and tests | [Typecheck](2026-10-01-dashboard-implementation/typecheck.log) |
| Browser JavaScript and Git whitespace | `node --check tools/task-view.js` and `git diff --check` passed | Coordinator command execution |
| Live combined helper tests | 4 passed; baseline failed before either patch | [Integrated tests](2026-10-01-dashboard-implementation/live-combined-tests.log), [baseline](2026-10-01-dashboard-implementation/live-baseline-tests.log) |

Suites overlap; their counts are not unique-case totals. Log copies have ANSI and
trailing whitespace removed. Original paths, raw hashes and retained hashes are
recorded in the [structured live proof](2026-10-01-dashboard-implementation/live-proof.json).

## Real-agent browser journey

The browser prepared and started task
`task-a8fc2f18-bec7-4ed5-9825-90c1a56cd5bb` against clean fixture base
`bffe581fe11a53b85c7a35a0a84694a8277e0859`.

- `count-validation` owned only `limits.mjs`, process **66680**.
- `phase-labels` owned only `labels.mjs`, process **66679**.
- Both ran with Codex `exec` in distinct isolated checkouts and overlapped for
  **21.226 seconds**. Runtime execution evidence recorded peak concurrency **2**.
- The dashboard server was restarted while both processes were alive. The
  detached supervisor and child attempts continued; the restarted dashboard
  recovered the same groups and results. No worker was relaunched.
- Both patches were retained and combined. Host verification passed all four
  existing tests and produced clean commit
  `bc72d4f9f665f46a6ac69eeef6ee91749eb00c5b`.
- Independent reviewer process **69253** started after integration and inspected
  that exact commit. It reported PASS with source citations; the task remained
  NEEDS_REVIEW, `integrityIssue` was null, and only the metadata update action
  remained available.
- The original source remained clean at its unchanged base. The integration
  checkout remained clean at the reviewed commit.

The first live plan incorrectly required each isolated worker to pass the
combined suite before its sibling patch existed. Both correctly reported ISSUES;
integration and review did not proceed. That failed attempt is retained as task
`task-c90ba2ae-1c5f-472f-8fac-0b5d1c44b605`. A new immutable preparation corrected
each worker's criteria to its owned tests and reserved combined verification for
the host. Existing attempts and receipts were not rewritten.

The live reviewer could inspect the committed source but not the external
integration receipt. Final source now includes a bounded inline host verification
summary with each command, exit code, retained log path and sealed SHA-256.
Focused tests assert exact metadata and digest binding, and block review without
launching a model if the summary exceeds 16 KiB. No raw log content or additional
filesystem access is granted. This metadata addition was verified through focused
tests and source review; the live model run above predates it.

## Independent source review and recovery fixes

A separate reviewer examined the controller, supervisor, extracted write-runner
helpers, tests and browser changes. It found that deleting a completed artifact
could leave the candidate looking usable. Completed runs now require both retained
receipts, sealed integration and the resolved reviewer binding on each inspection.
Deleting any required artifact adds an integrity warning while preserving the
observed COMPLETE history. The regression deletes and restores all four artifact
types independently, without relaunching agents.

Candidate-ready text also requires intact PASS integration and PASS review at the
same commit. The review checked exact log membership, canonical integration paths,
partial patch retention, cancellation drain and acceptance boundaries. Final
re-review, including the inline verification metadata, reported **no actionable
findings**. The reviewer inspected source and tests independently; it did not
independently rerun them or claim live execution.

The final focused gate also exposed a startup observation race. A matching
supervisor observation can precede its first heartbeat. Inspection now preserves
STARTING within the existing five-second launch window; after expiry it still
requires recovery. A deterministic regression verifies both cases and confirms
that repeated Start launches no additional process. Independent re-review found
no issue with this delta.

## Local activation and limits

The main dashboard was refreshed from `8e73731` at
<http://127.0.0.1:3092>. All three existing task identities remained present;
the matching Archon service was retained. The browser confirmed the coding option
and its ownership, check and reviewer preview. See the
[activation record](2026-10-01-dashboard-implementation/activation.json).

The local dashboard configuration selects a bounded **Improve dashboard UI and
operator guide** plan: one implementer owns the three browser assets and another
owns `docs/task-dashboard.md`. Dependency preparation and syntax, type, controller
and whitespace verification are fixed host commands. Requests requiring controller
or runtime edits need Temari to prepare another plan.

This verifies the configured coding route, not automatic task decomposition or a
general-purpose swarm planner. Recurring scheduling, a Registrar visualization,
automatic chat capture, cross-device service supervision, provider spending
limits, and publication remain separate work. The installed plugin was not
rebuilt in this increment. There is no trusted packaged `feature-v1` closeout or
canonical completion claim.

The existing graph predates these new dashboard files and returned no scoped
source matches. Source-linked direct inspection was used; no graph or bundled
P-stack skills were modified.
