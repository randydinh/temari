import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCandidateIdentity } from './workflow-receipt.js';
test('candidate identity explicitly versions Git products without changing old receipts', () => {
  for (const scope of ['local-regular-files-v1', 'git-tracked-files-v1'])
    assert.doesNotThrow(() =>
      assertCandidateIdentity({ scope, sha256: 'a'.repeat(64) }),
    );
  for (const value of [
    { scope: 'git-files', sha256: 'a'.repeat(64) },
    { scope: 'git-tracked-files-v1', sha256: 'bad' },
    {
      scope: 'git-tracked-files-v1',
      sha256: 'a'.repeat(64),
      ignore: ['private'],
    },
  ])
    assert.throws(() => assertCandidateIdentity(value));
});
