# Six-run local token-waste pilot

This is a **CLI-only** controlled comparison, not evidence of desktop behavior,
daily savings, credits, cost or universal improvement. The investigation uses a
real pinned source file; QA and accepted-draft revision are explicitly synthetic.
No live benchmark has been run as part of implementation.

From the repository root:

```sh
pnpm exec nx run runtime:token-pilot-test
node tools/token-waste-pilot.mjs --help
node tools/token-waste-pilot.mjs prepare --out /private/tmp/token-pilot-prepared --model YOUR_MODEL --reasoning medium
# Coordinator reviews plan/prompts first. This command makes live model calls:
node tools/token-waste-pilot.mjs run --plan /private/tmp/token-pilot-prepared/plan.json --out /private/tmp/token-pilot-run
node tools/token-waste-pilot.mjs report --run /private/tmp/token-pilot-run
# After independent review, save a separate completed review JSON:
node tools/token-waste-pilot.mjs report --run /private/tmp/token-pilot-run --review /private/tmp/review.json
```

Use fresh paths for every preparation/attempt. `prepare`, `report`, `--help` and
tests make zero model calls. The test CLI is a synthetic executable and its answers
and reviewer are test fixtures, not quality evidence. Live `run` requires a local
Codex CLI supporting the recorded flags. `--codex` accepts an executable path,
not a shell expression. Default timeout is five minutes per worker and raw stdout
plus stderr is bounded to 8 MiB per process; prepare can set `--timeout-ms` and
`--max-bytes`. POSIX process groups are required. Delete only generated attempt
and preparation directories to reverse the pilot; original sources are untouched.

## Controls

The plan pins model, reasoning, time/byte limits, SHA256 of source and exact
prompts, and the original investigation commit. Preparation checks that current
investigation source bytes match that commit. Source snapshots are frozen in the
plan; later source changes cannot change the workers' inputs. A and B receive the
same task source, question and output requirements. A asks for an ordinary efficient
workflow; it never requests exhaustive or inflated reads. B adds targeted search,
bounded reads/output, code for exact operations and a focused deliverable.

Six fresh ephemeral read-only `codex exec` processes run serially in order
investigation A/B, QA B/A, revision A/B. Each starts in the same temporary working
directory, containing only its source. User configuration and execpolicy rules are
ignored, project documentation is disabled, approval is never and web search is
disabled. Args and prompts are retained; model/reasoning are explicit and identical.
CLI version stdout/stderr and all per-process metadata are retained. No shell eval,
resume, automatic process retry, dependency installation or public runtime change.
Timeout/byte overflow sends SIGTERM, escalates to SIGKILL after 250 ms, and
invalidates measurement. SIGINT/SIGTERM received by the coordinator follows the
same group cleanup, retains interruption metadata, and stops the serial run.

Raw stdout JSONL, stderr, final response, elapsed wall time, process exit/signal,
limits, hashes and derived usage remain in each attempt directory. Invalid trials
are retained. An interrupted orchestration may lack the final mapping/template;
`report` still shows missing pairs as pending. Start a fresh directory for a new
attempt, retaining the old attempt rather than overwriting it.

Only `turn.completed.usage` counts, once per paired `turn.started`. Multiple
completed turns sum; duplicate/unpaired/overlapping completions and repeated turn
IDs invalidate the result. Started/completed IDs must match exactly, including
ID presence: both may omit IDs, but one-sided or contradictory IDs are rejected. `token_count` cumulative updates are ignored. Fields
must be nonnegative safe integers; cached input cannot exceed input. Missing fields
remain null; all three usage fields must be available for measurement. Reasoning
is not added to output again. Failed/error events, malformed JSONL, nonzero exit,
missing final, changed source or incomplete captures are invalid. No usage is
estimated from text length. The aggregate is `100 * (sum(A input+output) -
sum(B input+output)) / sum(A input+output)`; a zero denominator gives null.

## Independent blind review

Give the reviewer only `blind/`, the task questions/criteria in `tasks.json`, and
`gold.md`. Keep `mapping.json`, raw process artifacts, prompts and timing away from
the reviewer until judgments are recorded. Outputs have random task-specific IDs;
text is unmodified, so style may still reveal a variant. Do not claim perfect
blinding. Gold is evaluator-only and is never copied into worker workspaces or
included in worker prompts.

Copy `review-template.json` to a separate review file. For every output the human
must supply their identity, `independent: true`, an explicit `accepted` judgment,
a true/false result for **every** fixed criterion, actual `humanMinutes`, and a
`corrections` array describing corrections required (explicit `[]` only if none).
The template leaves all human judgments/time/corrections null. Keep output hashes
unchanged. A worker self-PASS is never acceptance. Record needed corrections even
when the final note is accepted; do not silently replace worker outputs. Substantive
unresolved defects require rejection. These are reviewer attestations, not an
identity authentication system. Do not use the synthetic tests' reviewer as evidence.

All three pairs require valid measured usage and accepted reviewed quality before
aggregate reduction is shown. Per-pair usage, input+output tokens, process wall time,
human review time and corrections are shown separately. Runner retries are observed
zero because there is one launch per trial; provider/CLI-internal retries are not
observable. Missing quality correction/time information is null.

## Validity gaps

One observation per variant per task cannot estimate variance or establish causal
or general savings. Alternating pair order only partially balances shared provider
cache and temporal/order effects. Cached input is a subset of input and is reported
separately, never added or subtracted from input+output totals. Model identifiers and
reasoning requests are pinned; effective server inference settings/model routing are
not independently exposed. CLI/tool/OS behavior and authentication environment are
shared, but provider behavior may change across calls. CLI wall time includes tools,
not just inference. Read-only sandboxing prevents source writes; it does **not**
confine filesystem reads. Prompts prohibit outside reads, network and evaluator
access; reviewers must audit raw command events before crediting the comparison.
An outside-source/evaluator access invalidates quality acceptance. These controls
are not a hostile-worker security boundary. Raw captures can contain local paths;
only random-ID final outputs are intended for blind distribution. Coordinator must
check outputs for identifying text before distributing, retaining original artifacts.

No desktop/daily extrapolation, cost/credits estimate, self-review acceptance,
external system modification, or Token Saver/Ringer installation is performed.

## Execution binding and interruption recovery

Version 2 plans retain the full execution argument template, including model,
reasoning and every config override. `run.json` binds the executable and plan hash.
`report` verifies each executed prompt against the prepared hash, exact argument
array against the plan, common working directory/executable, capture limits, and
launch/startup/final process identity. It also verifies the version invocation and
raw version hashes. Missing capture artifacts keep results pending; contradictory
bindings are refused with an error, even when human review accepts every output.
Old version 1 plans must be prepared again into a fresh directory.

Raw stdout/stderr files are created before spawn; each retained chunk is written
and fsynced incrementally within the combined byte bound. `launch.json` records
intent before spawn. `startup.json` immediately records coordinator PID, child PID,
POSIX process group, timestamp, cwd, exact args and prompt hash. `process.json` is
written only after closure. SIGINT/SIGTERM retain `interruption.json`; interrupted
captures cannot qualify as measurements. No replacement trial is launched.

SIGKILL, host failure and power loss cannot run signal handlers. Already synced
bytes and startup records remain, but bytes still in pipes may be lost, no final
process record is guaranteed, and detached workers may remain alive. There is a
small unavoidable spawn-to-startup-record window; launch intent alone cannot prove
whether a process started. Directory-entry durability after sudden power loss is
not guaranteed. Preserve the whole attempt and inspect local processes using the
recorded executable, arguments, timestamps and group identity before terminating
any survivor. PIDs may be reused: never blindly kill a PID from an old record.
Do not retry until surviving processes have been resolved; use a fresh directory
for any new attempt. `report` cannot certify cleanup after hard kill and never
turns an incomplete attempt into measured evidence. Retained hashes are consistency
checks in a trusted local artifact store, not signatures against coordinated edits.
