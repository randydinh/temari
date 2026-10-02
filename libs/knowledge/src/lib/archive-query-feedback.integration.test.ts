import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { canonical, hash } from './codec.js';
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

async function negativeFixture(
  query: string,
  discoveryMode: 'exact' | 'bm25',
  currentLocalOnly = false,
) {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      {
        path: 'one.md',
        bytes: Buffer.from('sharedterm one partial context\n'),
      },
      {
        path: 'two.md',
        bytes: Buffer.from('sharedterm two partial context\n'),
      },
    ],
  });
  const task = {
    id: 'negative-feedback',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-negative-feedback',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'negative-v1',
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
  if (currentLocalOnly)
    await exec(python, [
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['sharing']='local-only'; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(f.base, 'state/registry.sqlite3'),
      f.source.id,
    ]);
  const searched = await runArchiveQuery({
    handoffPath: intake.handoffPath,
    id: 'negative-query',
    query,
    sourceIds: [f.source.id],
    topK: 2,
    discoveryMode,
    hostedTextApproved: currentLocalOnly,
  });
  const input = {
    reportPath: searched.reportPath,
    query,
    reviewerRef: 'operator:synthetic',
    reason: 'Displayed first excerpts did not answer this question.',
  };
  return { f, searched, input };
}

test('ACTUAL Registrar: negative feedback pins every verified ranked first excerpt without an absence claim', async () => {
  const { f, searched, input } = await negativeFixture('sharedterm', 'bm25');
  assert.equal(searched.report.query.ranked.length, 2);
  assert.equal(searched.report.query.shortlistVerified, true);
  assert.equal(searched.report.query.jevSharing, 'case-opt-out');
  const selected = {
    ...input,
    assessment: 'shortlist-excerpts-unanswered' as const,
  };
  const { receipt, receiptPath } = await recordArchiveQueryFeedback(selected);
  assert.match(
    basename(receiptPath),
    /^archive-query-negative-feedback-[a-f0-9]{64}\.json$/,
  );
  assert.equal(receipt.assessment, 'shortlist-excerpts-unanswered');
  assert.equal(receipt.scope.readMode, 'first-1000-codepoints');
  assert.equal(receipt.scope.fullDocumentRead, false);
  assert.equal(receipt.scope.corpusAbsenceClaim, false);
  assert.deepEqual(
    receipt.ranked.map(({ evidenceId: _id, ...pin }) => pin),
    searched.report.query.ranked,
  );
  assert(
    receipt.ranked.every((item) => /^[a-f0-9]{64}$/.test(item.evidenceId)),
  );
  assert.equal(
    receipt.shortlistCheckpointPath,
    searched.report.query.retrievalCheckpointPath,
  );
  assert.equal(
    receipt.shortlistCheckpointSha256,
    hash(await readFile(receipt.shortlistCheckpointPath!)),
  );
  assert.equal(
    (await recordArchiveQueryFeedback(selected)).receiptPath,
    receiptPath,
  );
  const body = await readFile(receiptPath, 'utf8');
  assert(!body.includes('sharedterm one partial context'));
  assert(!body.includes('sharedterm two partial context'));
  assert(!body.includes('absence'));

  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...selected,
        assessment: 'empty-shortlist-observed',
      }),
    /Shortlist is not empty/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...selected,
        query: 'different',
      }),
    /Query differs from report/,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...selected,
        ranked: [searched.report.query.ranked[0]],
      } as typeof selected),
    /Invalid negative feedback input fields/,
  );

  const shortlistPath = receipt.shortlistCheckpointPath!;
  const shortlistBytes = await readFile(shortlistPath);
  const alteredShortlist = JSON.parse(shortlistBytes.toString());
  alteredShortlist.ranked.pop();
  await writeFile(shortlistPath, canonical(alteredShortlist));
  await assert.rejects(
    () => recordArchiveQueryFeedback(selected),
    /Shortlist content address changed/,
  );
  await writeFile(shortlistPath, shortlistBytes);

  const reportBytes = await readFile(searched.reportPath);
  const alteredReport = JSON.parse(reportBytes.toString());
  alteredReport.query.ranked.pop();
  await writeFile(searched.reportPath, canonical(alteredReport));
  await assert.rejects(() => recordArchiveQueryFeedback(selected));
  await writeFile(searched.reportPath, reportBytes);

  await exec(f.config.python, [
    '-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(f.base, 'state/registry.sqlite3'),
    f.source.id,
  ]);
  await assert.rejects(
    () => recordArchiveQueryFeedback(selected),
    /Admitted source disabled/,
  );
});

test('ACTUAL Registrar: negative feedback remains local when current sharing becomes local-only', async () => {
  const { searched, input } = await negativeFixture('sharedterm', 'bm25', true);
  assert.equal(searched.report.query.jevSharing, 'current-local-only');
  assert.equal(searched.report.query.ranked.length, 2);
  const { receipt } = await recordArchiveQueryFeedback({
    ...input,
    assessment: 'shortlist-excerpts-unanswered',
  });
  assert.equal(receipt.ranked.length, 2);
  assert.equal(receipt.scope.corpusAbsenceClaim, false);
});

test('ACTUAL Registrar: empty shortlist feedback records only an observed query-page miss', async () => {
  const { searched, input } = await negativeFixture(
    'not-in-this-source-token',
    'exact',
  );
  assert.equal(searched.report.query.ranked.length, 0);
  assert.equal(searched.report.query.retrievalCheckpointPath, null);
  const { receipt, receiptPath } = await recordArchiveQueryFeedback({
    ...input,
    assessment: 'empty-shortlist-observed',
  });
  assert.equal(receipt.ranked.length, 0);
  assert.equal(receipt.shortlistCheckpointPath, null);
  assert.equal(receipt.shortlistCheckpointSha256, null);
  assert.equal(receipt.scope.corpusAbsenceClaim, false);
  assert.equal(receipt.reportSha256, hash(await readFile(searched.reportPath)));
  assert.equal(
    (await readFile(receiptPath, 'utf8')).includes('corpusAbsenceClaim'),
    true,
  );
  await assert.rejects(
    () =>
      recordArchiveQueryFeedback({
        ...input,
        assessment: 'shortlist-excerpts-unanswered',
      }),
    /No excerpts to assess/,
  );
});
