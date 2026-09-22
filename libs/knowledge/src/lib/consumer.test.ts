import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { KnowledgeProvider } from '@temari/contracts';
import { investigateDesignUpdate, loadInvestigation, saveInvestigation } from './investigation.js';
import { assessFixture, memoryFixture } from '../support/fixtures.js';

test('REPLACEMENT PROVIDER: failed assessment leaves a loadable checkpoint; retry retains prior actions/findings/questions', async () => {
  const f = await memoryFixture();
  let partialPath = '';
  const failed = await investigateDesignUpdate({ ...f.input, provider: f.provider, assess: async ({ checkpointPath }) => {
    partialPath = checkpointPath; assert.equal((await loadInvestigation(partialPath)).assessment, null); throw new Error('Reader interrupted');
  } });
  assert.equal(failed.status, 'BLOCKED'); assert.equal((await loadInvestigation(partialPath)).evidence.length, 4);
  const done = await investigateDesignUpdate({ ...f.input, provider: f.provider, resumeFrom: failed.evidencePaths.at(-1), assess: async ({ checkpoint }) => assessFixture(checkpoint) });
  assert.equal(done.status, 'ISSUES');
  const before = await loadInvestigation(done.evidencePaths.at(-1)!);
  let calls = 0;
  const again = await investigateDesignUpdate({ ...f.input, provider: f.provider, resumeFrom: done.evidencePaths.at(-1), assess: async () => { calls++; throw new Error('duplicate'); } });
  assert.equal(calls, 0); assert.equal(again.status, 'ISSUES');
  const after = await loadInvestigation(again.evidencePaths.at(-1)!);
  assert.deepEqual(after.assessment, before.assessment); assert.deepEqual(after.readActions, before.readActions);
  const changedBrief = { ...f.input.brief, verificationCommand: 'new verification input' };
  await investigateDesignUpdate({ ...f.input, brief: changedBrief, provider: f.provider, resumeFrom: again.evidencePaths.at(-1), assess: async ({ checkpoint }) => { calls++; return assessFixture(checkpoint); } });
  assert.equal(calls, 1, 'Changed full trusted input must trigger assessment');
});

test('REPLACEMENT PROVIDER: missing and partial transitive dependencies block findings', async () => {
  for (const missing of [true, false]) {
    const f = await memoryFixture();
    if (missing) f.contents.delete('dependency.txt');
    else f.contents.set('dependency.txt', 'x'.repeat(150));
    const input = { ...f.input, request: { ...f.input.request,
      selections: f.input.request.selections.map(s => s.id === 'owner.txt' ? { ...s, requires: ['dependency.txt'] } : s),
      budget: { ...f.input.request.budget, codePointsPerRead: missing ? 200 : 100, readPagesPerDocument: 1 } } };
    const result = await investigateDesignUpdate({ ...input, provider: f.provider, assess: async ({ checkpoint }) => assessFixture(checkpoint) });
    const saved = await loadInvestigation(result.evidencePaths.at(-1)!);
    assert.equal(result.status, 'BLOCKED'); assert.equal(saved.findingValidity[0].state, 'blocked');
    assert(saved.pendingReads.some(r => r.document.path === 'dependency.txt'));
  }
});

test('REPLACEMENT PROVIDER: changed query or provider/configuration requires a fresh investigation before any operation', async () => {
  const f = await memoryFixture();
  const result = await investigateDesignUpdate({ ...f.input, provider: f.provider, assess: async ({ checkpoint }) => assessFixture(checkpoint) });
  const path = result.evidencePaths.at(-1)!, bytes = await readFile(path);
  let called = false;
  const rejectCall = async (): Promise<never> => { called = true; throw new Error('unexpected provider operation'); };
  const provider = { ...f.provider, discover: rejectCall, read: rejectCall, revalidate: rejectCall };
  for (const changed of ['query', 'configuration', 'implementation']) {
    await assert.rejects(investigateDesignUpdate({ ...f.input, resumeFrom: path,
      request: changed === 'query' ? { ...f.input.request, query: 'changed' } : f.input.request,
      provider: changed === 'query' ? provider : { ...provider, identity: { ...provider.identity, [changed]: 'new-identity' } },
      assess: rejectCall }), /same request and provider\/configuration/);
  }
  assert.equal(called, false); assert.deepEqual(await readFile(path), bytes);
});

test('REPLACEMENT PROVIDER: undersized context keeps retrieval recoverable without invoking reader', async () => {
  const f = await memoryFixture(); let called = false;
  const result = await investigateDesignUpdate({ ...f.input,
    request: { ...f.input.request, budget: { ...f.input.request.budget, contextCodePoints: 256 } },
    provider: f.provider, assess: async () => { called = true; throw new Error('unexpected reader'); } });
  assert.equal(called, false); assert.equal(result.status, 'BLOCKED');
  const saved = await loadInvestigation(result.evidencePaths.at(-1)!);
  assert.equal(saved.evidence.length, 4); assert.equal(saved.suppliedContext, '');
  assert(saved.gaps.some(g => g.subject === 'context' && g.kind === 'unsupported'));
});

test('REPLACEMENT PROVIDER: bounded discovery and dependency continuations survive a resumed invocation', async () => {
  const f = await memoryFixture();
  const input = { ...f.input, request: { ...f.input.request, budget: { ...f.input.request.budget, discoveryPages: 1, codePointsPerRead: 30, readPagesPerDocument: 1 } } };
  const first = await investigateDesignUpdate({ ...input, provider: f.provider, assess: async ({ checkpoint }) => assessFixture(checkpoint) });
  const saved = await loadInvestigation(first.evidencePaths.at(-1)!); assert(saved.discoveryNext); assert(saved.pendingReads.length > 0);
  const resumed = await investigateDesignUpdate({ ...input, provider: f.provider, resumeFrom: first.evidencePaths.at(-1),
    assess: async ({ checkpoint }) => ({ ...assessFixture(checkpoint), findings: [{ ...assessFixture(checkpoint).findings[0], id: 'comparison-2' }], completedActions: [] }) });
  const next = await loadInvestigation(resumed.evidencePaths.at(-1)!);
  assert.equal(next.discoveryNext, null); assert(next.evidence.length > saved.evidence.length);
  for (const old of saved.evidence) assert(next.evidence.some(e => e.id === old.id));
  assert(next.assessment!.findings.some(f => f.id === 'comparison-1'));
  assert(next.assessment!.completedActions.some(a => a.id === 'comparison-action'));
});

test('REPLACEMENT PROVIDER: unsupported, throwing and malformed provider results remain recoverable BLOCKED work', async () => {
  for (const mode of ['unsupported', 'failure', 'malformed'] as const) {
    const f = await memoryFixture();
    const fail = async (): Promise<never> => { throw new Error('synthetic provider failure'); };
    const result = { ok: false, gap: { kind: 'unsupported', subject: 'local-test', detail: 'Capability unavailable' } } as const;
    const provider: KnowledgeProvider = { ...f.provider,
      discover: mode === 'failure' ? fail : async () => mode === 'unsupported' ? result : { ok: true, value: {} } as never,
      read: mode === 'failure' ? fail : async () => mode === 'unsupported' ? result : { ok: true, value: {} } as never };
    const saved = await investigateDesignUpdate({ ...f.input, provider, assess: async () => { throw new Error('No evidence for assessment'); } });
    assert.equal(saved.status, 'BLOCKED'); const checkpoint = await loadInvestigation(saved.evidencePaths.at(-1)!);
    assert(checkpoint.gaps.some(g => g.kind === (mode === 'unsupported' ? 'unsupported' : 'unknown')));
    assert.equal(checkpoint.assessment, null);
  }
});

test('REPLACEMENT PROVIDER: citations outside actual supplied context and incomplete question accounting are rejected', async () => {
  for (const mode of ['context', 'questions', 'comparison'] as const) {
    const f = await memoryFixture();
    const result = await investigateDesignUpdate({ ...f.input, request: mode === 'context'
      ? { ...f.input.request, budget: { ...f.input.request.budget, contextCodePoints: 1700 } } : f.input.request,
      provider: f.provider, assess: async ({ checkpoint }) => {
        const a = assessFixture({ ...checkpoint, contextEvidenceIds: checkpoint.evidence.map(e => e.id) });
        if (mode === 'questions') return { ...a, remainingQuestions: [] };
        if (mode === 'comparison') return { ...a, findings: [{ ...a.findings[0], supports: [a.findings[0].supports[0]] }] };
        return a;
      } });
    const checkpoint = await loadInvestigation(result.evidencePaths.at(-1)!);
    assert.equal(result.status, 'BLOCKED'); assert.equal(checkpoint.assessment, null);
    assert(checkpoint.gaps.some(g => g.subject === 'assessment'));
    assert(Array.from(checkpoint.suppliedContext).length <= checkpoint.request.budget.contextCodePoints);
  }
});

test('ARTIFACT: concurrent atomic publication, interrupted temp, immutability, malformed and tampered records', async () => {
  const f = await memoryFixture();
  const result = await investigateDesignUpdate({ ...f.input, provider: f.provider, assess: async ({ checkpoint }) => assessFixture(checkpoint) });
  const path = result.evidencePaths.at(-1)!, saved = await loadInvestigation(path), body = await readFile(path);
  await writeFile(join(f.input.task.directory, '.knowledge-interrupted.tmp'), '{"schema":', { flag: 'wx' });
  const paths = await Promise.all(Array.from({ length: 5 }, () => saveInvestigation(saved)));
  assert(paths.every(p => p === path)); assert.deepEqual(await readFile(path), body);
  for (const name of await readdir(f.input.task.directory)) if (name.startsWith('knowledge-')) await loadInvestigation(join(f.input.task.directory, name));
  assert.equal((await readdir(f.input.task.directory)).filter(p => p.endsWith('.tmp')).length, 1, 'Only intentionally abandoned temp remains');
  await assert.rejects(saveInvestigation({ ...saved, completedAssessments: ['not-a-digest'] }));
  await assert.rejects(saveInvestigation({ ...saved, suppliedContext: 'citation text removed' }));
  await assert.rejects(saveInvestigation({ ...saved, findingValidity: [] }));
  const altered = { ...saved, suppliedContext: saved.suppliedContext + 'tamper' };
  await writeFile(path, JSON.stringify(altered)); await assert.rejects(loadInvestigation(path), /content address mismatch/);
  await assert.rejects(saveInvestigation(saved), /collision\/tampering/);
  await writeFile(path, '{'); await assert.rejects(loadInvestigation(path));
});
