import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { hash } from './codec.js';
import { runArchiveIntake, runArchiveQuery } from './archive-journey.js';
import { recordArchiveQueryFeedback } from './archive-query-feedback.js';

const exec = promisify(execFile);

test('operator feedback pins a real query and archive documents without source text', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      { path: 'alpha.md', bytes: Buffer.from('alpha signal unique detail\n') },
      {
        path: 'beta.md',
        bytes: Buffer.from('beta missed distinctive content\n'),
      },
    ],
  });
  const task = {
    id: 'feedback',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-feedback',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'feedback-v1',
        transport: {
          python,
          registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  assert(intake.handoffPath);
  const query = 'alpha';
  const searched = await runArchiveQuery({
    handoffPath: intake.handoffPath,
    id: 'feedback-query',
    query,
    sourceIds: [f.source.id],
    topK: 1,
    discoveryMode: 'bm25',
    hostedTextApproved: false,
  });
  assert.equal(searched.report.query.ranked.length, 1);
  const relevant = searched.report.query.ranked[0];
  assert.equal(relevant.path, 'alpha.md');
  const missed = {
    sourceId: f.source.id,
    path: 'beta.md',
    sha256: hash('beta missed distinctive content\n'),
  };
  const input = {
    reportPath: searched.reportPath,
    query,
    reviewerRef: 'operator:test',
    reason:
      'Review marked the second document relevant for regression analysis.',
    relevant: [relevant],
    missed: [missed],
  };
  const { receipt, receiptPath } = await recordArchiveQueryFeedback(input);
  assert.match(
    basename(receiptPath),
    /^archive-query-feedback-[a-f0-9]{64}\.json$/,
  );
  assert.equal(receipt.effect, 'regression-candidate-only');
  assert.equal(receipt.querySha256, hash(query));
  assert.equal(receipt.reportSha256, hash(await readFile(searched.reportPath)));
  assert.equal(receipt.handoffSha256, hash(await readFile(intake.handoffPath)));
  assert.equal(receipt.sourceRevisions.length, 1);
  assert.equal(receipt.relevant[0].path, 'alpha.md');
  assert.equal(receipt.missed[0].path, 'beta.md');
  assert.match(receipt.relevant[0].evidenceId, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.candidate, {
    id: 'feedback-query',
    query,
    sourceIds: [f.source.id],
    expected: [
      { sourceId: f.source.id, path: 'alpha.md' },
      { sourceId: f.source.id, path: 'beta.md' },
    ],
    topK: 1,
    discoveryMode: 'bm25',
    hostedTextApproved: false,
  });
  const body = await readFile(receiptPath, 'utf8');
  assert(!body.includes('alpha signal unique detail'));
  assert(!body.includes('beta missed distinctive content'));
  assert(body.includes('"query":"alpha"'));
  assert(!body.includes('graphId'));
  assert.equal(
    (await recordArchiveQueryFeedback(input)).receiptPath,
    receiptPath,
  );

  await assert.rejects(
    () => recordArchiveQueryFeedback({ ...input, query: 'wrong query' }),
    /Query differs from report/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        relevant: [{ ...relevant, sha256: hash('forged') }],
      }),
    /Relevant document must match ranked pin/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        missed: [{ ...missed, sha256: hash('forged') }],
      }),
    /Selected archived document unavailable/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        missed: [{ ...missed, sourceId: 'outside-source' }],
      }),
    /Feedback source outside query scope/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        hostedTextApproval: false,
      } as typeof input),
    /Invalid feedback input fields/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        missed: [{ ...missed, extra: 'wrong' }],
      } as unknown as typeof input),
    /Invalid feedback document fields/,
  );

  const originalReport = await readFile(searched.reportPath, 'utf8');
  await writeFile(
    searched.reportPath,
    originalReport.replace('feedback-query', 'tampered-query'),
  );
  await assert.rejects(() => recordArchiveQueryFeedback(input));
  await writeFile(searched.reportPath, originalReport);
  await exec(python, [
    '-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(f.base, 'state/registry.sqlite3'),
    f.source.id,
  ]);
  await assert.rejects(
    () => recordArchiveQueryFeedback(input),
    /Admitted source disabled/,
  );
});
