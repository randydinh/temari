import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actualFixture, documents } from '../support/fixtures.js';
import { captureArchive } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { diffArchiveGenerations } from './archive-generation-diff.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: explicit pinned generations report only retained original changes', async () => {
  const f = await actualFixture();
  const task = {
    id: 'generation-diff-test',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-explicit-admission',
  };
  const options = {
    task,
    source: f.source,
    readScope: 'source-root' as const,
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'before',
  };
  const before = await captureArchive(options);
  assert(before.publicationPath, await readFile(before.resultPath, 'utf8'));
  const changed =
    'A changed proposal; never copy this text into a diff receipt.';
  const added = 'A new private file body; receipt contains only its digest.';
  await writeFile(join(f.base, 'sources/plan.txt'), changed);
  await rm(join(f.base, 'sources/owner.txt'));
  await rename(
    join(f.base, 'sources/dependency.txt'),
    join(f.base, 'sources/dependency-renamed.txt'),
  );
  await writeFile(join(f.base, 'sources/new.txt'), added);
  await writeFile(
    join(f.base, 'sources/-notes.txt'),
    'A leading dash is a valid retained path.',
  );
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath, await readFile(after.resultPath, 'utf8'));

  const input = {
    beforePublicationPath: before.publicationPath,
    afterPublicationPath: after.publicationPath,
  };
  const { receiptPath, receipt } = await diffArchiveGenerations(input);
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.sourceId, f.source.id);
  assert.notEqual(receipt.before.generation, receipt.after.generation);
  assert.deepEqual(receipt.added, [
    {
      path: '-notes.txt',
      afterSha256: hash('A leading dash is a valid retained path.'),
    },
    {
      path: 'dependency-renamed.txt',
      afterSha256: hash(documents['dependency.txt']),
    },
    { path: 'new.txt', afterSha256: hash(added) },
  ]);
  assert.deepEqual(receipt.removed, [
    { path: 'dependency.txt', beforeSha256: hash(documents['dependency.txt']) },
    { path: 'owner.txt', beforeSha256: hash(documents['owner.txt']) },
  ]);
  assert.deepEqual(receipt.changed, [
    {
      path: 'plan.txt',
      beforeSha256: hash(documents['plan.txt']),
      afterSha256: hash(changed),
    },
  ]);
  assert.deepEqual(receipt.unchanged, [
    { path: 'update.txt', sha256: hash(documents['update.txt']) },
  ]);
  assert.deepEqual(receipt.counts, {
    added: 3,
    removed: 2,
    changed: 1,
    unchanged: 1,
  });
  const bytes = await readFile(receiptPath, 'utf8');
  assert(!bytes.includes(changed) && !bytes.includes(added));
  const repeat = await diffArchiveGenerations(input);
  assert.equal(repeat.receiptPath, receiptPath);
  assert.deepEqual(repeat.receipt, receipt);

  const historical = await createArchiveRegistrar({
    publications: [before.publicationPath],
    readScope: 'source-root',
  });
  const v1 = await historical.read({
    document: { source: f.source, path: 'plan.txt' },
    expectedSha256: hash(documents['plan.txt']),
    maxCodePoints: 8000,
    maxBytes: 65536,
    continuation: null,
  });
  assert(v1.ok, JSON.stringify(v1));
  assert.match(v1.value.evidence.excerpt, /Proposal plan/);

  const tampered = JSON.parse(await readFile(after.publicationPath, 'utf8'));
  tampered.manifestSha256 = '0'.repeat(64);
  await writeFile(after.publicationPath, JSON.stringify(tampered));
  await assert.rejects(diffArchiveGenerations(input));
});

test('ACTUAL ARCHIVE CLI: generation diff rejects revoked source registration', async () => {
  const f = await actualFixture();
  const options = {
    task: {
      id: 'generation-diff-revocation',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root' as const,
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'before',
  };
  const before = await captureArchive(options);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed before revocation',
  );
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(before.publicationPath && after.publicationPath);
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(f.base, 'state/registry.sqlite3'),
      f.source.id,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(
    diffArchiveGenerations({
      beforePublicationPath: before.publicationPath,
      afterPublicationPath: after.publicationPath,
    }),
  );
});
