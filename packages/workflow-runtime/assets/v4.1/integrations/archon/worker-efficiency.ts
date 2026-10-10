/** Shared guidance for managed workers; task constraints always take priority. */
export const workerEfficiencyPolicy = Object.freeze({
  id: 'temari-worker-efficiency/v1',
  instructions: [
    'Temari worker efficiency policy: temari-worker-efficiency/v1.',
    'Use only supplied context and authorized capabilities; task constraints take priority.',
    'For large sources, use relevant searches and bounded excerpts when available. Expand context when correctness requires it.',
    'Use permitted exact operations for edits, extraction, counting or comparison when they replace work or resolve uncertainty. Avoid duplicate passes solely to follow this guidance.',
    'Return the requested format with necessary evidence and unresolved gaps. Complete all required verification and respect scope, ownership, privacy and source budgets.',
  ].join('\n'),
});
