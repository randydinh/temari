#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '8ba956bb0c3c228f851de155d996d357aef2de33';
const hash = value => createHash('sha256').update(value).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const positive = x => Number.isSafeInteger(x) && x > 0;
const nonnegative = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// Only completed-turn usage is authoritative. token_count updates are ignored.
export function parseUsage(raw) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let active = false, activeId = null, turns = 0;
  const seenIds = new Set(), anonymousTotals = new Set();
  try {
    for (const line of raw.split('\n').filter(x => x.trim())) {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== 'string') throw Error('Malformed event');
      if (event.type === 'error' || event.type === 'turn.failed') throw Error('Failed event');
      if (['turn.started', 'turn.completed'].includes(event.type) && event.turn_id != null && (typeof event.turn_id !== 'string' || !event.turn_id.trim())) throw Error('Invalid turn ID');
      if (event.type === 'turn.started') {
        if (active) throw Error('Overlapping turns');
        active = true;
        activeId = event.turn_id ?? null;
        if (activeId !== null && seenIds.has(activeId)) throw Error('Duplicate started turn ID');
      }
      if (event.type !== 'turn.completed') continue;
      if (!active) throw Error('Duplicate or unpaired completion');
      if (activeId !== (event.turn_id ?? null)) throw Error('Inconsistent started/completed turn ID');
      active = false;
      if (event.turn_id != null) {
        if (seenIds.has(event.turn_id)) throw Error('Duplicate turn ID');
        seenIds.add(event.turn_id);
      }
      const usage = event.usage;
      if (usage != null && (typeof usage !== 'object' || Array.isArray(usage))) throw Error('Malformed usage');
      for (const key of Object.keys(totals)) {
        const value = usage?.[key] ?? null;
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw Error(`Invalid ${key}`);
        totals[key] = value === null || totals[key] === null ? null : totals[key] + value;
        if (totals[key] !== null && !Number.isSafeInteger(totals[key])) throw Error('Unsafe total');
      }
      if (usage?.cached_input_tokens != null && usage?.input_tokens != null && usage.cached_input_tokens > usage.input_tokens) throw Error('Cached input exceeds input');
      if (event.turn_id == null) {
        const signature = JSON.stringify(Object.keys(totals).map(key => usage?.[key] ?? null));
        if (anonymousTotals.has(signature)) throw Error('Ambiguous duplicate anonymous totals');
        anonymousTotals.add(signature);
      }
      turns++;
    }
    if (active || !turns) throw Error('Incomplete turn');
    return { valid: true, measured: Object.values(totals).every(x => x !== null), turns, ...totals, reasoning_tokens: null, error: null };
  } catch (error) {
    return { valid: false, measured: false, turns, input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, error: error.message };
  }
}

export async function capture({ program, args, cwd, prompt = '', directory, timeoutMs = 300000, maxBytes = 8388608, env = process.env }) {
  if (!positive(timeoutMs) || !positive(maxBytes)) throw Error('Invalid capture limits');
  await mkdir(directory, { mode: 0o700 }); // collisions fail before launch
  await save(join(directory, 'prompt.txt'), prompt);
  const startedAt = new Date().toISOString(), start = performance.now();
  let timedOut = false, overflow = false, error = null, bytes = 0, interrupted = null;
  const streams = { stdout: [], stderr: [] };
  const fds = Object.fromEntries(['stdout', 'stderr'].map(name => [name, openSync(join(directory, name === 'stdout' ? 'stdout.jsonl' : 'stderr.txt'), 'wx', 0o600)]));
  const durable = (file, value) => {
    const fd = openSync(join(directory, file), 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const identity = { captureVersion: 2, program, args, cwd, startedAt, coordinatorPid: process.pid, promptSha256: hash(prompt), timeoutMs, maxBytes };
  durable('launch.json', identity);
  const child = spawn(program, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const startup = { ...identity, pid: child.pid ?? null, processGroupId: child.pid ?? null };
  try { durable('startup.json', startup); } catch (e) {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    for (const fd of Object.values(fds)) closeSync(fd);
    throw e;
  }
  const signalGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  let escalation;
  const terminate = () => {
    signalGroup('SIGTERM');
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), 250);
  };
  const onSignal = signal => {
    if (!interrupted) { interrupted = signal; durable('interruption.json', { signal, at: new Date().toISOString(), ...startup }); }
    terminate();
  };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  child.on('error', e => { error = e.message; });
  child.stdin.on('error', e => { error = e.message; terminate(); });
  for (const name of ['stdout', 'stderr']) {
    child[name].on('error', e => { error = e.message; terminate(); });
    child[name].on('data', chunk => {
      const available = Math.max(0, maxBytes - bytes);
      const retained = chunk.subarray(0, available);
      if (retained.length) {
        try {
          let offset = 0;
          while (offset < retained.length) offset += writeSync(fds[name], retained, offset);
          fsyncSync(fds[name]);
          streams[name].push(retained);
        } catch (e) { error = e.message; terminate(); }
      }
      bytes += chunk.length;
      if (bytes > maxBytes) { overflow = true; terminate(); }
    });
  }
  child.stdin.end(prompt);
  const result = await new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
  clearTimeout(timer); clearTimeout(escalation);
  signalGroup('SIGKILL'); // descendants may outlive the direct child
  const stdout = Buffer.concat(streams.stdout), stderr = Buffer.concat(streams.stderr);
  const metadata = { ...startup, endedAt: new Date().toISOString(), elapsedMs: performance.now() - start, ...result, timedOut, overflow, interrupted, error, receivedBytes: bytes, stdoutSha256: hash(stdout), stderrSha256: hash(stderr), retries: 0 };
  try {
    for (const fd of Object.values(fds)) { fsyncSync(fd); closeSync(fd); }
    durable('process.json', metadata);
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
  return metadata;
}

export function measure(raw, processInfo) {
  const usage = parseUsage(raw);
  if (processInfo.code !== 0 || processInfo.signal || processInfo.timedOut || processInfo.overflow || processInfo.error || processInfo.interrupted) return { ...usage, valid: false, measured: false, error: 'Failed process/capture' };
  return usage;
}

const executionArgs = (plan, workspace) => ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--model', plan.model, '-c', `model_reasoning_effort=${JSON.stringify(plan.reasoning)}`, '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-C', workspace, '-'];

export async function prepare({ out, model, reasoning, timeoutMs = 300000, maxBytes = 8388608 }) {
  if (!model?.trim() || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw Error('Explicit model and valid reasoning required');
  if (!positive(timeoutMs) || !positive(maxBytes)) throw Error('Invalid limits');
  const tasks = await readJSON(join(ROOT, 'evaluations/token-waste-pilot/tasks.json'));
  const sources = [];
  for (const task of tasks) {
    const data = await readFile(join(ROOT, task.source));
    if (task.id === 'investigation') {
      const pinned = execFileSync('git', ['show', `${BASE}:${task.source}`], { cwd: ROOT });
      if (hash(pinned) !== hash(data)) throw Error('Current investigation source differs from pinned base');
    }
    sources.push({ task: task.id, original: task.source, filename: task.id === 'investigation' ? 'source.ts' : 'source.md', sha256: hash(data), content: data.toString() });
  }
  await mkdir(out, { mode: 0o700 });
  const prompts = [];
  for (const task of tasks) for (const variant of ['A', 'B']) {
    const method = variant === 'A'
      ? 'Use your ordinary efficient workflow: search as useful, read relevant material, verify claims, and answer clearly.'
      : 'Use targeted searches; bound file reads and tool output to relevant ranges. Use code for exact operations and comparisons. Keep the deliverable focused on the requested result.';
    const prompt = `Local CLI-only pilot. ${task.id === 'investigation' ? 'Pinned real source snapshot.' : 'Synthetic fixture.'}\nRead only the supplied source in the working directory. Do not inspect parent paths, other tasks, evaluator materials or other outputs; do not use network or external tools. Do not edit files. Return the requested deliverable, without self-grading or discussing these workflow instructions.\n\n${task.question}\n\n${method}\n`;
    const file = `${task.id}-${variant}.txt`;
    await save(join(out, file), prompt);
    prompts.push({ task: task.id, variant, file, sha256: hash(prompt) });
  }
  const plan = { version: 2, argsTemplate: executionArgs({ model, reasoning }, '<WORKSPACE>'), scope: 'local CLI-only; two synthetic tasks', pinnedBase: BASE, model, reasoning, timeoutMs, maxBytes, tasks, sources, prompts, order: ['investigation-A', 'investigation-B', 'qa-B', 'qa-A', 'revision-A', 'revision-B'] };
  await save(join(out, 'plan.json'), plan);
  return plan;
}

export function qualityAccepted(review, criteria, outputSha256) {
  return Boolean(review && typeof review.reviewer === 'string' && review.reviewer.trim() && review.independent === true && review.accepted === true && review.outputSha256 === outputSha256 && nonnegative(review.humanMinutes) && Array.isArray(review.corrections) && review.corrections.every(x => typeof x === 'string' && x.trim()) && criteria.every(c => review.criteria?.[c] === true));
}

export function summarize(trials, tasks, reviews = {}) {
  const pairs = tasks.map(task => {
    const pair = {};
    for (const variant of ['A', 'B']) {
      const t = trials.find(x => x.task === task.id && x.variant === variant);
      const review = t ? reviews[t.blindId] : null;
      pair[variant] = t ? { usage: t.usage, tokens: t.usage.measured ? t.usage.input_tokens + t.usage.output_tokens : null, elapsedMs: t.elapsedMs, retries: t.retries, corrections: Array.isArray(review?.corrections) ? review.corrections : null, humanMinutes: nonnegative(review?.humanMinutes) ? review.humanMinutes : null, qualityAccepted: qualityAccepted(review, task.criteria, t.outputSha256) } : null;
    }
    return { task: task.id, ...pair };
  });
  const complete = tasks.length === 3 && trials.length === 6 && new Set(trials.map(t => `${t.task}-${t.variant}`)).size === 6 && pairs.every(p => ['A', 'B'].every(v => p[v]?.usage.valid && p[v].usage.measured && p[v].qualityAccepted));
  const a = complete ? pairs.reduce((n, p) => n + p.A.tokens, 0) : null;
  const b = complete ? pairs.reduce((n, p) => n + p.B.tokens, 0) : null;
  return { status: complete ? 'complete' : 'pending/incomplete', pairs, aggregate: complete ? { A: a, B: b, inputPlusOutputReductionPercent: a > 0 ? 100 * (a - b) / a : null } : null, limitation: 'Three pairs are a CLI pilot, not universal, desktop, daily savings or cost evidence.' };
}

async function validatePlan(plan) {
  const tasks = await readJSON(join(ROOT, 'evaluations/token-waste-pilot/tasks.json'));
  const order = ['investigation-A', 'investigation-B', 'qa-B', 'qa-A', 'revision-A', 'revision-B'];
  if (plan.version !== 2 || JSON.stringify(plan.argsTemplate) !== JSON.stringify(executionArgs(plan, '<WORKSPACE>')) || plan.pinnedBase !== BASE || JSON.stringify(plan.tasks) !== JSON.stringify(tasks) || JSON.stringify(plan.order) !== JSON.stringify(order) || !plan.model?.trim() || !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(plan.reasoning) || !positive(plan.timeoutMs) || !positive(plan.maxBytes) || plan.sources?.length !== 3 || plan.prompts?.length !== 6) throw Error('Invalid fixed pilot plan');
  for (const task of tasks) {
    const sources = plan.sources.filter(s => s.task === task.id);
    if (sources.length !== 1 || sources[0].original !== task.source || sources[0].filename !== (task.id === 'investigation' ? 'source.ts' : 'source.md') || hash(sources[0].content) !== sources[0].sha256) throw Error('Invalid source binding');
    for (const variant of ['A', 'B']) {
      const prompts = plan.prompts.filter(p => p.task === task.id && p.variant === variant);
      if (prompts.length !== 1 || prompts[0].file !== `${task.id}-${variant}.txt`) throw Error('Invalid prompt binding');
    }
  }
}

export async function run({ plan: planPath, out, codex = 'codex' }) {
  if (process.platform === 'win32') throw Error('POSIX process groups required');
  const planBytes = await readFile(planPath), plan = JSON.parse(planBytes);
  await validatePlan(plan);
  const prepared = dirname(planPath);
  for (const source of plan.sources) if (hash(source.content) !== source.sha256) throw Error('Source hash mismatch');
  const prompts = new Map();
  for (const p of plan.prompts) {
    const text = await readFile(join(prepared, p.file), 'utf8');
    if (hash(text) !== p.sha256) throw Error('Prompt hash mismatch');
    prompts.set(`${p.task}-${p.variant}`, text);
  }
  await mkdir(out, { mode: 0o700 });
  await save(join(out, 'plan.json'), planBytes.toString());
  await save(join(out, 'plan-sha256.txt'), hash(planBytes));
  await mkdir(join(out, 'blind'));
  await save(join(out, 'run.json'), { version: 2, program: codex, planSha256: hash(planBytes) });
  const versionMeta = await capture({ program: codex, args: ['--version'], cwd: ROOT, directory: join(out, 'version'), timeoutMs: 10000, maxBytes: 65536 });
  if (versionMeta.interrupted || versionMeta.signal || versionMeta.code !== 0 || versionMeta.error || versionMeta.overflow || versionMeta.timedOut) throw Error('CLI version capture failed; retained attempt');
  const trials = [], mapping = {}, template = {};
  // One common cwd for all trials, containing only the current task source.
  const workspace = await mkdtemp(join(tmpdir(), 'token-pilot-source-'));
  try {
    for (const key of plan.order) {
      const p = plan.prompts.find(p => `${p.task}-${p.variant}` === key);
      const source = plan.sources.find(s => s.task === p.task);
      for (const file of ['source.ts', 'source.md']) await rm(join(workspace, file), { force: true });
      await save(join(workspace, source.filename), source.content);
      await chmod(join(workspace, source.filename), 0o444);
      const args = executionArgs(plan, workspace);
      const directory = join(out, key);
      const meta = await capture({ program: codex, args, cwd: workspace, prompt: prompts.get(key), directory, timeoutMs: plan.timeoutMs, maxBytes: plan.maxBytes });
      if (meta.interrupted) throw Error(`Coordinator interrupted by ${meta.interrupted}; retained incomplete attempt`);
      const raw = await readFile(join(directory, 'stdout.jsonl'), 'utf8');
      const usage = measure(raw, meta);
      let final = '';
      for (const line of raw.split('\n').filter(x => x.trim())) {
        try { const e = JSON.parse(line); if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') final = e.item.text; } catch { /* usage rejects malformed JSON */ }
      }
      if (!final.trim() || hash(await readFile(join(workspace, source.filename))) !== source.sha256) { usage.valid = usage.measured = false; usage.error = 'Missing final or changed source'; }
      await save(join(directory, 'final.txt'), final);
      const blindId = `${p.task}-${randomUUID()}`;
      const outputSha256 = hash(final);
      await save(join(out, 'blind', `${blindId}.txt`), final);
      mapping[blindId] = { task: p.task, variant: p.variant, directory: key, outputSha256 };
      template[blindId] = { outputSha256, reviewer: null, independent: null, accepted: null, criteria: Object.fromEntries(plan.tasks.find(t => t.id === p.task).criteria.map(c => [c, null])), corrections: null, humanMinutes: null };
      const trial = { task: p.task, variant: p.variant, blindId, outputSha256, usage, elapsedMs: meta.elapsedMs, retries: 0 };
      trials.push(trial);
      await save(join(directory, 'trial.json'), trial);
    }
    await save(join(out, 'mapping.json'), mapping);
    await save(join(out, 'review-template.json'), template);
    await save(join(out, 'trials.json'), trials);
  } finally { await rm(workspace, { recursive: true, force: true }); }
  return summarize(trials, plan.tasks);
}

async function verifyCapture(directory, expected) {
  const meta = await readJSON(join(directory, 'process.json'));
  const startup = await readJSON(join(directory, 'startup.json'));
  const launch = await readJSON(join(directory, 'launch.json'));
  for (const [key, value] of Object.entries({ captureVersion: 2, ...expected })) {
    if (JSON.stringify(meta[key]) !== JSON.stringify(value)) throw Error(`Execution binding mismatch: ${key}`);
  }
  for (const [key, value] of Object.entries(startup)) if (JSON.stringify(meta[key]) !== JSON.stringify(value)) throw Error(`Startup binding mismatch: ${key}`);
  for (const [key, value] of Object.entries(launch)) if (JSON.stringify(startup[key]) !== JSON.stringify(value)) throw Error(`Launch binding mismatch: ${key}`);
  if (!positive(meta.pid) || meta.pid !== meta.processGroupId || !positive(meta.coordinatorPid) || !meta.startedAt || !meta.endedAt || !nonnegative(meta.elapsedMs)) throw Error('Invalid process identity');
  if (hash(await readFile(join(directory, 'prompt.txt'))) !== meta.promptSha256 || hash(await readFile(join(directory, 'stdout.jsonl'))) !== meta.stdoutSha256 || hash(await readFile(join(directory, 'stderr.txt'))) !== meta.stderrSha256) throw Error('Capture hash mismatch');
  return meta;
}

export async function report({ run: directory, review }) {
  const planBytes = await readFile(join(directory, 'plan.json'));
  const plan = JSON.parse(planBytes);
  await validatePlan(plan);
  if (hash(planBytes) !== await readFile(join(directory, 'plan-sha256.txt'), 'utf8')) throw Error('Changed plan');
  const binding = await readJSON(join(directory, 'run.json'));
  if (binding.version !== 2 || binding.planSha256 !== hash(planBytes) || typeof binding.program !== 'string' || !binding.program) throw Error('Invalid run binding');
  let version;
  try {
    version = await verifyCapture(join(directory, 'version'), { program: binding.program, args: ['--version'], cwd: ROOT, promptSha256: hash(''), timeoutMs: 10000, maxBytes: 65536 });
  } catch (e) { if (e.code === 'ENOENT') return summarize([], plan.tasks); throw e; }
  if (version.code !== 0 || version.signal || version.error || version.interrupted || version.timedOut || version.overflow || !(await readFile(join(directory, 'version', 'stdout.jsonl'), 'utf8')).trim()) return summarize([], plan.tasks);
  const trials = [];
  let workspace;
  for (const key of plan.order) {
    try {
      const trial = await readJSON(join(directory, key, 'trial.json'));
      const meta = await readJSON(join(directory, key, 'process.json'));
      workspace ??= meta.cwd;
      const prompt = plan.prompts.find(p => `${p.task}-${p.variant}` === key);
      await verifyCapture(join(directory, key), { program: binding.program, cwd: workspace, args: executionArgs(plan, workspace), promptSha256: prompt.sha256, timeoutMs: plan.timeoutMs, maxBytes: plan.maxBytes });
      const raw = await readFile(join(directory, key, 'stdout.jsonl'));
      trial.elapsedMs = meta.elapsedMs;
      trial.retries = meta.retries;
      const originalUsage = trial.usage;
      trial.usage = measure(raw.toString(), meta);
      const final = await readFile(join(directory, key, 'final.txt'), 'utf8');
      if (!originalUsage.valid || !final.trim() || `${trial.task}-${trial.variant}` !== key) trial.usage.valid = trial.usage.measured = false;
      if (hash(raw) !== meta.stdoutSha256 || hash(await readFile(join(directory, key, 'stderr.txt'))) !== meta.stderrSha256 || hash(await readFile(join(directory, key, 'final.txt'))) !== trial.outputSha256 || hash(await readFile(join(directory, 'blind', `${trial.blindId}.txt`))) !== trial.outputSha256) trial.usage.valid = trial.usage.measured = false;
      trials.push(trial);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return summarize(trials, plan.tasks, review ? await readJSON(review) : {});
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['help', 'out', 'model', 'reasoning', 'plan', 'run', 'review', 'codex', 'timeout-ms', 'max-bytes'].map(k => [k, { type: k === 'help' ? 'boolean' : 'string' }])) });
  if (values.help || !positionals.length) {
    console.log('CLI-only token-waste pilot (synthetic QA/revision).\nprepare --out NEW_DIR --model MODEL --reasoning medium [--timeout-ms 300000 --max-bytes 8388608]\nrun --plan PREPARED/plan.json --out NEW_RUN_DIR [--codex EXECUTABLE]  (LIVE: six model calls)\nreport --run RUN_DIR [--review REVIEW.json]\nPreparation/report/tests make zero model calls. Existing output directories are rejected.');
    return;
  }
  const command = positionals[0];
  for (const key of command === 'prepare' ? ['out', 'model', 'reasoning'] : command === 'run' ? ['plan', 'out'] : command === 'report' ? ['run'] : []) if (!values[key]) throw Error(`Missing --${key}`);
  const options = { ...values, ...(values.out ? { out: resolve(values.out) } : {}), ...(values.plan ? { plan: resolve(values.plan) } : {}), ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}), ...(values['max-bytes'] ? { maxBytes: Number(values['max-bytes']) } : {}) };
  if (!['prepare', 'run', 'report'].includes(command)) throw Error('Unknown command');
  console.log(JSON.stringify(await ({ prepare, run, report }[command])(options), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
