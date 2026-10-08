import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Resolve the one typed implementation from the verified canonical artifact.
export async function gitRuntime() {
  const root = fileURLToPath(new URL('../runtime/', import.meta.url));
  const consumer = createRequire(pathToFileURL(join(root, 'consumer.mjs')));
  return import(pathToFileURL(consumer.resolve('@temari/runtime')).href);
}
export async function verifyGitCandidate(root, commit, dependencies) {
  const runtime = await gitRuntime();
  const observed = runtime.observePinnedDependencies(root, commit);
  if (dependencies !== undefined)
    runtime.verifyPinnedDependencies(root, dependencies);
  assert.equal(
    runtime.localGit(root, ['rev-parse', 'HEAD']).toString().trim(),
    commit,
    'Candidate HEAD changed.',
  );
  assert.equal(
    runtime.localGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]).length,
    0,
    'Candidate must be clean.',
  );
  return observed;
}
