import test from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsage, measure, capture, prepare, run, report, summarize, qualityAccepted } from './token-waste-pilot.mjs';

const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 };
const events = (u = usage, id) => [{ type: 'turn.started', ...(id ? { turn_id: id } : {}) }, { type: 'turn.completed', usage: u, ...(id ? { turn_id: id } : {}) }];
const jsonl = e => e.map(x => JSON.stringify(x)).join('\n') + '\n';
const good = { code: 0, signal: null, timedOut: false, overflow: false, error: null };
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'token-pilot-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('completed turn accounting excludes cached subset, reasoning, and cumulative updates', () => {
  const raw = jsonl([...events({ ...usage, reasoning_output_tokens: 15 }, 'one'), { type: 'token_count', usage: { input_tokens: 999999 } }, ...events(usage, 'two')]);
  const result = parseUsage(raw);
  assert.equal(result.valid, true);
  assert.equal(result.input_tokens, 200);
  assert.equal(result.cached_input_tokens, 80);
  assert.equal(result.output_tokens, 40);
  assert.equal(result.turns, 2);
  assert.equal(result.reasoning_tokens, null);
});

test('cached subset and malformed numeric usage rejected', () => {
  for (const value of [-1, '100', 1.5, Infinity]) assert.equal(parseUsage(jsonl(events({ ...usage, input_tokens: value }))).measured, false);
  assert.equal(parseUsage(jsonl(events({ ...usage, cached_input_tokens: 101 }))).valid, false);
  assert.equal(parseUsage(jsonl(events('bad'))).valid, false);
});

test('unavailable usage stays null, not zero', () => {
  for (const u of [null, {}, { input_tokens: null, cached_input_tokens: 0, output_tokens: 2 }]) {
    const result = parseUsage(jsonl(events(u)));
    assert.equal(result.valid, true);
    assert.equal(result.measured, false);
    assert.equal(result.input_tokens, null);
  }
  assert.equal(parseUsage(jsonl([...events({ output_tokens: 2 }), ...events()])).input_tokens, null);
});

test('duplicate, unpaired, overlapping, failed, malformed and incomplete turns rejected', () => {
  const variants = [
    [...events(), events()[1]], [...events(), ...events()], [...events(usage, 'x'), ...events(usage, 'x')],
    [{ type: 'turn.completed', usage }], [{ type: 'turn.started' }],
    [{ type: 'turn.started' }, ...events()], [...events(), { type: 'turn.failed' }],
    [...events(), { type: 'error', message: 'failed' }], [],
  ];
  for (const e of variants) assert.equal(parseUsage(jsonl(e)).valid, false);
  assert.equal(parseUsage(jsonl(events()) + 'broken').valid, false);
  for (const patch of [{ code: 1 }, { signal: 'SIGKILL' }, { timedOut: true }, { overflow: true }, { error: 'failed' }]) assert.equal(measure(jsonl(events()), { ...good, ...patch }).measured, false);
});

test('quality requires independent identified reviewer, all criteria, corrections, time and exact output', () => {
  const review = { reviewer: 'Reviewer 1', independent: true, accepted: true, criteria: { citations: true }, corrections: [], humanMinutes: 0, outputSha256: 'abc' };
  assert.equal(qualityAccepted(review, ['citations'], 'abc'), true);
  for (const patch of [{ reviewer: '' }, { independent: false }, { corrections: null }, { humanMinutes: null }, { humanMinutes: -1 }, { criteria: {} }, { accepted: false }, { outputSha256: 'other' }]) assert.equal(qualityAccepted({ ...review, ...patch }, ['citations'], 'abc'), false);
});

test('aggregate formula sums input plus output only after every pair is measured and accepted', () => {
  const tasks = ['one', 'two', 'three'].map(id => ({ id, criteria: ['correct'] }));
  const trials = tasks.flatMap(t => ['A', 'B'].map(variant => ({ task: t.id, variant, blindId: t.id + variant, outputSha256: 'hash', elapsedMs: 10, retries: 0, usage: parseUsage(jsonl(events({ input_tokens: variant === 'A' ? 100 : 40, cached_input_tokens: 20, output_tokens: 20 }))) })));
  const reviews = Object.fromEntries(trials.map(t => [t.blindId, { reviewer: 'Human', independent: true, accepted: true, criteria: { correct: true }, corrections: [], humanMinutes: 2, outputSha256: 'hash' }]));
  assert.equal(summarize(trials, tasks).aggregate, null);
  assert.equal(summarize(trials, tasks).pairs[0].A.corrections, null);
  const result = summarize(trials, tasks, reviews);
  assert.deepEqual(result.aggregate, { A: 360, B: 180, inputPlusOutputReductionPercent: 50 });
  delete reviews.threeB;
  assert.equal(summarize(trials, tasks, reviews).status, 'pending/incomplete');
});

test('synthetic executable: capture, failure, missing executable, byte bound and collision', async t => {
  const dir = await temp(t);
  const fixture = join(dir, 'fixture.mjs');
  await writeFile(fixture, `process.stdin.resume(); process.stdin.on('end', () => { console.log(${JSON.stringify(jsonl(events()))}); process.stderr.write('diagnostic'); process.exitCode = Number(process.argv[2] || 0); });`);
  const options = { program: process.execPath, args: [fixture], cwd: dir, directory: join(dir, 'valid'), timeoutMs: 2000, maxBytes: 1024 };
  const meta = await capture(options);
  assert.equal(meta.code, 0);
  assert.equal(measure(await readFile(join(options.directory, 'stdout.jsonl'), 'utf8'), meta).measured, true);
  await assert.rejects(capture(options), { code: 'EEXIST' });
  const failed = await capture({ ...options, args: [fixture, '2'], directory: join(dir, 'failed') });
  assert.equal(measure(jsonl(events()), failed).valid, false);
  const absent = await capture({ ...options, program: join(dir, 'absent'), directory: join(dir, 'absent-capture') });
  assert.ok(absent.error);
  const bounded = await capture({ ...options, maxBytes: 10, directory: join(dir, 'bounded') });
  assert.equal(bounded.overflow, true);
  const retained = await readFile(join(dir, 'bounded', 'stdout.jsonl'));
  assert.ok(retained.length <= 10);
});

test('timeout kills process group and retains invalid attempt', async t => {
  const dir = await temp(t);
  const meta = await capture({ program: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], cwd: dir, directory: join(dir, 'timeout'), timeoutMs: 100, maxBytes: 1000 });
  assert.equal(meta.timedOut, true);
  assert.equal(meta.signal, 'SIGTERM');
  assert.equal(measure('', meta).valid, false);
  assert.ok(await readFile(join(dir, 'timeout', 'process.json')));
});

test('prepare and six-run orchestration with synthetic CLI, then explicit review and tamper gating', async t => {
  const dir = await temp(t), prepared = join(dir, 'prepared'), output = join(dir, 'run');
  const plan = await prepare({ out: prepared, model: 'synthetic-model', reasoning: 'medium', timeoutMs: 3000 });
  assert.equal(plan.prompts.length, 6);
  assert.deepEqual(plan.order, ['investigation-A', 'investigation-B', 'qa-B', 'qa-A', 'revision-A', 'revision-B']);
  await assert.rejects(prepare({ out: prepared, model: 'test', reasoning: 'medium' }), { code: 'EEXIST' });
  const cli = join(dir, 'fake-codex');
  await writeFile(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('SYNTHETIC CLI 1'); } else { process.stdin.resume(); process.stdin.on('end', () => { console.log(${JSON.stringify(jsonl([...events(), { type: 'item.completed', item: { type: 'agent_message', text: 'Synthetic answer' } }]))}); }); }\n`);
  await chmod(cli, 0o700);
  const result = await run({ plan: join(prepared, 'plan.json'), out: output, codex: cli });
  assert.equal(result.status, 'pending/incomplete');
  const reviews = JSON.parse(await readFile(join(output, 'review-template.json')));
  for (const review of Object.values(reviews)) Object.assign(review, { reviewer: 'Synthetic test reviewer', independent: true, accepted: true, humanMinutes: 1, corrections: [], criteria: Object.fromEntries(Object.keys(review.criteria).map(k => [k, true])) });
  const reviewPath = join(dir, 'review.json');
  await writeFile(reviewPath, JSON.stringify(reviews));
  assert.equal((await report({ run: output, review: reviewPath })).status, 'complete');
  // Contradictions refuse even with otherwise fully accepted synthetic reviews.
  for (const [relative, mutate] of [
    ['investigation-A/prompt.txt', text => text + 'changed prompt'],
    ['investigation-A/process.json', text => { const m = JSON.parse(text); m.args[m.args.indexOf('--model') + 1] = 'other'; return JSON.stringify(m); }],
    ['investigation-A/process.json', text => { const m = JSON.parse(text); m.args = m.args.map(a => a.startsWith('model_reasoning_effort=') ? 'model_reasoning_effort="high"' : a); return JSON.stringify(m); }],
    ['investigation-A/process.json', text => { const m = JSON.parse(text); m.args.push('-c', 'web_search="live"'); return JSON.stringify(m); }],
    ['investigation-A/startup.json', text => { const m = JSON.parse(text); m.pid++; return JSON.stringify(m); }],
    ['run.json', text => { const m = JSON.parse(text); m.program = 'other'; return JSON.stringify(m); }],
    ['version/process.json', text => { const m = JSON.parse(text); m.args = ['exec']; return JSON.stringify(m); }],
    ['version/stdout.jsonl', text => text + 'changed version'],
  ]) {
    const path = join(output, relative), original = await readFile(path, 'utf8');
    const changed = mutate(original);
    assert.notEqual(changed, original, relative);
    await writeFile(path, changed);
    await assert.rejects(report({ run: output, review: reviewPath }), /binding|hash/i);
    await writeFile(path, original);
  }
  await writeFile(join(output, 'investigation-A', 'stdout.jsonl'), jsonl(events()));
  await assert.rejects(report({ run: output, review: reviewPath }), /hash/i);
  await assert.rejects(run({ plan: join(prepared, 'plan.json'), out: output, codex: cli }), { code: 'EEXIST' });
});

test('synthetic CLI incomplete completion and absent final stay invalid through report', async t => {
  const dir = await temp(t), prepared = join(dir, 'prepared'), output = join(dir, 'run');
  await prepare({ out: prepared, model: 'synthetic-model', reasoning: 'medium', timeoutMs: 3000 });
  const cli = join(dir, 'fake-codex');
  await writeFile(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('SYNTHETIC'); else { process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(jsonl([{ type: 'turn.started' }]))})); }\n`);
  await chmod(cli, 0o700);
  const result = await run({ plan: join(prepared, 'plan.json'), out: output, codex: cli });
  assert.equal(result.status, 'pending/incomplete');
  assert.equal(result.pairs[0].A.usage.valid, false);
  const reread = await report({ run: output });
  assert.equal(reread.aggregate, null);
  assert.equal(reread.pairs[0].A.usage.valid, false);
});

test('raw capture preserves arbitrary stream bytes and their bounded size', async t => {
  const dir = await temp(t);
  await capture({ program: process.execPath, args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.from([255, 254, 0, 10])))"], cwd: dir, directory: join(dir, 'raw') });
  assert.deepEqual(await readFile(join(dir, 'raw', 'stdout.jsonl')), Buffer.from([255, 254, 0, 10]));
});


test('turn IDs must agree exactly on both events; anonymous pairs remain supported', () => {
  for (const [started, completed] of [['one', 'two'], ['one', undefined], [undefined, 'one'], [1, 1], ['', ''], [{}, {}]]) {
    assert.equal(parseUsage(jsonl([{ type: 'turn.started', turn_id: started }, { type: 'turn.completed', turn_id: completed, usage }])).valid, false);
  }
  assert.equal(parseUsage(jsonl(events(usage, 'same'))).measured, true);
  assert.equal(parseUsage(jsonl(events())).measured, true);
});

const waitFor = async fn => {
  for (let i = 0; i < 200; i++) { try { if (await fn()) return; } catch {} await delay(20); }
  throw Error('Timed out waiting for fixture evidence');
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) test(`coordinator ${signal} retains incremental bytes and startup identity`, async t => {
  const dir = await temp(t), directory = join(dir, 'capture');
  const module = new URL('./token-waste-pilot.mjs', import.meta.url).href;
  // Both the direct worker and its descendant ignore TERM to exercise group escalation.
  const worker = join(dir, 'worker.mjs');
  await writeFile(worker, `import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
process.stdin.resume();
process.stdout.write(JSON.stringify({ descendant: descendant.pid }) + '\\n');
process.stderr.write('retained stderr');
setInterval(() => {}, 1000);`);
  const launcher = join(dir, 'launcher.mjs');
  await writeFile(launcher, `import { capture } from ${JSON.stringify(module)}; await capture(${JSON.stringify({ program: process.execPath, args: [worker], cwd: dir, directory, timeoutMs: 10000 })});`);
  const coordinator = spawn(process.execPath, [launcher], { stdio: 'ignore' });
  const closed = new Promise(resolve => coordinator.once('close', (code, signal) => resolve({ code, signal })));
  let startup;
  t.after(() => { coordinator.kill('SIGKILL'); if (startup?.pid) { try { process.kill(-startup.pid, 'SIGKILL'); } catch {} } });
  await waitFor(async () => {
    startup = JSON.parse(await readFile(join(directory, 'startup.json'), 'utf8'));
    return (await readFile(join(directory, 'stdout.jsonl'), 'utf8')).includes('descendant') && (await readFile(join(directory, 'stderr.txt'), 'utf8')).includes('retained stderr');
  });
  assert.equal(startup.coordinatorPid, coordinator.pid);
  assert.equal(startup.processGroupId, startup.pid);
  const raw = await readFile(join(directory, 'stdout.jsonl'), 'utf8');
  const descendant = JSON.parse(raw.trim()).descendant;
  coordinator.kill(signal);
  await closed;
  assert.equal(await readFile(join(directory, 'stdout.jsonl'), 'utf8'), raw);
  if (signal === 'SIGKILL') {
    await assert.rejects(readFile(join(directory, 'process.json')), { code: 'ENOENT' });
    // Hard kill cannot run cleanup: manually terminate the retained group in this fixture.
    process.kill(startup.pid, 0);
    process.kill(-startup.pid, 'SIGKILL');
  } else {
    const meta = JSON.parse(await readFile(join(directory, 'process.json'), 'utf8'));
    assert.equal(meta.interrupted, signal);
    assert.equal(measure(jsonl(events()), meta).valid, false);
    await waitFor(() => { try { process.kill(startup.pid, 0); return false; } catch { return true; } });
    await waitFor(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
  }
});


test('interrupted serial run stops before second trial and report remains pending', async t => {
  const dir = await temp(t), prepared = join(dir, 'prepared'), output = join(dir, 'run');
  await prepare({ out: prepared, model: 'synthetic-model', reasoning: 'medium' });
  const cli = join(dir, 'fake-codex');
  await writeFile(cli, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('SYNTHETIC CLI');
else { process.stdin.resume(); process.stdout.write('partial evidence'); setInterval(() => {}, 1000); }
`);
  await chmod(cli, 0o700);
  const coordinator = spawn(process.execPath, [new URL('./token-waste-pilot.mjs', import.meta.url).pathname, 'run', '--plan', join(prepared, 'plan.json'), '--out', output, '--codex', cli], { stdio: 'ignore' });
  const closed = new Promise(resolve => coordinator.once('close', code => resolve(code)));
  t.after(() => coordinator.kill('SIGKILL'));
  await waitFor(async () => (await readFile(join(output, 'investigation-A', 'stdout.jsonl'), 'utf8')) === 'partial evidence');
  coordinator.kill('SIGTERM');
  assert.equal(await closed, 1);
  assert.equal((await report({ run: output })).status, 'pending/incomplete');
  assert.equal(JSON.parse(await readFile(join(output, 'investigation-A', 'process.json'))).interrupted, 'SIGTERM');
  await assert.rejects(readFile(join(output, 'investigation-B', 'startup.json')), { code: 'ENOENT' });
  await rm(join(output, 'version', 'process.json'));
  assert.equal((await report({ run: output })).status, 'pending/incomplete');
});
