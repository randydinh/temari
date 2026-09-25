import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveQaDisposition } from './qa-review.js';

test('passes a complete full QA review when evaluator and behavior pass', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'full',
      evaluatorVerdict: 'PASS',
      behaviorResult: 'passed',
    }),
    { disposition: 'Passed', reason: 'behavior-passed' },
  );
});

test('preserves a behavior failure after evaluator approval', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'full',
      evaluatorVerdict: 'PASS',
      behaviorResult: 'failed',
    }),
    { disposition: 'Failed', reason: 'behavior-failed' },
  );
});

test('never treats an evaluator revision as a pass', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'full',
      evaluatorVerdict: 'REVISE',
      behaviorResult: 'passed',
    }),
    { disposition: 'BlockedOrIncomplete', reason: 'evaluator-revise' },
  );
});

test('blocks when fresh-context evaluation is unavailable', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'full',
      evaluatorVerdict: 'BLOCKED',
      behaviorResult: 'passed',
    }),
    { disposition: 'BlockedOrIncomplete', reason: 'evaluator-blocked' },
  );
});

test('blocks when observed behavior is incomplete', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'full',
      evaluatorVerdict: 'PASS',
      behaviorResult: 'blocked',
    }),
    { disposition: 'BlockedOrIncomplete', reason: 'behavior-blocked' },
  );
});

test('keeps a narrow assignment separate from a full product disposition', () => {
  assert.deepEqual(
    deriveQaDisposition({
      scope: 'explicitly-narrow',
      evaluatorVerdict: 'PASS',
      behaviorResult: 'passed',
    }),
    { disposition: 'NarrowReviewOnly', reason: 'narrow-scope' },
  );
});
