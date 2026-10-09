# Evaluator-only reference

Never supply this file to workers. Every listed criterion is required; mark a
criterion false if a material detail is omitted or contradicted. Inspect exact
snapshot line numbers in `plan.json` source, not a later mutable checkout. Audit
raw tool events separately after blind judgments for outside-source/evaluator reads
or external calls; reject contaminated trials even if their prose is correct.
The source-access-controls criterion on every task requires this audit and an
explicit true judgment before the report can credit quality.

## Investigation

- accurate-citations: citations resolve to the supplied source.ts and actually
  support claims; no execution claims (the task is static investigation).
- termination-and-timeout: POSIX negative PID process group versus Windows PID;
  SIGKILL; timeout and abort/cancellation trigger termination; zero timeout invalid.
- capture-failure-recovery: exclusive wx+ capture files; stream write/capture failures
  terminate child; partial persisted bytes are reread to recompute hash/size;
  diagnostics retained; sync/close errors affect capture completeness. Setup failures
  return an unstarted record, not success.
- stdin-exceptions: EPIPE and ECONNRESET ignored; other stdin errors retained and
  process terminated.
- capture-versus-exit: captureComplete combines both streams complete and every
  retained diagnostic complete (source lines 443–446). A successfully retained
  diagnostic can describe an operational error; captureComplete does not imply
  absence of errors. It is not code===0, and timeout/cancel/code
  are separate fields. Accurate limitations and caller responsibility are needed.

## Synthetic QA

- synthetic-scope: synthetic staging evidence only, build 2.4.1, Firefox 131,
  account demo-7, no production test or full QA/release acceptance.
- observed-versus-reported: Mina observed forced HTTP 503, exact banner and both
  retained filters; E1/E2 are fixture references. Theo's five-second auto-retry is
  attributed, not presented as independently observed.
- not-run: recovery success, duplicate click, Chrome, mobile, keyboard focus all
  explicitly remain untested. Six minutes is fixture test time, not reviewer time.
- expectation-gap: R-17 approves error display/filter preservation; retry timing
  lacks approved expectation. Do not silently adopt Theo's implementation as spec.
- owners-and-next-actions: Jules decides retry expectation; Mina runs recovery and
  duplicate-click checks after decision. Other not-run coverage remains visible.

## Synthetic revision

- exact-retry-replacement: exactly the requested two-sentence replacement paragraph.
- exact-owner-change: only Escalation Owner: Operations becomes Owner: Support.
- unchanged-sections: Scope, Evidence (both lines), Priority and Retention unchanged;
  headings, blank lines and final newline preserved from the delimited draft.
- no-extra-content: no synthetic label, delimiters, code fences or commentary.

For exact revision comparison, extract the bytes between `---BEGIN DRAFT---\n`
and `---END DRAFT---`, apply the two literal replacements from the task, and compare
with the retained final.txt. A changed unchanged-section byte fails the criterion.
