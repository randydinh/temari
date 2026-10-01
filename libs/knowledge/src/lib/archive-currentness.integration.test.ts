import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actualFixture, documents } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import { auditArchiveCurrentness } from './archive-currentness.js';
import { archiveTransport } from './archive-transport.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: pinned local currentness audit reports changed, added, removed, unchanged and unknown originals', async () => {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'currentness-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root',
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'currentness-before',
  });
  assert(captured.publicationPath);
  const publication = await loadArchivePublication(captured.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'A newer plan with different bytes.',
  );
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(join(f.base, 'sources/new.txt'), 'An added source document.');
  const input = { publicationPath: captured.publicationPath };
  const { receiptPath, receipt } = await auditArchiveCurrentness(input);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.currentOriginal, 'observed-point-in-time');
  assert.equal(receipt.consistency, 'declared-selection-not-atomic');
  assert.deepEqual(
    receipt.added.map((item) => item.path),
    ['new.txt'],
  );
  assert.deepEqual(
    receipt.removed.map((item) => item.path),
    ['owner.txt'],
  );
  assert.deepEqual(
    receipt.changed.map((item) => item.path),
    ['plan.txt'],
  );
  assert.deepEqual(
    receipt.unchanged.map((item) => item.path),
    ['dependency.txt', 'update.txt'],
  );
  assert.deepEqual(receipt.unavailable, []);
  assert.equal(receipt.changed[0].archived.sha256, hash(documents['plan.txt']));
  assert.equal(
    receipt.changed[0].current.sha256,
    hash('A newer plan with different bytes.'),
  );
  assert.equal(
    receipt.added[0].current.sha256,
    hash('An added source document.'),
  );
  const saved = await readFile(receiptPath, 'utf8');
  assert(!saved.includes('A newer plan') && !saved.includes('Proposal plan'));

  const transport = await archiveTransport(publication.transport);
  const historical = await transport.invoke('read', [
    f.source.id,
    publication.generation,
    'plan.txt',
    '--manifest-sha256',
    publication.manifestSha256,
    '--max-chars',
    '80',
  ]);
  assert.equal(historical['status'], 'complete');
  assert(JSON.stringify(historical).includes('Proposal plan'));

  await writeFile(
    join(f.base, 'sources/oversized.txt'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const partial = (await auditArchiveCurrentness(input)).receipt;
  assert.equal(partial.status, 'partial');
  assert.deepEqual(
    partial.unavailable.map((item) => item.path),
    ['oversized.txt'],
  );
  assert(!partial.unchanged.some((item) => item.path === 'oversized.txt'));
  await rm(join(f.base, 'sources/oversized.txt'));

  const originalPublication = await readFile(captured.publicationPath, 'utf8');
  const tampered = JSON.parse(originalPublication);
  tampered.manifestSha256 = '0'.repeat(64);
  await writeFile(captured.publicationPath, JSON.stringify(tampered));
  await assert.rejects(auditArchiveCurrentness(input));
  await writeFile(captured.publicationPath, originalPublication);

  await rm(join(f.base, 'sources/update.txt'));
  await writeFile(join(f.base, 'outside.txt'), 'Outside source root.');
  await symlink(
    join(f.base, 'outside.txt'),
    join(f.base, 'sources/update.txt'),
  );
  const linked = (await auditArchiveCurrentness(input)).receipt;
  assert.equal(linked.status, 'partial');
  assert.deepEqual(
    linked.unavailable.map((item) => item.path),
    ['update.txt'],
  );
  assert.equal(linked.unavailable[0].reason, 'current-not-regular-file');
  assert(!linked.unchanged.some((item) => item.path === 'update.txt'));
  await rm(join(f.base, 'sources/update.txt'));
  await writeFile(join(f.base, 'sources/update.txt'), documents['update.txt']);

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
  await assert.rejects(auditArchiveCurrentness(input));
});
