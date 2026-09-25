export type QaReviewScope = 'full' | 'explicitly-narrow';

export type QaEvaluatorVerdict = 'PASS' | 'REVISE' | 'BLOCKED';

export type QaBehaviorResult = 'passed' | 'failed' | 'blocked';

export type QaReviewDisposition =
  'Passed' | 'Failed' | 'BlockedOrIncomplete' | 'NarrowReviewOnly';

export type QaDispositionReason =
  | 'narrow-scope'
  | 'evaluator-revise'
  | 'evaluator-blocked'
  | 'behavior-blocked'
  | 'behavior-failed'
  | 'behavior-passed';

export interface QaDispositionInput {
  readonly scope: QaReviewScope;
  readonly evaluatorVerdict: QaEvaluatorVerdict;
  readonly behaviorResult: QaBehaviorResult;
}

export interface QaDispositionDecision {
  readonly disposition: QaReviewDisposition;
  readonly reason: QaDispositionReason;
}

/**
 * Derives the product-facing QA result from domain facts.
 *
 * This is separate from the workflow receipt. The receipt records procedural
 * execution, while this decision records the QA domain outcome.
 */
export function deriveQaDisposition(
  input: QaDispositionInput,
): QaDispositionDecision {
  if (input.scope === 'explicitly-narrow') {
    return { disposition: 'NarrowReviewOnly', reason: 'narrow-scope' };
  }

  if (input.evaluatorVerdict === 'REVISE') {
    return { disposition: 'BlockedOrIncomplete', reason: 'evaluator-revise' };
  }

  if (input.evaluatorVerdict === 'BLOCKED') {
    return { disposition: 'BlockedOrIncomplete', reason: 'evaluator-blocked' };
  }

  if (input.behaviorResult === 'blocked') {
    return { disposition: 'BlockedOrIncomplete', reason: 'behavior-blocked' };
  }

  if (input.behaviorResult === 'failed') {
    return { disposition: 'Failed', reason: 'behavior-failed' };
  }

  return { disposition: 'Passed', reason: 'behavior-passed' };
}
