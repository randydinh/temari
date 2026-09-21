# Watch PR

Watch PR is the GitHub babysit watcher at `skills/poteto-mode/scripts/watch-pr/watch-pr`. Users run it to print one status snapshot or to poll until a terminal verdict.

## Sub-features

- `watch-help` prints usage, mode flags, and the JSON-vs-`--pretty` contract.
- `watch-usage` rejects invalid flags with exit 64 and an `error:` line on stderr.
- `watch-status-only` prints one snapshot and exits (Babysit `check` mode).
- `watch-pretty` renders the Markdown table `| PR | CI | Review | Merge |` from the same verdict JSON uses.

## How to get to it (user POV)

- From the Babysit playbook (`skills/poteto-mode/playbooks/babysit.md`), run `scripts/watch-pr/watch-pr` directly when the active forge is GitHub.
- Pass `--status-only` for a one-shot check ("check on PR N").
- Pass `--pretty` for the human four-column table; omit it for JSON (NDJSON while polling).
- Pass `--owner`, `--repo`, and `--pr` when not inferring context from `gh`.
- Use `--stack` or `--queued-stack --stack-prs <n,...>` only when babysitting a stack. Queued mode requires `--stack-prs`.

## Driving it with control-temari

Preconditions:

- bun deps are installed (`control-temari doctor` shows `watch_pr_help=yes`).
- For `--status-only` against a live PR: `gh` can read that repository. Skip the live snapshot if auth or the PR number is missing; do not invent a PR.
- Do not already have a poller running for the same owner/repo/pr.

- **Show help.** Ask the watcher what it does. Run `control-temari capture 01-watch-pr-help -- watch-pr -- --help`. Exit 0. Stdout contains `Watch one pull request, a connected stack, or an immutable queued stack.`, `--status-only`, `--pretty`, `--queued-stack`, and `--stack-prs`.
- **Reject unbounded poll.** Attempt a bare watch. Run `control-temari watch-pr -- --owner example --repo example --pr 1`. The helper exits 2 with `refuse unbounded watch-pr` and does not start bun. That refusal is the proof the harness will not leave a poller.
- **Usage error.** Run `control-temari watch-pr -- --help >/dev/null`; then run `control-temari bun -- skills/poteto-mode/scripts/watch-pr/watch-pr --unknown`. Exit 64. Stderr contains `error: unknown option '--unknown'`.
- **Live status (when a PR exists).** Take one snapshot. Run `control-temari watch-pr -- --status-only --pretty --owner <owner> --repo <repo> --pr <n>`. A successful snapshot exits 0 and `--pretty` stdout contains `| PR | CI | Review | Merge |`. A context/auth/query failure is a `BLOCKER` / `status-query` verdict and exits 7 (the CLI `--status-only` help string still says "exit 0"; that is product help, not the process exit). JSON mode (omit `--pretty`) is one JSON object that `JSON.parse` accepts; check it with `control-temari bun -- -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$EVIDENCE/<stem>.stdout.txt"`.
- **Proof.** Keep the help transcript and, if the live path ran, the status transcript. Re-read `01-watch-pr-help.stdout.txt` and confirm the description line is still present. Confirm via `ps` that no watch-pr PID from this run remains, or via `cleanup` if `start-watch-pr` was used.

## Gotchas

- Origin (`origin pr ...`) is a different babysit path. This watcher is GitHub-only. Do not call a GitHub JSON blob proof of Origin behavior.
- `--status-only` against a missing or unauthorized repo is not exit 0. Expect exit 7 and a `status-query` BLOCKER, then mark the live snapshot `verified-unreachable` only if `gh` cannot read any real PR.
- `--stack-prs` without `--queued-stack` is a usage error. `--stack` and `--queued-stack` conflict.
- `--timeout 0` disables the deadline, which is unbounded together with missing `--status-only`. The helper treats that as refuse.
- `start-watch-pr` is the only supported way to background the watcher. Cleanup kills recorded PIDs only. Never `pkill watch-pr`.
- Unit tests use `fakeReader`. That is not a user path. Do not import `fakes.test-helper.ts` from a verification drive.
