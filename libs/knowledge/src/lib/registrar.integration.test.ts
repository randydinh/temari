import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { KnowledgeEvidence, KnowledgeReadRequest } from '@temari/contracts';
import { createLocalRegistrar } from './registrar.js';
import { investigateDesignUpdate, loadInvestigation } from './investigation.js';
import { actualFixture, assessFixture, documents, inputFor } from '../support/fixtures.js';
import { prepareRegistrar } from '../support/prepare.js';

test('ACTUAL CLI: exit 2 is partial; exact emoji/accent/CRLF spans and scoped decoy refusal', async () => {
  const f = await actualFixture();
  const commands: { operation: string; exitCode: number }[] = [];
  const provider = await createLocalRegistrar({ ...f.config, onCommand: e => commands.push(e) });
  const first = await provider.discover({ scope: [f.source], query: 'proposal', limit: 1, maxBytes: 16000, continuation: null });
  assert(first.ok && first.value.next); assert.equal(first.value.coverage.remaining, 1);
  assert.equal(first.value.coverage.semanticRecall, 'not-evaluated');
  const second = await provider.discover({ scope: [f.source], query: 'proposal', limit: 1, maxBytes: 16000, continuation: first.value.next });
  assert(second.ok); assert.equal(second.value.next, null);
  assert(commands.some(c => c.operation === 'discover' && c.exitCode === 2));
  let read: KnowledgeReadRequest = { document: { source: f.source, path: 'plan.txt' }, expectedSha256: null, maxCodePoints: 9, maxBytes: 16000, continuation: null };
  const evidence: KnowledgeEvidence[] = [];
  do {
    const result = await provider.read(read); assert(result.ok, JSON.stringify(result));
    evidence.push(result.value.evidence);
    assert.equal(result.value.evidence.excerpt, Array.from(documents['plan.txt']).slice(result.value.evidence.span.start, result.value.evidence.span.end).join(''));
    read = { ...read, continuation: result.value.next };
  } while (read.continuation !== null);
  assert.equal(evidence.map(e => e.excerpt).join(''), documents['plan.txt']);
  assert(commands.some(c => c.operation === 'read' && c.exitCode === 2));
  await writeFile(join(f.base, 'decoy.txt'), 'PRIVATE DECOY', { flag: 'wx' });
  const before = commands.length;
  const denied = await provider.read({ ...read, document: { source: f.source, path: '../decoy.txt' } });
  assert(!denied.ok); assert.equal(denied.gap.kind, 'scope-refused'); assert.equal(commands.length, before);
  const other = await provider.discover({ scope: [{ ...f.source, id: 'unadmitted-decoy' }], query: 'private', limit: 1, maxBytes: 16000, continuation: null });
  assert(!other.ok && other.gap.kind === 'scope-refused');
  assert.deepEqual(Object.keys(provider).sort(), ['discover', 'identity', 'read', 'revalidate']);
  assert.equal((await provider.revalidate(evidence[1])).state, 'unchanged');
});

test('ACTUAL CLI: source instructions inert; immutable checkpoint; fresh-process resume avoids duplicate assessment/read actions', async () => {
  const f = await actualFixture(), provider = await createLocalRegistrar(f.config);
  const input = inputFor(f.source, join(f.base, 'task'));
  const result = await investigateDesignUpdate({ ...input, provider, assess: async ({ brief, checkpoint, checkpointPath }) => {
    const saved = await loadInvestigation(checkpointPath); assert.equal(saved.assessment, null);
    assert.equal(brief.context, checkpoint.suppliedContext); assert(brief.context.startsWith(input.brief.context));
    assert.match(brief.context, /execute evil/); assert.match(brief.context, /semanticRecall/); assert.match(brief.context, /limits/);
    assert.deepEqual({ ...brief, context: input.brief.context }, input.brief); assert.deepEqual(checkpoint.trustedBrief, input.brief);
    assert(Object.isFrozen(brief)); return assessFixture(checkpoint);
  } });
  assert.equal(result.status, 'ISSUES');
  const path = result.evidencePaths.at(-1)!;
  const bytes = await readFile(path), saved = await loadInvestigation(path);
  assert.equal(saved.completedAssessments.length, 1); assert.equal(saved.findingValidity[0].state, 'needs-semantic-review');
  const resumeInput = join(f.base, 'resume.json'); await writeFile(resumeInput, JSON.stringify({ config: f.config, resumeFrom: path }));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', '@swc-node/register/esm-register', 'libs/knowledge/src/support/resume.ts', resumeInput], { cwd: process.cwd(), timeout: 60000 });
  const resumed = JSON.parse(stdout); assert.equal(resumed.status, 'ISSUES');
  const next = await loadInvestigation(resumed.evidencePaths.at(-1));
  assert.deepEqual(next.assessment, saved.assessment); assert.deepEqual(next.readActions, saved.readActions);
  assert.deepEqual(next.completedAssessments, saved.completedAssessments); assert.deepEqual(await readFile(path), bytes);
  assert.equal(await readFile(join(f.base, 'sources/update.txt'), 'utf8'), documents['update.txt']);
});

test('ACTUAL CLI: consumer multi-page reads bind the observed revision and resume at exact codepoint offsets', async () => {
  const f = await actualFixture(), provider = await createLocalRegistrar(f.config);
  const input = inputFor(f.source, join(f.base, 'task'));
  const result = await investigateDesignUpdate({ ...input, request: { ...input.request, budget: { ...input.request.budget,
    codePointsPerRead: 23, readPagesPerDocument: 10, contextCodePoints: 32000 } }, provider, assess: async ({ checkpoint }) => {
    assert.equal(checkpoint.pendingReads.length, 0);
    for (const [path, body] of Object.entries(documents)) {
      assert.equal(checkpoint.evidence.filter(e => e.document.path === path).map(e => e.excerpt).join(''), body);
    }
    return assessFixture(checkpoint);
  } });
  assert.equal(result.status, 'ISSUES');
  assert((await loadInvestigation(result.evidencePaths.at(-1)!)).evidence.length > 4);
});

test('ACTUAL CLI: mutation during assessment makes findings stale while preserving original source identity', async () => {
  const f = await actualFixture(), provider = await createLocalRegistrar(f.config);
  const result = await investigateDesignUpdate({ ...inputFor(f.source, join(f.base, 'task')), provider, assess: async ({ checkpoint }) => {
    const value = assessFixture(checkpoint);
    await writeFile(join(f.base, 'sources/dependency.txt'), 'Changed synthetic dependency\r\n'); return value;
  } });
  const saved = await loadInvestigation(result.evidencePaths.at(-1)!);
  assert.equal(result.status, 'BLOCKED'); assert.equal(saved.findingValidity[0].state, 'stale');
  assert(saved.evidence.some(e => e.excerpt === documents['dependency.txt']));
  assert(saved.checks.some(c => c.state === 'changed'));
});

test('ACTUAL CLI: a fresh changed dependency revision is assessed while the old investigation stays immutable', async () => {
  const f = await actualFixture(), provider = await createLocalRegistrar(f.config);
  const input = inputFor(f.source, join(f.base, 'task'));
  const oldResult = await investigateDesignUpdate({ ...input, provider, assess: async ({ checkpoint }) => assessFixture(checkpoint) });
  assert.equal(oldResult.status, 'ISSUES');
  const oldPath = oldResult.evidencePaths.at(-1)!;
  const oldBytes = await readFile(oldPath), oldCheckpoint = await loadInvestigation(oldPath);
  assert(Object.isFrozen(oldCheckpoint));
  assert.deepEqual(oldCheckpoint.assessment, assessFixture(oldCheckpoint));
  assert.equal(oldCheckpoint.completedAssessments.length, 1);
  const oldDependency = oldCheckpoint.evidence.find(e => e.document.path === 'dependency.txt');
  assert(oldDependency);
  assert.equal(oldDependency.sha256, createHash('sha256').update(Buffer.from(documents['dependency.txt'])).digest('hex'));
  assert.equal(oldDependency.excerpt, documents['dependency.txt']);

  const changedBytes = Buffer.from('Dependency: changed revision requires fresh semantic review 😀 café.\r\n');
  const changedHash = createHash('sha256').update(changedBytes).digest('hex');
  assert.notEqual(changedHash, oldDependency.sha256);
  const fresh = await prepareRegistrar({ python: f.config.python, registrarSource: f.config.registrarSource,
    documents: Object.entries(documents).map(([path, body]) => ({ path, bytes: path === 'dependency.txt' ? changedBytes : Buffer.from(body) })) });
  assert.notEqual(fresh.base, f.base); assert.notEqual(fresh.config.preparation, f.config.preparation);
  assert.deepEqual(await readFile(join(fresh.base, 'sources/dependency.txt')), changedBytes);
  const freshProvider = await createLocalRegistrar(fresh.config);
  let assessments = 0, partialPath = '';
  const result = await investigateDesignUpdate({ ...inputFor(fresh.source, input.task.directory), provider: freshProvider,
    assess: async ({ checkpoint, checkpointPath }) => {
      assessments++; partialPath = checkpointPath;
      assert.equal(checkpoint.prior, null); assert.equal(checkpoint.assessment, null);
      assert.deepEqual(checkpoint.completedAssessments, []);
      const dependency = checkpoint.evidence.find(e => e.document.path === 'dependency.txt');
      assert(dependency);
      assert.equal(dependency.sha256, changedHash); assert.equal(dependency.excerpt, changedBytes.toString('utf8'));
      assert(checkpoint.contextEvidenceIds.includes(dependency.id));
      assert.notEqual(dependency.id, oldDependency.id);
      return assessFixture(checkpoint);
    } });
  assert.equal(assessments, 1);
  const path = result.evidencePaths.at(-1)!, saved = await loadInvestigation(path);
  assert.deepEqual(result, { status: 'ISSUES', summary: 'Source-cited assessment saved; independent semantic review is required.',
    evidencePaths: [partialPath, path], rawLogPath: null });
  assert.notEqual(path, oldPath); assert.equal(saved.prior, partialPath);
  assert.deepEqual(saved.assessment, assessFixture(saved)); assert.equal(saved.completedAssessments.length, 1);
  const dependency = saved.evidence.find(e => e.document.path === 'dependency.txt');
  assert(dependency);
  assert.equal(dependency.sha256, changedHash); assert.equal(dependency.excerpt, changedBytes.toString('utf8'));
  assert.deepEqual(dependency.span, { unit: 'unicode-codepoint', start: 0, end: Array.from(changedBytes.toString('utf8')).length });
  assert.notEqual(dependency.id, oldDependency.id); assert(saved.contextEvidenceIds.includes(dependency.id));
  assert(!saved.evidence.some(e => e.id === oldDependency.id));
  assert.deepEqual(saved.gaps, []); assert.deepEqual(saved.pendingReads, []);
  assert.equal(saved.checks.length, saved.evidence.length); assert(saved.checks.every(c => c.state === 'unchanged'));
  assert.deepEqual(saved.findingValidity, [{ id: 'comparison-1', state: 'needs-semantic-review' }]);
  assert.equal(saved.semanticReview, 'required');
  assert.deepEqual(await readFile(oldPath), oldBytes);
  assert.deepEqual(await loadInvestigation(oldPath), oldCheckpoint);
  assert.equal(await readFile(join(f.base, 'sources/dependency.txt'), 'utf8'), documents['dependency.txt']);
});

test('ACTUAL CLI: selected file missing is unavailable; provider database loss is unknown and does not recreate state', async () => {
  const f = await actualFixture(), provider = await createLocalRegistrar(f.config);
  const read = await provider.read({ document: { source: f.source, path: 'plan.txt' }, expectedSha256: null, maxCodePoints: 200, maxBytes: 16000, continuation: null });
  assert(read.ok);
  await unlink(join(f.base, 'sources/plan.txt'));
  assert.equal((await provider.revalidate(read.value.evidence)).state, 'unavailable');
  await rename(join(f.base, 'state/registry.sqlite3'), join(f.base, 'state/saved-registry.sqlite3'));
  assert.equal((await provider.revalidate(read.value.evidence)).state, 'unknown');
  await assert.rejects(readFile(join(f.base, 'state/registry.sqlite3')), { code: 'ENOENT' });
});

test('ACTUAL CLI: implementation files beyond retrieval.py and configuration are rechecked', async () => {
  const f = await actualFixture(), copied = join(f.base, 'registrar-copy');
  await cp(join(f.config.registrarSource, 'src'), join(copied, 'src'), { recursive: true });
  for (const path of ['pyproject.toml', 'uv.lock']) await cp(join(f.config.registrarSource, path), join(copied, path));
  const provider = await createLocalRegistrar({ ...f.config, registrarSource: copied });
  assert.match(provider.identity.implementation, /registrar-source\+adapter\+python-binary/);
  const read = await provider.read({ document: { source: f.source, path: 'plan.txt' }, expectedSha256: null, maxCodePoints: 200, maxBytes: 16000, continuation: null }); assert(read.ok);
  const cli = join(copied, 'src/knowledge_agent/cli.py'), original = await readFile(cli);
  await writeFile(cli, Buffer.concat([original, Buffer.from('\n# synthetic identity mutation\n')]));
  const changed = await provider.revalidate(read.value.evidence); assert.equal(changed.state, 'unknown'); assert.match(changed.detail, /implementation changed/);
  await writeFile(cli, original);
  await writeFile(join(f.base, 'state/evidence-policy.json'), '{}');
  assert.equal((await provider.revalidate(read.value.evidence)).state, 'unknown');
});
