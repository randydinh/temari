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
    evidenceReferences: [
      {
        schema: 1 as const,
        runId: 'run-1',
        revision: 'revision-1',
        kind: 'worker-result' as const,
        sha256: 'a'.repeat(64),
        bytes: 42,
      },
    ],
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

test('rejects non-portable worker evidence identities', () => {
  const issues = validateWorkerResult({
    status: 'PASS',
    summary: 'Result',
    evidencePaths: ['checkpoint.json'],
    rawLogPath: null,
    evidenceReferences: [
      {
        schema: 1,
        runId: 'run-1',
        revision: 'revision-1',
        kind: 'worker-result',
        sha256: '/tmp/provider.log',
        bytes: -1,
      },
    ],
  });

  assert(issues.some((issue) => issue.includes('sha256')));
  assert(issues.some((issue) => issue.includes('bytes')));
});
