import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SqliteImmutableArtifactProvider } from './sqlite-artifact-provider.js';

test('SQLite artifacts reopen with path-free, revision-bound references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx05-artifacts-'));
  const path = join(root, 'artifacts.sqlite');
  let store = await SqliteImmutableArtifactProvider.open(path);
  try {
    const reference = await store.put({
      runId: 'run-a',
      revision: 'revision-a',
      kind: 'worker-result',
      content: 'verified bytes',
    });
    if (process.platform !== 'win32') {
      assert.equal((await lstat(path)).mode & 0o077, 0);
    }
    assert.deepEqual(Object.keys(reference).sort(), [
      'bytes',
      'kind',
      'revision',
      'runId',
      'schema',
      'sha256',
    ]);
    store.close();
    store = await SqliteImmutableArtifactProvider.open(path);
    assert.equal(
      Buffer.from(await store.load(reference)).toString('utf8'),
      'verified bytes',
    );
    await assert.rejects(
      store.load({ ...reference, revision: 'revision-b' }),
      /absent/,
    );
    await assert.rejects(
      store.load({ ...reference, path: '/some/local/path' } as any),
      /reference fields/,
    );
    const secondRun = await store.put({
      runId: 'run-b',
      revision: 'revision-b',
      kind: 'verification',
      content: 'verified bytes',
    });
    assert.equal(secondRun.sha256, reference.sha256);
    assert.equal(
      Buffer.from(await store.load(secondRun)).toString('utf8'),
      'verified bytes',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'SQLite artifact provider refuses a symlinked database file',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'temari-nx05-artifacts-'));
    const target = join(root, 'target.sqlite');
    const link = join(root, 'link.sqlite');
    try {
      await writeFile(target, 'not a database', { mode: 0o600 });
      await symlink(target, link);
      await assert.rejects(
        SqliteImmutableArtifactProvider.open(link),
        /regular file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('SQLite artifact reads refuse tampered bytes and missing bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx05-artifacts-'));
  const path = join(root, 'artifacts.sqlite');
  const store = await SqliteImmutableArtifactProvider.open(path);
  try {
    const reference = await store.put({
      runId: 'run-a',
      revision: 'revision-a',
      kind: 'verification',
      content: 'original',
    });
    const other = new DatabaseSync(path);
    try {
      other
        .prepare('UPDATE artifacts SET bytes = ? WHERE sha256 = ?')
        .run(Buffer.from('modified'), reference.sha256);
    } finally {
      other.close();
    }
    await assert.rejects(store.load(reference), /hash changed/);
    await assert.rejects(
      store.load({ ...reference, runId: 'another-run' }),
      /absent/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
