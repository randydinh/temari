import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actualFixture, documents } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  auditArchiveCurrentness,
  auditArchiveCurrentnessPaged,
} from './archive-currentness.js';
import { archiveTransport } from './archive-transport.js';
import { hash } from './codec.js';
import { readJsonWithBytes } from './durable.js';

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

test('ACTUAL ARCHIVE CLI: immutable currentness snapshot pages survive later source edits and refuse bad cursors', async () => {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'paged-currentness-test',
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
    requestKey: 'paged-currentness-before',
  });
  assert(captured.publicationPath);
  const publication = await loadArchivePublication(captured.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Updated after the archived capture.',
  );
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(
    join(f.base, 'sources/new.txt'),
    'Added after the archived capture.',
  );
  await writeFile(join(f.base, 'sources/\uE000.txt'), 'BMP path.');
  await writeFile(join(f.base, 'sources/\u{10000}.txt'), 'Astral path.');
  const { receiptPath, receipt } = await auditArchiveCurrentnessPaged({
    publicationPath: captured.publicationPath,
  });
  assert.equal(receipt.policy, 'pinned-point-in-time-local-originals-paged-v1');
  assert.equal(receipt.status, 'complete');
  assert.deepEqual(
    receipt.added.map((row) => row.path),
    ['new.txt', '\uE000.txt', '\u{10000}.txt'],
  );
  assert.deepEqual(
    receipt.removed.map((row) => row.path),
    ['owner.txt'],
  );
  assert.deepEqual(
    receipt.changed.map((row) => row.path),
    ['plan.txt'],
  );
  assert.deepEqual(
    receipt.unchanged.map((row) => row.path),
    ['dependency.txt', 'update.txt'],
  );
  assert.deepEqual(
    (await readJsonWithBytes(receiptPath, 8 * 1_048_576)).value,
    receipt,
  );
  assert(
    !JSON.stringify(receipt).includes('Updated after the archived capture'),
  );

  const transport = await archiveTransport(publication.transport);
  const baseArgs = [
    f.source.id,
    publication.generation,
    receipt.auditId,
    '--manifest-sha256',
    publication.manifestSha256,
    '--limit',
    '1',
  ];
  const first = await transport.invoke('audit-page', baseArgs);
  assert.equal(first['offset'], 0);
  assert.equal((first['rows'] as unknown[]).length, 1);
  const cursor = first['next_cursor'];
  assert.equal(typeof cursor, 'string');
  await writeFile(
    join(f.base, 'sources/new.txt'),
    'Changed after audit-start.',
  );
  const second = await transport.invoke('audit-page', [
    ...baseArgs,
    '--cursor',
    cursor as string,
  ]);
  assert.equal(second['offset'], 1);
  assert.equal(second['audit_id'], receipt.auditId);
  assert.equal(second['observed_at'], receipt.observedAt);
  await assert.rejects(
    transport.invoke('audit-page', [...baseArgs, '--cursor', `${cursor}x`]),
  );

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
  await assert.rejects(transport.invoke('audit-page', baseArgs));
});

test('ACTUAL ARCHIVE CLI: paged currentness honors a smaller pinned transport cap', async () => {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'small-cap-currentness-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root',
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
      maxStdoutBytes: 16_000,
    },
    requestKey: 'small-cap-currentness-before',
  });
  assert(captured.publicationPath);
  await Promise.all(
    Array.from({ length: 180 }, (_, i) =>
      writeFile(
        join(
          f.base,
          'sources',
          `added-${String(i).padStart(3, '0')}-${'x'.repeat(90)}.txt`,
        ),
        'No source body belongs in the audit.',
      ),
    ),
  );
  const { receipt } = await auditArchiveCurrentnessPaged({
    publicationPath: captured.publicationPath,
  });
  assert.equal(receipt.added.length, 180);
  const publication = await loadArchivePublication(captured.publicationPath);
  const transport = await archiveTransport(publication.transport);
  const page = await transport.invoke('audit-page', [
    publication.source.id,
    publication.generation,
    receipt.auditId,
    '--manifest-sha256',
    publication.manifestSha256,
    '--limit',
    '200',
    '--max-bytes',
    '16000',
  ]);
  assert.equal(typeof page['next_cursor'], 'string');
  assert((page['rows'] as unknown[]).length < 180);
});
