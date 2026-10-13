# Source and evidence block

Use this short block in bug reports, incident notes, audits, investigations, and change reviews.
Fill only what matters; write **Not recorded** rather than guessing.
This template records observations; it does not replace route-specific QA,
execution evidence or closeout requirements.

## Core record

| Field | Details |
|---|---|
| Document / owner | `[type + title or ticket ID] · [team/person]` |
| When / where | `[date/time + timezone] · [environment, app/version, or system]` |
| Sources | `[see source list below; include only sources relevant to this finding]` |
| What was examined | `[relevant files, screen, endpoint, record, or test]` |
| Finding | `[what happened; expected vs. actual when useful]` |
| Reproduce | `[short steps and starting state, or N/A]` |
| Impact | `[who/what is affected and how often, if known]` |
| Evidence / limits | `[links or attachment IDs] · [what this does not prove / Not recorded]` |
| Next action | `[decision or fix needed] · [owner/status]` |

### Sources (one row per repo or artifact)

Use an ID such as `R1` or `R2` in the evidence links below. Record each repository's own branch and
commit; do not imply a single revision covers multiple repos.

| ID | Repo / artifact and role in the audit | Branch/ref + full SHA, build, or version | Files / area examined and date |
|---|---|---|---|
| R1 | `[repo or deployed system]` | `[branch + SHA, or Not recorded]` | `[paths/screens; date]` |
| R2 | `[another repo or artifact, if needed]` | `[its own branch + SHA/version]` | `[paths/screens; date]` |

For a bug, prioritize **environment, steps, expected result, actual result, and sanitized evidence**.
For an audit or design review, prioritize **scope, sources, findings, and what was not tested**.

## Add only when it matters

Record these details when they could change the conclusion or make the finding hard to reproduce:

- **Runtime-to-source mapping:** deployed build → source commit `[evidence / Not established]`.
- **Comparison baseline:** base revision/build and inspected revision/build, if different.
- **Local differences:** relevant uncommitted files, configuration, feature flags, or test data.
- **Conflicting sources:** say which source supports the finding, or mark the difference unresolved.
- **Coverage:** roles, paths, tests, attempts, exclusions, and known-good version.
- **Sensitive evidence:** replace personal/customer values with stable placeholders; never attach credentials or tokens.

## Optional Git identity check

Run from the repository path; review status output before sharing because it can expose filenames.

```sh
git -C "$REPO" branch --show-current
git -C "$REPO" rev-parse HEAD
git -C "$REPO" status --short --branch
```

**Quick review:** Can someone locate the source and understand what was observed, what remains
uncertain, and who owns the next step?
