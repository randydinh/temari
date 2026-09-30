import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { KnowledgeProvider } from '@temari/contracts';
import { memoryFixture, inputFor } from '../support/fixtures.js';
import { canonical, evidence, evidenceId, hash } from './codec.js';
import { collectKnowledge, loadRetrieval } from './retrieval.js';
import { investigateDesignUpdate, loadInvestigation } from './investigation.js';
import { publishJson } from './durable.js';

async function fixture(basis: boolean, omissions = true) {
  const f = await memoryFixture();
  const provider: KnowledgeProvider = {
    ...f.provider,
    read: async (request) => {
      const result = await f.provider.read(request);
      if (!result.ok) return result;
      const { id: _id, ...old } = result.value.evidence;
      const body = {
        ...old,
        archive: {
          schema: 1 as const,
          generation: 'a'.repeat(32),
          manifestSha256: 'b'.repeat(64),
          representationSha256: hash(old.excerpt),
          extractorSettingsSha256: hash('{}'),
          coordinateSpace: 'extracted-text' as const,
          currentOriginal: 'not-checked' as const,
          omissions: omissions
            ? [
                {
                  kind: 'unsupported' as const,
                  subject: old.document.path,
                  detail: 'visual-evidence-unavailable',
                },
              ]
            : [],
        },
      };
      return {
        ok: true,
        value: { ...result.value, evidence: { ...body, id: evidenceId(body) } },
      };
    },
    revalidate: async (item) => ({
      evidenceId: item.id,
      state: 'unchanged',
      detail: 'Snapshot retained',
      checkedAt: '2026-09-29',
      ...(basis ? { basis: 'archive-snapshot' as const } : {}),
    }),
  };
  const input = inputFor(f.input.request.scope[0], f.input.task.directory);
  const request = {
    scope: [f.input.request.scope[0]],
    query: null,
    selections: [
      {
        document: input.request.selections[0].document,
        expectedSha256: hash(f.contents.get('plan.txt')!),
      },
    ],
    limits: {
      evidenceCodePoints: 10000,
      contextCodePoints: 16000,
      stateBytes: 65536,
    },
  };
  return {
    f,
    provider,
    input,
    request,
    budget: {
      calls: 10,
      responseBytes: 65536,
      codePoints: 10000,
      codePointsPerRead: 8000,
      documentsPerPage: 10,
    },
  };
}

test('archive provenance: actual supplied context, checkpoint, and resumed omissions remain historical', async () => {
  const f = await fixture(true);
  const first = await collectKnowledge({ ...f, task: f.input.task });
  assert.match(first.context, /not-checked/);
  assert.match(first.context, /visual-evidence-unavailable/);
  assert.match(first.context, /bbbbbbbbbbbbbbbb/);
  const saved = await loadRetrieval(first.checkpointPath);
  assert.equal(saved.checks[0].basis, 'archive-snapshot');
  assert.equal(first.complete, false);
  const resumed = await collectKnowledge({
    ...f,
    task: f.input.task,
    resumeFrom: first.checkpointPath,
    provider: {
      ...f.provider,
      read: async () => {
        throw Error('Completed read must not repeat');
      },
    },
  });
  assert.equal(resumed.context, first.context);
  assert.equal(resumed.complete, false);
  assert(
    (await loadRetrieval(resumed.checkpointPath)).gaps.some(
      (g) => g.detail === 'visual-evidence-unavailable',
    ),
  );
  const invalid = structuredClone(saved);
  invalid.checks = invalid.checks.map(({ basis: _basis, ...check }) => check);
  const body = canonical(invalid),
    path = join(f.input.task.directory, `retrieval-${hash(body)}.json`);
  await writeFile(path, body);
  await assert.rejects(loadRetrieval(path));
  const item = saved.evidence[0],
    { id: _id, ...withoutId } = item;
  assert.notEqual(
    evidenceId({
      ...withoutId,
      archive: { ...item.archive!, generation: 'c'.repeat(32) },
    }),
    item.id,
  );
  for (const change of [
    { currentOriginal: 'checked' },
    { omissions: [{ kind: 'invented', subject: 'x', detail: 'x' }] },
    { schema: 2 },
  ]) {
    const changed = { ...withoutId, archive: { ...item.archive, ...change } };
    assert.throws(() => evidence({ ...changed, id: hash(canonical(changed)) }));
  }
});

test('missing archive check basis cannot silently supply context in collector or investigation', async () => {
  const f = await fixture(false, false);
  const result = await collectKnowledge({ ...f, task: f.input.task });
  assert.equal(result.context, '');
  assert.equal(result.complete, false);
  const investigation = await investigateDesignUpdate({
    ...f.input,
    provider: f.provider,
    assess: async ({ brief }) => {
      assert(!brief.context.includes('not-checked'));
      throw Error('No usable archive evidence');
    },
  });
  const saved = await loadInvestigation(investigation.evidencePaths.at(-1)!);
  assert(saved.checks.every((c) => c.state === 'unknown'));
  assert.deepEqual(saved.contextEvidenceIds, []);
  assert(
    (await readFile(result.checkpointPath, 'utf8')).includes(
      'archive-snapshot basis',
    ),
  );
});

test('contradictory current-source basis cannot qualify archive evidence for context', async () => {
  const f = await fixture(true, false);
  const provider: KnowledgeProvider = {
    ...f.provider,
    revalidate: async (item) => ({
      evidenceId: item.id,
      state: 'unchanged',
      basis: 'current-source',
      detail: 'Contradictory currentness',
      checkedAt: '2026-09-29',
    }),
  };
  const result = await collectKnowledge({ ...f, task: f.input.task, provider });
  assert.equal(result.context, '');
  assert.equal(result.complete, false);
  const investigation = await investigateDesignUpdate({
    ...f.input,
    provider,
    assess: async ({ checkpoint }) => {
      assert.deepEqual(checkpoint.contextEvidenceIds, []);
      assert(checkpoint.checks.every((check) => check.state === 'unknown'));
      throw Error('Archive currentness cannot be upgraded');
    },
  });
  assert.equal(investigation.status, 'BLOCKED');
});

test('intake publication refuses oversized occupied artifacts without replacing them', async () => {
  const f = await memoryFixture();
  const path = join(f.input.task.directory, 'occupied.json');
  const original = 'x'.repeat(1_048_577);
  await writeFile(path, original);
  await assert.rejects(
    publishJson(path, { schema: 1 }),
    /Existing intake artifact exceeds bound/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
});
