import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join } from 'node:path';
import type { KnowledgeProvider } from '@temari/contracts';
import { canonical, hash } from './codec.js';
import { memoryFixture } from '../support/fixtures.js';
import {
  collectKnowledge,
  loadRetrieval,
  RetrievalCapacityError,
} from './retrieval.js';

test('review regression: metadata capacity rejects before any checkpoint or provider call', async () => {
  const f = await fixture();
  let calls = 0;
  const fail = async (): Promise<never> => {
    calls++;
    throw new Error('unexpected');
  };
  const request = {
    ...f.request,
    selections: Array.from({ length: 32 }, (_, i) => ({
      document: {
        ...f.request.selections[0].document,
        path: `${String(i).padStart(2, '0')}${'x'.repeat(238)}`,
      },
      expectedSha256: f.request.selections[0].expectedSha256,
    })),
    limits: { ...f.request.limits, stateBytes: 32768 },
  };
  await assert.rejects(
    collectKnowledge({
      ...f,
      request,
      provider: { ...f.provider, read: fail, revalidate: fail, discover: fail },
    }),
    (error) =>
      error instanceof RetrievalCapacityError &&
      error.requiredStateBytes > request.limits.stateBytes,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(f.task.directory), []);
});

test('review regression: re-addressed inconsistent discovery checkpoints are rejected', async () => {
  const f = await fixture();
  const result = await collectKnowledge({
    ...f,
    request: { ...f.request, query: 'proposal', selections: [] },
    budget: { ...f.budget, documentsPerPage: 1 },
  });
  const saved = await loadRetrieval(result.checkpointPath);
  for (const kind of ['snapshot', 'reverse', 'after-terminal']) {
    const changed = structuredClone(saved);
    if (kind === 'snapshot')
      changed.discovery[1] = { ...changed.discovery[1], snapshot: 'changed' };
    if (kind === 'reverse') changed.discovery.reverse();
    if (kind === 'after-terminal')
      changed.discovery.push(changed.discovery.at(-1)!);
    changed.discoveryNext = changed.discovery.at(-1)!.next;
    const body = canonical(changed),
      path = join(f.task.directory, `retrieval-${hash(body)}.json`);
    await writeFile(path, body);
    await assert.rejects(loadRetrieval(path), { name: 'AssertionError' }, kind);
  }
});

test('review regression: per-call byte limit applies even within the pass allowance', async () => {
  for (const operation of ['read', 'discover'] as const) {
    const f = await fixture();
    const provider: KnowledgeProvider = {
      ...f.provider,
      [operation]: async (r: never) => ({
        ...(await f.provider[operation](r)),
        padding: 'x'.repeat(70000),
      }),
    };
    const result = await collectKnowledge({
      ...f,
      provider,
      request:
        operation === 'read'
          ? f.request
          : { ...f.request, query: 'proposal', selections: [] },
    });
    const saved = await loadRetrieval(result.checkpointPath);
    assert.equal(result.complete, false);
    assert.equal(saved.discovery.length + saved.evidence.length, 0);
    assert(saved.usage.responseBytes > 65536);
  }
});

test('review regression: oversized cursor/check extras and many discovery gaps stay bounded and resumable', async () => {
  for (const kind of ['cursor', 'check-extra', 'many-gaps']) {
    const f = await fixture();
    const provider: KnowledgeProvider = {
      ...f.provider,
      read: async (r) => {
        const result = await f.provider.read({ ...r, maxCodePoints: 10 });
        return result.ok && kind === 'cursor'
          ? { ok: true, value: { ...result.value, next: 'x'.repeat(20000) } }
          : result;
      },
      revalidate: async (e) => ({
        ...(await f.provider.revalidate(e)),
        ...(kind === 'check-extra' ? { padding: 'x'.repeat(20000) } : {}),
      }),
      discover: async (r) => {
        const result = await f.provider.discover(r);
        return result.ok && kind === 'many-gaps'
          ? {
              ok: true,
              value: {
                ...result.value,
                gaps: Array.from({ length: 1025 }, (_, i) => ({
                  kind: 'unknown' as const,
                  subject: String(i),
                  detail: 'x',
                })),
              },
            }
          : result;
      },
    };
    const request = {
      ...f.request,
      ...(kind === 'many-gaps' ? { query: 'proposal', selections: [] } : {}),
      limits: {
        ...f.request.limits,
        stateBytes: kind === 'many-gaps' ? 1024 * 1024 : 16384,
      },
    };
    const result = await collectKnowledge({ ...f, provider, request });
    const saved = await loadRetrieval(result.checkpointPath);
    assert(Buffer.byteLength(canonical(saved)) <= request.limits.stateBytes);
    assert(saved.gaps.length <= 16);
    if (kind === 'check-extra') assert.equal(result.complete, true);
    else assert.equal(result.complete, false);
    const resumed = await collectKnowledge({
      ...f,
      provider,
      request,
      resumeFrom: result.checkpointPath,
    });
    await loadRetrieval(resumed.checkpointPath);
  }
});

test('review regression: collection reserves 1024 response bytes per final check', async () => {
  const f = await fixture();
  let calls = 0,
    allowed = 0;
  const provider: KnowledgeProvider = {
    ...f.provider,
    read: async (r) => {
      calls++;
      allowed = r.maxBytes;
      return f.provider.read(r);
    },
  };
  const insufficient = await collectKnowledge({
    ...f,
    provider,
    budget: { ...f.budget, responseBytes: 1024 },
  });
  assert.equal(calls, 0);
  assert.equal(insufficient.complete, false);
  const enough = await collectKnowledge({
    ...f,
    provider,
    budget: { ...f.budget, responseBytes: 4096 },
  });
  assert.equal(enough.complete, true);
  assert.equal(allowed, 3072);
});

async function fixture() {
  const f = await memoryFixture();
  return {
    ...f,
    task: f.input.task,
    request: {
      scope: f.input.request.scope,
      query: null,
      selections: [
        {
          document: f.input.request.selections[0].document,
          expectedSha256: hash(f.contents.get('plan.txt')!),
        },
      ],
      limits: {
        evidenceCodePoints: 8000,
        contextCodePoints: 16000,
        stateBytes: 1024 * 1024,
      },
    },
    budget: {
      calls: 32,
      responseBytes: 1024 * 1024,
      codePoints: 5000,
      codePointsPerRead: 200,
      documentsPerPage: 5,
    },
  };
}

test('generic retrieval: one explicit document requires no assessor and retains whole exact evidence', async () => {
  const f = await fixture();
  const result = await collectKnowledge(f);
  assert.equal(result.workerResult.status, 'ISSUES');
  assert.equal(result.complete, true);
  const saved = await loadRetrieval(result.checkpointPath);
  assert.equal(
    saved.evidence.map((e) => e.excerpt).join(''),
    f.contents.get('plan.txt'),
  );
  assert.equal(saved.usage.calls, 2);
  assert.equal(saved.checks.length, 1);
  assert(result.context.includes(canonical(saved.evidence[0])));
});

test('generic retrieval: discovery alone never reads found documents', async () => {
  const f = await fixture();
  const result = await collectKnowledge({
    ...f,
    request: { ...f.request, query: 'proposal', selections: [] },
    provider: {
      ...f.provider,
      read: async () => {
        throw new Error('not authorized');
      },
    },
  });
  assert.equal(result.complete, true);
  const saved = await loadRetrieval(result.checkpointPath);
  assert.equal(saved.discovery.length, 1);
  assert.equal(saved.evidence.length, 0);
  assert.equal(saved.usage.calls, 1);
  assert.equal(saved.discovery[0].coverage.semanticRecall, 'not-evaluated');
});

test('generic retrieval: resumes paginated codepoints under per-pass budgets without changing old artifacts', async () => {
  const f = await fixture();
  const budget = { ...f.budget, calls: 2, codePointsPerRead: 10 };
  const first = await collectKnowledge({ ...f, budget });
  assert.equal(first.complete, false);
  const old = await readFile(first.checkpointPath);
  const saved = await loadRetrieval(first.checkpointPath);
  assert.equal(saved.evidence.length, 1);
  assert.equal(saved.usage.calls, 2);
  const insufficient = await collectKnowledge({
    ...f,
    budget: { ...budget, calls: 1 },
    resumeFrom: first.checkpointPath,
  });
  assert.equal(insufficient.complete, false);
  const next = await collectKnowledge({
    ...f,
    resumeFrom: insufficient.checkpointPath,
  });
  assert.equal(next.complete, true);
  const done = await loadRetrieval(next.checkpointPath);
  assert.equal(
    done.evidence.map((e) => e.excerpt).join(''),
    f.contents.get('plan.txt'),
  );
  assert.equal(done.checks.length, done.evidence.length);
  assert.deepEqual(await readFile(first.checkpointPath), old);
});

test('generic retrieval: complete resume rechecks evidence and refuses stale context', async () => {
  const f = await fixture();
  const first = await collectKnowledge(f);
  f.contents.set('plan.txt', 'changed');
  const result = await collectKnowledge({
    ...f,
    resumeFrom: first.checkpointPath,
  });
  assert.equal(result.complete, false);
  assert.equal(result.context, '');
  assert.equal(result.workerResult.status, 'BLOCKED');
  const saved = await loadRetrieval(result.checkpointPath);
  assert.equal(saved.usage.calls, 1);
  assert.equal(saved.checks[0].state, 'changed');
});

test('generic retrieval: failures consume calls and provider response bytes', async () => {
  const f = await fixture();
  const result = await collectKnowledge({
    ...f,
    provider: {
      ...f.provider,
      read: async () => {
        throw new Error('offline');
      },
    },
  });
  const saved = await loadRetrieval(result.checkpointPath);
  assert.equal(saved.usage.calls, 1);
  assert(saved.usage.responseBytes > 0);
  assert.equal(saved.reads[0].complete, false);
  assert.equal(result.complete, false);
});

test('generic retrieval: changed authority/request/provider rejects resume before provider calls', async () => {
  const f = await fixture();
  const first = await collectKnowledge(f);
  let calls = 0;
  const fail = async (): Promise<never> => {
    calls++;
    throw new Error('unexpected call');
  };
  const provider = {
    ...f.provider,
    read: fail,
    revalidate: fail,
    discover: fail,
  };
  await assert.rejects(
    collectKnowledge({
      ...f,
      provider,
      task: { ...f.task, authorityRef: 'changed' },
      resumeFrom: first.checkpointPath,
    }),
    /identity/,
  );
  await assert.rejects(
    collectKnowledge({
      ...f,
      provider,
      request: { ...f.request, query: 'changed' },
      resumeFrom: first.checkpointPath,
    }),
    /identity/,
  );
  await assert.rejects(
    collectKnowledge({
      ...f,
      provider: {
        ...provider,
        identity: { ...provider.identity, implementation: 'changed' },
      },
      resumeFrom: first.checkpointPath,
    }),
    /identity/,
  );
  assert.equal(calls, 0);
});

test('generic retrieval: corrupt checkpoint and out-of-selection evidence fail closed', async () => {
  const f = await fixture();
  const first = await collectKnowledge(f);
  await writeFile(first.checkpointPath, '{}');
  await assert.rejects(loadRetrieval(first.checkpointPath), /content address/);
  const provider: KnowledgeProvider = {
    ...f.provider,
    read: async (r) =>
      f.provider.read({
        ...r,
        document: { ...r.document, path: 'update.txt' },
        expectedSha256: null,
      }),
  };
  const result = await collectKnowledge({ ...f, provider });
  assert.equal(result.complete, false);
  assert.equal((await loadRetrieval(result.checkpointPath)).evidence.length, 0);
});

test('generic retrieval: retained and context limits never truncate an evidence record', async () => {
  const f = await fixture();
  const narrow = await collectKnowledge({
    ...f,
    request: {
      ...f.request,
      limits: { ...f.request.limits, contextCodePoints: 256 },
    },
  });
  assert.equal(narrow.complete, false);
  assert.equal(narrow.context, '');
  assert.equal((await loadRetrieval(narrow.checkpointPath)).evidence.length, 1);
  const capped = await collectKnowledge({
    ...f,
    request: {
      ...f.request,
      limits: { ...f.request.limits, evidenceCodePoints: 10 },
    },
  });
  assert.equal(capped.complete, false);
  const saved = await loadRetrieval(capped.checkpointPath);
  assert(
    saved.evidence.reduce((n, e) => n + e.span.end - e.span.start, 0) <= 10,
  );
});

test('generic retrieval: oversized revalidation response is counted but not accepted as current', async () => {
  const f = await fixture();
  const provider: KnowledgeProvider = {
    ...f.provider,
    revalidate: async (e) => ({
      evidenceId: e.id,
      state: 'unchanged',
      detail: 'x'.repeat(40000),
      checkedAt: new Date().toISOString(),
    }),
  };
  const result = await collectKnowledge({
    ...f,
    provider,
    budget: { ...f.budget, responseBytes: 4096 },
  });
  const saved = await loadRetrieval(result.checkpointPath);
  assert(saved.usage.responseBytes > 4096);
  assert.equal(result.complete, false);
  assert.equal(result.context, '');
});
