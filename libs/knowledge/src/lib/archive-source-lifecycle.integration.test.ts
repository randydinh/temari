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
import {
  recaptureArchiveSource,
  recoverArchiveSourceAttempt,
  resumeArchiveSourceHandoff,
} from './archive-source-lifecycle.js';

const exec = promisify(execFile);

async function generationCount(
  f: Awaited<ReturnType<typeof actualFixture>>,
): Promise<number> {
  const { stdout } = await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT COUNT(*) FROM archive_generations').fetchone()[0])",
      join(f.base, 'state/registry.sqlite3'),
    ],
    { timeout: 60000 },
  );
  return Number(stdout.trim());
}

async function attemptCount(directory: string): Promise<number> {
  return (await readdir(directory)).filter((name) =>
    name.startsWith('archive-attempt-'),
  ).length;
}

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
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.kind, 'temari-archive-source-recapture');
  for (const key of [
    'beforeSelection',
    'captureAttemptSha256',
    'captureResultSha256',
    'captureBindingSha256',
  ])
    assert(!(key in receipt), `${key} must remain resume-only`);
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

test('ACTUAL ARCHIVE CLI: operator resumes a complete persisted v2 twice without a capture', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-resume');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const beforeGraphId = await graphFor(f, before.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed plan for persisted resume.',
  );
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(join(f.base, 'sources/new.txt'), 'New private resume text.');
  const after = await captureArchive({
    ...options,
    requestKey: 'after',
    limits: { entries: 500 },
  });
  assert.equal(after.status, 'published');
  assert(after.publicationPath);
  const baselineGenerations = await generationCount(f);
  const baselineAttempts = await attemptCount(options.task.directory);
  const input = {
    beforePublicationPath: before.publicationPath,
    resultPath: after.resultPath,
    beforeGraphId,
  };
  const first = await resumeArchiveSourceHandoff(input);
  assert.equal(first.receipt.schema, 1);
  assert.equal(first.receipt.kind, 'temari-archive-source-resume');
  assert.equal(first.receipt.beforeSelection, 'operator-selected-on-resume');
  assert.equal(
    first.receipt.captureAttemptSha256,
    hash(await readFile(after.attemptPath)),
  );
  assert.equal(
    first.receipt.captureResultSha256,
    hash(await readFile(after.resultPath)),
  );
  assert.equal(
    first.receipt.captureBindingSha256,
    hash(
      await readFile(
        join(
          options.task.directory,
          `archive-binding-${hash((await loadArchivePublication(after.publicationPath)).captureRequestKey)}.json`,
        ),
      ),
    ),
  );
  assert.equal(first.receipt.currentOriginal, 'not-checked');
  assert.equal(first.receipt.graphMutation, 'none');
  assert.deepEqual(first.receipt.diff.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
  });
  assert.deepEqual(first.receipt.graphImpact?.counts, {
    needsReview: 2,
    needRepin: 1,
    historicalOnly: 0,
    needDiscovery: 2,
  });
  assert.equal(first.capture.attemptPath, after.attemptPath);
  assert.equal(first.capture.resultPath, after.resultPath);
  const firstBytes = await readFile(first.receiptPath);
  assert(
    !firstBytes.toString('utf8').includes('Changed plan for persisted resume.'),
  );
  const second = await resumeArchiveSourceHandoff(input);
  assert.equal(second.receiptPath, first.receiptPath);
  assert.deepEqual(await readFile(second.receiptPath), firstBytes);
  assert.equal(await generationCount(f), baselineGenerations);
  assert.equal(await attemptCount(options.task.directory), baselineAttempts);
  const historical = await createArchiveRegistrar({
    publications: [before.publicationPath],
    readScope: 'source-root',
  });
  const old = await historical.read({
    document: { source: f.source, path: 'plan.txt' },
    expectedSha256: hash(documents['plan.txt']),
    maxCodePoints: 8000,
    maxBytes: 65536,
    continuation: null,
  });
  assert(old.ok);
  assert.match(old.value.evidence.excerpt, /Proposal plan/);

  const attemptBytes = await readFile(after.attemptPath, 'utf8');
  const attempt = JSON.parse(attemptBytes);
  attempt.options.limits.entries = 499;
  await writeFile(after.attemptPath, canonical(attempt));
  await assert.rejects(
    resumeArchiveSourceHandoff(input),
    /binding settings changed/,
  );
  await writeFile(after.attemptPath, attemptBytes);
  attempt.options.requestKey = 'different-key';
  await writeFile(after.attemptPath, canonical(attempt));
  await assert.rejects(resumeArchiveSourceHandoff(input));
  await writeFile(after.attemptPath, attemptBytes);

  const resultBytes = await readFile(after.resultPath, 'utf8');
  const result = JSON.parse(resultBytes);
  result.attemptPath = before.attemptPath;
  await writeFile(after.resultPath, canonical(result));
  await assert.rejects(
    resumeArchiveSourceHandoff(input),
    /attempt path mismatch/,
  );
  await writeFile(after.resultPath, resultBytes);
  const fakeResultPath = join(
    options.task.directory,
    'archive-result-00000000-0000-4000-8000-000000000000.json',
  );
  await writeFile(fakeResultPath, resultBytes);
  await assert.rejects(
    resumeArchiveSourceHandoff({ ...input, resultPath: fakeResultPath }),
    /result path mismatch/,
  );

  await assert.rejects(
    resumeArchiveSourceHandoff({ ...input, beforeGraphId: 'a'.repeat(64) }),
    /Prior graph unavailable/,
  );
  await assert.rejects(
    resumeArchiveSourceHandoff({
      ...input,
      beforePublicationPath: after.publicationPath,
    }),
  );
  await rm(after.resultPath);
  await assert.rejects(resumeArchiveSourceHandoff(input));
  assert.equal(await generationCount(f), baselineGenerations);
  assert.equal(await attemptCount(options.task.directory), baselineAttempts);
});

test('ACTUAL ARCHIVE CLI: pinned original attempt reconciles a committed capture with missing result without recapture', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-missing-result-recovery');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const beforeGraphId = await graphFor(f, before.publicationPath);
  await writeFile(join(f.base, 'sources/plan.txt'), 'Changed plan for replay.');
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(join(f.base, 'sources/new.txt'), 'New private replay text.');
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath);
  const afterPublication = await loadArchivePublication(after.publicationPath);
  const originalAttemptBytes = await readFile(after.attemptPath);
  const input = {
    beforePublicationPath: before.publicationPath,
    beforePublicationSha256: hash(await readFile(before.publicationPath)),
    committedPublicationSha256: hash(await readFile(after.publicationPath)),
    attemptPath: after.attemptPath,
    attemptSha256: hash(originalAttemptBytes),
    beforeGraphId,
  };
  const committedGenerations = await generationCount(f);
  const committedAttempts = await attemptCount(options.task.directory);
  const existing = await recoverArchiveSourceAttempt(input);
  assert.equal(existing.recovery, 'existing-result');
  assert.equal(await attemptCount(options.task.directory), committedAttempts);
  await rm(after.resultPath);
  await writeFile(after.resultPath, canonical({ status: 'blocked' }));
  await assert.rejects(
    recoverArchiveSourceAttempt(input),
    /Existing capture result needs review/,
  );
  await writeFile(after.resultPath, '{malformed');
  await assert.rejects(recoverArchiveSourceAttempt(input));
  await rm(after.resultPath);
  const committedPublicationBytes = await readFile(after.publicationPath);
  const forgedPublication = JSON.parse(
    committedPublicationBytes.toString('utf8'),
  );
  forgedPublication.gaps.push({
    kind: 'unknown',
    subject: f.source.id,
    detail: 'forged local gap',
  });
  await writeFile(after.publicationPath, canonical(forgedPublication));
  await assert.rejects(
    recoverArchiveSourceAttempt(input),
    /Pinned committed publication changed/,
  );
  await writeFile(after.publicationPath, committedPublicationBytes);
  await rm(after.publicationPath);
  await assert.rejects(
    recoverArchiveSourceAttempt(input),
    /Original complete publication missing/,
  );
  assert.equal(await generationCount(f), committedGenerations);
  assert.equal(await attemptCount(options.task.directory), committedAttempts);
  await writeFile(after.publicationPath, committedPublicationBytes);
  const recovered = await recoverArchiveSourceAttempt(input);
  assert.equal(recovered.recovery, 'reconstructed-result');
  assert.equal(recovered.originalAttemptPath, after.attemptPath);
  assert.equal(recovered.capture.attemptPath, after.attemptPath);
  assert.equal(recovered.capture.resultPath, after.resultPath);
  const reconstructed = JSON.parse(await readFile(after.resultPath, 'utf8'));
  assert.deepEqual(Object.keys(reconstructed).sort(), [
    'attemptPath',
    'gaps',
    'preservation',
    'publicationPath',
    'resultPath',
    'status',
  ]);
  assert.equal(recovered.receipt.after.generation, afterPublication.generation);
  assert.equal(
    recovered.receipt.after.manifestSha256,
    afterPublication.manifestSha256,
  );
  assert.deepEqual(recovered.receipt.diff.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
  });
  assert(recovered.receipt.graphImpact);
  assert.equal(recovered.receipt.graphMutation, 'none');
  assert.equal(await generationCount(f), committedGenerations);
  assert.equal(await attemptCount(options.task.directory), committedAttempts);
  assert.deepEqual(await readFile(after.attemptPath), originalAttemptBytes);

  const attempt = JSON.parse(originalAttemptBytes.toString('utf8'));
  attempt.options.requestKey = 'forged-key';
  await writeFile(after.attemptPath, canonical(attempt));
  await assert.rejects(
    recoverArchiveSourceAttempt(input),
    /Pinned original capture attempt changed/,
  );
  await writeFile(after.attemptPath, originalAttemptBytes);
  await assert.rejects(
    recoverArchiveSourceAttempt({
      ...input,
      beforePublicationSha256: 'f'.repeat(64),
    }),
    /Pinned prior publication changed/,
  );
  await assert.rejects(
    recoverArchiveSourceAttempt({
      ...input,
      beforePublicationPath: after.publicationPath,
      beforePublicationSha256: hash(await readFile(after.publicationPath)),
    }),
    /Fresh archive request key required/,
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
  await assert.rejects(recoverArchiveSourceAttempt(input), /disabled/);
  assert.equal(await generationCount(f), committedGenerations);
  assert.equal(await attemptCount(options.task.directory), committedAttempts);
});

test('ACTUAL ARCHIVE CLI: resume refuses incomplete capture and changed admission without capture', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-resume-refusal');
  const before = await captureArchive(options);
  assert(before.publicationPath);
  await writeFile(
    join(f.base, 'sources/oversize.bin'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const incomplete = await captureArchive({
    ...options,
    requestKey: 'incomplete',
  });
  assert.equal(incomplete.preservation, 'incomplete');
  const input = {
    beforePublicationPath: before.publicationPath,
    resultPath: incomplete.resultPath,
  };
  const count = await generationCount(f);
  const attempts = await attemptCount(options.task.directory);
  await assert.rejects(
    resumeArchiveSourceHandoff(input),
    /Complete v2 preservation required/,
  );
  await rm(join(f.base, 'sources/oversize.bin'));
  const complete = await captureArchive({ ...options, requestKey: 'complete' });
  assert(complete.publicationPath);
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
    resumeArchiveSourceHandoff({
      beforePublicationPath: before.publicationPath,
      resultPath: complete.resultPath,
    }),
    /disabled/,
  );
  assert.equal(await generationCount(f), count + 1);
  assert.equal(await attemptCount(options.task.directory), attempts + 1);
});

test('ACTUAL ARCHIVE CLI: resume rejects a later operator-selected v1 without recapturing', async () => {
  const f = await actualFixture();
  const options = optionsFor(f, 'source-resume-chronology');
  const original = await captureArchive(options);
  assert(original.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Earlier complete v2 capture.',
  );
  const persisted = await captureArchive({
    ...options,
    requestKey: 'persisted',
  });
  assert(persisted.publicationPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Later generation selected as v1.',
  );
  const later = await captureArchive({ ...options, requestKey: 'later' });
  assert(later.publicationPath);
  const generations = await generationCount(f);
  const attempts = await attemptCount(options.task.directory);
  await assert.rejects(
    resumeArchiveSourceHandoff({
      beforePublicationPath: later.publicationPath,
      resultPath: persisted.resultPath,
    }),
    /does not predate persisted v2/,
  );
  assert.equal(await generationCount(f), generations);
  assert.equal(await attemptCount(options.task.directory), attempts);
});
