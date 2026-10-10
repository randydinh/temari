import assert from 'node:assert/strict';
import {
  appendFile,
  cp,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createTalkKnowledgeTools,
  validateTalkKnowledge,
} from './dashboard-talk-knowledge.mjs';
import {
  prepareTalkKnowledge,
  refreshTalkKnowledgeSource,
} from './fixtures/dashboard-talk-knowledge.mjs';

const python = process.env['TEMARI_REGISTRAR_PYTHON'];
const json = (result: any) => {
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'json');
  return result[0].value;
};
test('Talk library tools preserve citations and refuse scope, snapshot and interpreter drift', async (t) => {
  assert(
    python,
    'Actual gateway verification requires TEMARI_REGISTRAR_PYTHON; this test must not silently skip.',
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-talk-knowledge-proof-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await prepareTalkKnowledge(root, python);
  const [search, read] = createTalkKnowledgeTools(f.config);
  assert(search && read);
  const found = json(await search.execute({ query: 'Temari' }));
  await t.test('exact discovery only returns the admitted source', async () => {
    assert.equal(found.status, 'complete');
    assert.equal(found.documents.length, 1);
    assert.equal(found.documents[0].source_id, f.allowedSourceId);
    assert.equal(found.documents[0].retrieval.kind, 'exact');
    assert(!JSON.stringify(found).includes(f.deniedSourceId));
    assert(!JSON.stringify(found).includes('PRIVATE_SOURCE_MUST_NOT_LEAK'));
    const injected = json(
      await search.execute({ query: 'Temari', sourceIds: [f.deniedSourceId] }),
    );
    assert.deepEqual(injected.documents, found.documents);
  });
  const document = found.documents[0];
  const selection = {
    sourceId: document.source_id,
    path: document.path,
    generation: document.generation,
    sha256: document.sha256,
  };
  await t.test(
    'unchanged content rejects a wrong discovery generation and hash',
    async () => {
      const before = json(await read.execute(selection));
      assert.equal(before.status, 'complete');
      const wrongGeneration =
        selection.generation === '0'.repeat(32)
          ? '1'.repeat(32)
          : '0'.repeat(32);
      const wrongHash =
        selection.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      await assert.rejects(
        read.execute({ ...selection, generation: wrongGeneration }),
      );
      await assert.rejects(read.execute({ ...selection, sha256: wrongHash }));
      const after = json(await read.execute(selection));
      assert.equal(after.status, 'complete');
      assert.equal(after.record.body, before.record.body);
      assert.equal(after.generation, selection.generation);
      assert.equal(after.sha256, selection.sha256);
    },
  );
  await t.test(
    'read returns verified byte-span citations matching discovery',
    async () => {
      const result = json(await read.execute(selection));
      assert.equal(result.status, 'complete');
      assert.equal(result.record.support, 'source-bytes-and-spans-verified');
      assert.match(result.record.body, /Archon executes native workflows/);
      const citation = result.record.citations[0];
      assert.equal(citation.source_id, selection.sourceId);
      assert.equal(citation.path, selection.path);
      assert.equal(citation.sha256, selection.sha256);
      assert.equal(citation.quote, result.record.body);
    },
  );
  await t.test(
    'foreign source and traversal are refused before document access',
    async () => {
      await assert.rejects(
        read.execute({
          ...selection,
          sourceId: f.deniedSourceId,
          path: 'private.md',
        }),
      );
      for (const path of [
        '../denied-library/private.md',
        join(f.deniedRoot, 'private.md'),
      ])
        await assert.rejects(read.execute({ ...selection, path }));
    },
  );
  await t.test(
    'document changes cannot inherit the discovered source identity',
    async () => {
      await writeFile(
        join(f.allowedRoot, 'welcome.md'),
        'Changed source bytes after discovery.\n',
      );
      let result;
      let rejected = false;
      try {
        result = json(await read.execute(selection));
      } catch {
        rejected = true;
      }
      assert(
        rejected || result.status !== 'complete',
        'Read must refuse or report drift from the selected document identity.',
      );
      if (!rejected)
        assert(!JSON.stringify(result).includes('Changed source bytes'));
    },
  );
  await t.test(
    'refresh invalidates the old selection while fresh discovery reads changed bytes',
    async () => {
      await refreshTalkKnowledgeSource(
        python,
        f.config.workspace,
        f.allowedSourceId,
      );
      const fresh = json(
        await search.execute({ query: 'Changed source bytes' }),
      ).documents[0];
      assert(fresh);
      assert.notEqual(fresh.generation, selection.generation);
      assert.notEqual(fresh.sha256, selection.sha256);
      await assert.rejects(read.execute(selection));
      const current = json(
        await read.execute({
          sourceId: fresh.source_id,
          path: fresh.path,
          generation: fresh.generation,
          sha256: fresh.sha256,
        }),
      );
      assert.equal(current.status, 'complete');
      assert.equal(
        current.record.body,
        'Changed source bytes after discovery.\n',
      );
      assert.equal(current.record.citations[0].sha256, fresh.sha256);
    },
  );
  await t.test(
    'changed interpreter is refused before it can launch',
    async () => {
      const changed = join(root, 'changed-python');
      await cp(await realpath(python), changed);
      const [changedSearch] = createTalkKnowledgeTools({
        ...f.config,
        python: changed,
      });
      assert(changedSearch);
      await appendFile(changed, '\nchanged-interpreter\n');
      await assert.rejects(
        changedSearch.execute({ query: 'Temari' }),
        /interpreter identity changed/,
      );
    },
  );
});
test('Talk knowledge configuration refuses implicit or duplicated source scope', () => {
  const base = {
    python: '/absolute/python',
    pythonSha256: 'a'.repeat(64),
    workspace: '/absolute/registry',
    sourceIds: ['one'],
  };
  validateTalkKnowledge(base);
  for (const value of [
    { ...base, sourceIds: [] },
    { ...base, sourceIds: ['one', 'one'] },
    { ...base, python: 'python' },
    { ...base, pythonSha256: 'wrong' },
    { ...base, sourceIds: ['../foreign'] },
    { ...base, credential: 'must-not-be-admitted' },
  ])
    assert.throws(() => validateTalkKnowledge(value));
});
