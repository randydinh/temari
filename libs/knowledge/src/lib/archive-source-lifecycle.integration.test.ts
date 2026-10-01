import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { actualFixture, documents } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { canonical, hash } from './codec.js';
import { recaptureArchiveSource } from './archive-source-lifecycle.js';

const exec = promisify(execFile);

function optionsFor(
  f: Awaited<ReturnType<typeof actualFixture>>,
  taskId: string,
) {
  return {
    task: {
      id: taskId,
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
}

async function graphFor(
  f: Awaited<ReturnType<typeof actualFixture>>,
  publicationPath: string,
): Promise<string> {
  const before = await loadArchivePublication(publicationPath);
  async function cli(args: string[]) {
    const { stdout } = await exec(
      f.config.python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        join(f.base, 'state'),
        ...args,
      ],
      {
        cwd: f.config.registrarSource,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(f.config.registrarSource, 'src'),
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        timeout: 60000,
        maxBuffer: 1_048_576,
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  async function anchor(path: string) {
    const read = await cli([
      'read',
      f.source.id,
      before.generation,
      path,
      '--manifest-sha256',
      before.manifestSha256,
      '--max-chars',
      '8',
    ]);
    const citation = (
      read['record'] as { citations: Array<Record<string, unknown>> }
    ).citations[0];
    return {
      source_id: f.source.id,
      generation: before.generation,
      manifest_sha256: before.manifestSha256,
      path,
      original_sha256: citation['original_sha256'],
      representation_sha256: citation['representation_sha256'],
      text_start: citation['text_start'],
      text_end: citation['text_end'],
      quote: citation['quote'],
      quote_sha256: hash(citation['quote'] as string),
    };
  }
  const [plan, update] = await Promise.all([
    anchor('plan.txt'),
    anchor('update.txt'),
  ]);
  const id = (n: number) => String(n).repeat(32);
  const batch = join(f.base, 'recapture-graph.json');
  await writeFile(
    batch,
    JSON.stringify({
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          {
            source_id: f.source.id,
            generation: before.generation,
            manifest_sha256: before.manifestSha256,
          },
        ],
      },
      parent: null,
      nodes: [
        {
          id: id(1),
          kind: 'mention',
          label: 'plan',
          provenance: 'extracted',
          anchors: [plan],
        },
        {
          id: id(2),
          kind: 'mention',
          label: 'update',
          provenance: 'extracted',
          anchors: [update],
        },
      ],
      assertions: [
        {
          id: id(3),
          kind: 'relationship',
          subject: id(1),
          predicate: 'links-to',
          object: id(2),
          support: [update],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
      ],
    }),
  );
  const published = await cli(['graph-publish', batch]);
  assert.equal(published['status'], 'complete');
  return published['graph_id'] as string;
}

test('ACTUAL ARCHIVE CLI: recapture hands off pinned diff and optional graph review without changing historical v1', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-recapture');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const graphId = await graphFor(f, before.publicationPath);
  const changed =
    'Changed plan private text; no body in the recapture handoff.';
  const added = 'New private content';
  await writeFile(join(f.base, 'sources/plan.txt'), changed);
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(join(f.base, 'sources/new.txt'), added);
  const result = await recaptureArchiveSource({
    beforePublicationPath: before.publicationPath,
    after: { ...options, requestKey: 'after' },
    beforeGraphId: graphId,
  });
  assert.equal(result.status, 'handoff', JSON.stringify(result));
  const receipt = result.receipt;
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.graphMutation, 'none');
  assert.notEqual(receipt.before.generation, receipt.after.generation);
  assert.deepEqual(receipt.diff.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
  });
  assert.deepEqual(receipt.graphImpact?.counts, {
    needsReview: 2,
    needRepin: 1,
    historicalOnly: 0,
    needDiscovery: 2,
  });
  assert.equal(receipt.captureAttemptPath, result.capture.attemptPath);
  assert.equal(receipt.captureResultPath, result.capture.resultPath);
  const saved = await readFile(result.receiptPath, 'utf8');
  assert(!saved.includes(changed) && !saved.includes(added));
  const original = await createArchiveRegistrar({
    publications: [before.publicationPath],
    readScope: 'source-root',
  });
  const v1 = await original.read({
    document: { source: f.source, path: 'plan.txt' },
    expectedSha256: hash(documents['plan.txt']),
    maxCodePoints: 8000,
    maxBytes: 65536,
    continuation: null,
  });
  assert(v1.ok);
  assert.match(v1.value.evidence.excerpt, /Proposal plan/);
  assert.equal(
    await readFile(join(f.base, 'sources/update.txt'), 'utf8'),
    documents['update.txt'],
  );

  const attemptsBefore = (await readdir(options.task.directory)).filter(
    (name) => name.startsWith('archive-attempt-'),
  ).length;
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: { ...options, requestKey: 'after' },
    }),
    /Fresh archive request key required/,
  );
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: {
        ...options,
        task: { ...options.task, id: 'changed-task' },
        requestKey: 'changed-task',
      },
    }),
    /Recapture task changed/,
  );
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: {
        ...options,
        source: { ...options.source, id: 'different-source' },
        requestKey: 'changed-source',
      },
    }),
    /Recapture source changed/,
  );
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: {
        ...options,
        transport: { ...options.transport, timeoutMs: 1000 },
        requestKey: 'changed-transport',
      },
    }),
    /Recapture transport scope changed/,
  );
  const attemptsAfter = (await readdir(options.task.directory)).filter((name) =>
    name.startsWith('archive-attempt-'),
  ).length;
  assert.equal(attemptsAfter, attemptsBefore);
});

test('ACTUAL ARCHIVE CLI: recapture honors a smaller pinned transport cap during graph preflight', async () => {
  const f = await actualFixture();
  const base = optionsFor(f, 'source-recapture-small-cap');
  const options = {
    ...base,
    transport: { ...base.transport, maxStdoutBytes: 16000 },
  };
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const beforeGraphId = await graphFor(f, before.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Small-cap recapture change.',
  );
  const result = await recaptureArchiveSource({
    beforePublicationPath: before.publicationPath,
    after: { ...options, requestKey: 'after' },
    beforeGraphId,
  });
  assert.equal(result.status, 'handoff');
  assert.equal(result.receipt.diff.counts.changed, 1);
  assert(result.receipt.graphImpact);
});

test('ACTUAL ARCHIVE CLI: changed admission and tampered v1 pin refuse before recapture', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-recapture-refusal');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const input = {
    beforePublicationPath: before.publicationPath,
    after: { ...options, requestKey: 'after' },
  };
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
  await assert.rejects(recaptureArchiveSource(input), /disabled/);
  assert.equal(
    (await readdir(options.task.directory)).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    1,
  );
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=True; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(f.base, 'state/registry.sqlite3'),
      f.source.id,
    ],
    { timeout: 60000 },
  );
  const publication = JSON.parse(
    await readFile(before.publicationPath, 'utf8'),
  );
  const forgedTask = {
    ...publication,
    task: { ...publication.task, id: 'forged-task' },
  };
  await writeFile(before.publicationPath, canonical(forgedTask));
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: { ...options, task: forgedTask.task, requestKey: 'forged-task' },
    }),
    /Original capture binding task changed/,
  );
  assert.equal(
    (await readdir(options.task.directory)).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    1,
  );
  await writeFile(before.publicationPath, canonical(publication));
  publication.manifestSha256 = '0'.repeat(64);
  await writeFile(before.publicationPath, canonical(publication));
  await assert.rejects(recaptureArchiveSource(input), /manifest|integrity/i);
  assert.equal(
    (await readdir(options.task.directory)).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    1,
  );
});

test('ACTUAL ARCHIVE CLI: incomplete v2 remains explicit and invalid graph refuses before capture', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-recapture-incomplete');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  await writeFile(
    join(f.base, 'sources/oversize.bin'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const incomplete = await recaptureArchiveSource({
    beforePublicationPath: before.publicationPath,
    after: { ...options, requestKey: 'oversize' },
  });
  assert.equal(incomplete.status, 'blocked');
  assert.equal(incomplete.reason, 'incomplete-preservation');
  assert.equal(incomplete.capture.status, 'published');
  assert(incomplete.capture.publicationPath);
  assert(await readFile(incomplete.capture.attemptPath, 'utf8'));
  await rm(join(f.base, 'sources/oversize.bin'));
  const attemptsBefore = (await readdir(options.task.directory)).filter(
    (name) => name.startsWith('archive-attempt-'),
  ).length;
  await assert.rejects(
    recaptureArchiveSource({
      beforePublicationPath: before.publicationPath,
      after: { ...options, requestKey: 'invalid-graph' },
      beforeGraphId: 'a'.repeat(64),
    }),
    /Prior graph unavailable/,
  );
  assert.equal(
    (await readdir(options.task.directory)).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    attemptsBefore,
  );
});
