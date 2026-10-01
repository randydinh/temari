import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { observeGitReconciliation } from './git-reconciliation-observer.js';

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'temari-git-observer-test-'));
  git(root, ['init', '-q', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

test('observes merge-relevant state without changing status, index, or file bytes', async () => {
  const root = await repository();
  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  await writeFile(join(root, 'untracked.txt'), 'untracked\n');
  const before = {
    status: git(root, ['status', '--porcelain=v2', '--untracked-files=all']),
    index: await readFile(join(root, '.git', 'index')),
    tracked: await readFile(join(root, 'tracked.txt')),
    untracked: await readFile(join(root, 'untracked.txt')),
  };

  const observed = await observeGitReconciliation(root);

  assert.equal(observed.operation, 'none');
  assert.match(observed.porcelainSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(observed.untrackedPaths, ['untracked.txt']);
  assert.deepEqual(
    observed.paths.map((entry) => entry.path),
    ['tracked.txt', 'untracked.txt'],
  );
  assert.match(
    observed.paths.find((entry) => entry.path === 'tracked.txt')!.diffSha256,
    /^[0-9a-f]{64}$/,
  );
  assert.deepEqual(
    {
      status: git(root, ['status', '--porcelain=v2', '--untracked-files=all']),
      index: await readFile(join(root, '.git', 'index')),
      tracked: await readFile(join(root, 'tracked.txt')),
      untracked: await readFile(join(root, 'untracked.txt')),
    },
    before,
  );
});

test('observes active merge stages without changing the conflicted repository', async () => {
  const root = await repository();
  git(root, ['checkout', '-qb', 'other']);
  await writeFile(join(root, 'tracked.txt'), 'other\n');
  git(root, ['commit', '-am', 'other']);
  git(root, ['checkout', '-q', 'main']);
  await writeFile(join(root, 'tracked.txt'), 'main\n');
  git(root, ['commit', '-am', 'main']);
  assert.throws(() => git(root, ['merge', 'other']));
  const before = {
    status: git(root, ['status', '--porcelain=v2', '--untracked-files=all']),
    index: await readFile(join(root, '.git', 'index')),
    tracked: await readFile(join(root, 'tracked.txt')),
  };

  const observed = await observeGitReconciliation(root);

  assert.equal(observed.operation, 'merge');
  assert.deepEqual(observed.unmerged.map((entry) => entry.path), ['tracked.txt']);
  assert.deepEqual(
    observed.unmerged[0]!.stages.map((entry) => entry.stage),
    [1, 2, 3],
  );
  assert.deepEqual(
    {
      status: git(root, ['status', '--porcelain=v2', '--untracked-files=all']),
      index: await readFile(join(root, '.git', 'index')),
      tracked: await readFile(join(root, 'tracked.txt')),
    },
    before,
  );
});

test('rejects a missing directory and a repository subdirectory', async () => {
  await assert.rejects(observeGitReconciliation(join(tmpdir(), 'missing-repository')));
  const root = await repository();
  await assert.rejects(
    observeGitReconciliation(join(root, '.git')),
    /Repository root|Read-only Git observation/,
  );
});
