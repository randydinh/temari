# Source host entry task continuity

Implementation candidate: `ef18eff`. Base: `a81cdf1`, which already integrates
main through `8e3ddc4`. Verified locally on macOS arm64 on 2026-09-30.

## Delivered journey

The existing source host entry now accepts an optional, separately hash-pinned
task selection. It links the selected host conversation and saves a recovery
handoff before stage dispatch. Completion or interruption saves an outcome
handoff, with original invocation, checkpoint, receipt and evidence locations.
The source command is available through `workflow-runtime:host-entry`.

The tracking file remains outside the invocation descriptor and its candidate
digest. A retained task binding prevents changing or dropping the task during
resume. Its complete bytes are published before the initial checkpoint.
Checkpoints, receipts and execution decisions stay with the existing
runtime. Candidate-profile host receipts are context references pending trusted
closeout; they do not enter the simpler task-run verifier or set `DONE`.

See the [operator guide](../../docs/migrations/host-session.md#track-the-host-journey-as-a-durable-task)
for the exact interface and recovery procedure.

## Proportional verification

| Outcome and risk                                                                              | Minimum check                                                                                                                               | Observed result                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Automatic bookkeeping across process loss; durable state and asynchronous ordering            | Real source host child processes execute candidate changes, exit after an acknowledged build, and resume remaining stages in a second chat  | Passed; acknowledged build is not repeated and the invocation descriptor remains byte-identical |
| Hard kill and duplicate entry; repeated commands must not duplicate task history              | Kill before first stage acknowledgment, recover the starting handoff, then resume using the same tracking file                              | Passed; one entry and one starting handoff, followed by one final handoff                       |
| Crash before the first handler; retained progress must not lose its task selection            | Exit immediately after saving the initial empty checkpoint, attempt untracked resume, then resume with the original selection               | Untracked resume refused; tracked resume completes the stages                                   |
| Crash while writing the task binding; incomplete bytes must not become the retained selection | Exit after writing the first ten bytes of the temporary binding, then retry publication                                                     | No partial final binding; retry publishes valid complete JSON and is idempotent                 |
| Prior canonical work; source bookkeeping must not misrepresent completion                     | Track an existing task with a bound canonical run                                                                                           | Refused before stage dispatch; task state remains unchanged                                     |
| Wrong task or untrusted selection; task scope must be explicit                                | Missing/incorrect digest, changed run/candidate, overlapping task store, stale version, omitted tracking on resume, and task-switch attempt | Refused before any stage; invalid initial selections create no logical task                     |
| Concurrent task progress; late host result must not overwrite another chat                    | Edit next action during host execution, then finish canonical work                                                                          | Host receipt remains PASS, task edit remains intact, tracking failure exits nonzero             |
| Existing entry and artifact contract; changed module closure must remain portable             | Copied host modules and compiled runtime, plus isolated public-entry artifact checks and existing denial cases                              | Host-session and public-entry suites passed                                                     |

### Executed checks

- `workflow-runtime:host-session-test`: **53 passed**, zero failures/skips.
  [Retained output](2026-09-30-host-entry/host-session-test.log).
- `workflow-runtime:public-entry-test`: **45 passed**, zero failures/skips.
  [Retained output](2026-09-30-host-entry/public-entry-test.log).
- `git diff --check`: passed before candidate freeze.

The public-entry command initially failed because Bun was absent from the Node
launcher's PATH. Re-running with the existing `/opt/homebrew/bin` installation
explicitly on PATH passed. No package installation or public release was needed.
Both suites were rerun after the independent-review corrections and targeted
failure tests. Shared task/runtime TypeScript behavior was unchanged from the preceding
verified increment, so another broad runtime run was not required.

## Independent review

A separate reviewer inspected frozen candidate `2397bd9` and found three issues:

1. A crash after the initial checkpoint but before the first handler could omit
   the task binding and allow an untracked resume.
2. Writing directly to the final binding could leave partial JSON after a crash.
3. Reusing a task with prior canonical execution or acceptance could leave a
   misleading completion state while the source host did new work.

Candidate `ef18eff` pins the task selection before runtime progress, publishes
fsynced complete bytes without replacing an existing binding, and refuses tasks
with canonical run history or acceptance. Targeted failure tests cover each case.
Focused re-review of `ef18eff59496075a0e74ecf01df041cdb4461ab7` reported
**all three findings resolved, with no residual findings**. The reviewer inspected
the source/test delta independently and did not execute additional tests.

## Limits

This is an explicit source-host integration. The installed public skill does not
gain automatic chat capture or tracking from this source edit. The public artifact
builder includes the helper to preserve its module closure, but public start/resume
flags and policy are unchanged. No installed plugin was replaced or published.
Existing tasks with canonical runs or acceptance must use their existing run
controls and closeout. A crash before any initial checkpoint remains subject to
the original host recovery policy; this increment does not make a partial start
resumable without that checkpoint.

The process tests use a deterministic parent responder and actual filesystem
changes. They verify transport, persistence and recovery, not live model behavior,
an independent feature-verification receipt, or a production scheduler. Existing
cooperative local filesystem and single-parent host assumptions remain. No new
Windows or mobile proof is claimed, and host PASS remains pending trusted closeout.
