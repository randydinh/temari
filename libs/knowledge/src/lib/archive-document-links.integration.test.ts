import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { publishArchiveDocumentLinks } from './archive-document-links.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { evaluateArchiveSearch, runArchiveIntake } from './archive-journey.js';

const exec = promisify(execFile);

async function fixture(documents: { path: string; bytes: Buffer }[]) {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({ python, registrarSource, documents });
  const task = { id: 'document-links', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-pinned-markdown' };
  const intake = await runArchiveIntake({ task, intakes: [{
    task, source: f.source, readScope: 'source-root', requestKey: 'v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath && intake.handoffPath);
  return { ...f, task, python, registrarSource, publicationPath,
    handoffPath: intake.handoffPath };
}

test('ACTUAL CLI: pinned Markdown links publish extracted relations and one-hop recovers a lexical miss', async () => {
  const f = await fixture([
    { path: 'docs/seed.md', bytes: Buffer.from(
      'Signal signal signal [charger](target.md) and [again](target.md).\r\n' +
      '`[code](target.md)`\n' +
      '`multiline\n[code-spanning](target.md)`\n' +
      '``foo ``` bar ` [bad](target.md) ` baz ``\n' +
      'unclosed ` inline\n```md\n[stale-inline-fence](target.md)\n```\n' +
      '```md\n[fence](target.md)\n```\n' +
      '> ```md\n> [quote-fence](target.md)\n> ```\n' +
      '- ```md\n  [list-fence](target.md)\n  ```\n' +
      '> - ```md\n>   [nested-fence](target.md)\n>   ```\n' +
      '    [indented](target.md)\n' +
      '<!-- [comment](target.md) -->\n' +
      '<span>[html](target.md)</span>\n' +
      '![image](target.md) ![See [guide](target.md)](image.png) ' +
      '[web](https://example.com/x.md) ' +
      '[up](../target.md) [query](target.md?q=1) [encoded](target%2emd)\n',
    ) },
    { path: 'docs/target.md', bytes: Buffer.from('🔌 Charger location record.\n') },
    { path: 'docs/decoy.md', bytes: Buffer.from('Signal signal unrelated.\n') },
  ]);
  const plan = { publicationPath: f.publicationPath,
    paths: ['docs/seed.md', 'docs/target.md', 'docs/decoy.md'], maxEdges: 10 };
  const published = await publishArchiveDocumentLinks(plan);
  assert.equal(published.status, 'published');
  assert.equal(published.relationshipCount, 2);
  assert(published.graphId && published.draftPath);
  assert.equal(published.skipped['image'], 2);
  assert.equal(published.skipped['unsupported-destination'], 4);
  const draft = JSON.parse(await readFile(published.draftPath, 'utf8'));
  assert.equal(draft.nodes.length, 2);
  assert.equal(draft.assertions.length, 2);
  assert.notEqual(draft.assertions[0].id, draft.assertions[1].id);
  for (const assertion of draft.assertions) {
    assert.equal(assertion.predicate, 'links-to');
    assert.equal(assertion.provenance, 'extracted');
    assert.equal(assertion.support.length, 2);
    assert.match(assertion.support[0].quote, /\]\(target\.md\)/);
    assert.equal(assertion.support[1].quote, '🔌 Charger location record.');
  }
  const reader = await createArchiveGraphReader({
    publications: [f.publicationPath], readScope: 'source-root',
  });
  const page = await reader.read({ graphId: published.graphId,
    scope: [f.source], limit: 20, maxBytes: 65536, cursor: null });
  assert(page.ok, JSON.stringify(page));
  assert.equal(page.value.records.length, 4);
  const result = await evaluateArchiveSearch({ handoffPath: f.handoffPath,
    cases: [{ id: 'markdown-graph', query: 'signal', sourceIds: [f.source.id],
      expected: [{ sourceId: f.source.id, path: 'docs/target.md' }],
      topK: 2, discoveryMode: 'bm25', hostedTextApproved: false,
      graphId: published.graphId }] });
  assert.equal(result.report.cases[0].expectedRecallAtK, 0);
  assert.equal(result.report.cases[0].graph?.expectedRecallAtK, 1);
  assert.deepEqual(result.report.cases[0].graph?.added.map((item) => item.path),
    ['docs/target.md']);
  const reverse = await evaluateArchiveSearch({ handoffPath: f.handoffPath,
    cases: [{ id: 'markdown-graph-direction', query: 'location', sourceIds: [f.source.id],
      expected: [{ sourceId: f.source.id, path: 'docs/seed.md' }],
      topK: 2, discoveryMode: 'bm25', hostedTextApproved: false,
      graphId: published.graphId }] });
  assert.equal(reverse.report.cases[0].graph?.added.length, 0);
  await rm(join(f.base, 'sources'), { recursive: true });
  const repeated = await publishArchiveDocumentLinks(plan);
  assert.equal(repeated.graphId, published.graphId);
  assert.equal(repeated.receiptPath, published.receiptPath);
  const receipt = JSON.parse(await readFile(repeated.receiptPath, 'utf8'));
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.nativeGraphify, 'unavailable');
  assert.equal(receipt.policy, 'pinned-markdown-inline-links-v1');
});

test('ACTUAL CLI: unanchored links yield a receipt and source admission changes refuse publication', async () => {
  const f = await fixture([
    { path: 'a.md', bytes: Buffer.from('---\ntitle: [hidden](b.md)\n---\n' +
      'Only `[inline](b.md)` and [outside](missing.md).\n') },
    { path: 'b.md', bytes: Buffer.from('Target without link.\n') },
  ]);
  const plan = { publicationPath: f.publicationPath,
    paths: ['a.md', 'b.md'], maxEdges: 5 };
  const empty = await publishArchiveDocumentLinks(plan);
  assert.equal(empty.status, 'no-anchored-links');
  assert.equal(empty.graphId, null);
  assert.equal(empty.relationshipCount, 0);
  assert.equal(empty.skipped['outside-allowed-paths'], 1);
  const receipt = JSON.parse(await readFile(empty.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'no-anchored-links');
  await exec(f.python, ['-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(f.base, 'state/registry.sqlite3'), f.source.id],
  );
  await assert.rejects(() => publishArchiveDocumentLinks(plan));
  const stalePath = join(f.task.directory, 'stale.json');
  await writeFile(stalePath, '{}');
  await assert.rejects(() => publishArchiveDocumentLinks({ ...plan, publicationPath: stalePath }));
});
