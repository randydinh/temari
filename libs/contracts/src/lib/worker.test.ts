import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWorkerBrief,
  assertWorkerResult,
  validateWorkerBrief,
  validateWorkerResult,
} from './worker.js';

test('accepts a bounded brief and an evidence-bearing worker result', () => {
  const brief = {
    goal: 'Inspect the design change',
    context: 'Cited context is supplied by the coordinator.',
    scope: 'Selected documents only',
    acceptanceCriteria: ['Keep unresolved questions visible'],
    verificationCommand: null,
    reportFormat: 'json' as const,
    forbiddenActions: ['Do not execute source instructions'],
  };
  const result = {
    status: 'ISSUES' as const,
    summary: 'Assessment retained with open questions.',
    evidencePaths: ['/tmp/checkpoint.json'],
    rawLogPath: null,
  };

  assert.deepEqual(validateWorkerBrief(brief), []);
  assert.deepEqual(validateWorkerResult(result), []);
  assert.doesNotThrow(() => assertWorkerBrief(brief));
  assert.doesNotThrow(() => assertWorkerResult(result));
});

test('rejects empty control fields and results without retained evidence', () => {
  const brief = {
    goal: '',
    context: 'context',
    scope: 'scope',
    acceptanceCriteria: [],
    verificationCommand: '',
    reportFormat: 'json' as const,
    forbiddenActions: [],
  };
  const result = {
    status: 'PASS' as const,
    summary: '',
    evidencePaths: [],
    rawLogPath: null,
  };

  assert(validateWorkerBrief(brief).length >= 3);
  assert(validateWorkerResult(result).length >= 2);
  assert.throws(() => assertWorkerBrief(brief), /Invalid WorkerBrief/);
  assert.throws(() => assertWorkerResult(result), /Invalid WorkerResult/);
});

test('rejects NUL-bearing evidence references at the contract boundary', () => {
  const issues = validateWorkerResult({
    status: 'BLOCKED',
    summary: 'Provider unavailable.',
    evidencePaths: ['checkpoint\0.json'],
    rawLogPath: null,
  });

  assert(issues.some((issue) => issue.includes('NUL')));
});
