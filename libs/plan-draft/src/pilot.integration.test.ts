import assert from 'node:assert/strict';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { actualFixture } from '../../knowledge/src/support/fixtures.js';
import type { JudgmentRole } from './index.js';
import type { PilotConfiguration } from './pilot-config.js';
import {
  commandConfiguration,
  commandEvents,
} from './support/command-fixtures.js';
import {
  digest,
  outcome,
  pilotIntent,
  runPilot,
  runPilotNx,
} from './support/pilot-fixtures.js';

async function fixture(modes: Partial<Record<JudgmentRole, string>> = {}) {
  const prepared = await actualFixture();
  const directory = join(prepared.base, 'task');
  const intent = await pilotIntent(prepared.source, directory);
  const config: PilotConfiguration = {
    schema: 1,
    registrar: prepared.config,
    judgments: await commandConfiguration(directory, modes),
    command: { kind: 'start', intent },
  };
  const path = join(directory, 'pilot config.json');
  await writeFile(path, JSON.stringify(config));
  const resume = join(directory, 'resume.json');
  await writeFile(
    resume,
    JSON.stringify({
      ...config,
      command: {
        kind: 'resume',
        task: intent.task,
        destination: intent.destination,
      },
    }),
  );
  return { prepared, directory, intent, config, path, resume };
}

test('ACTUAL Registrar pilot CLI publishes exact reviewed bytes and Nx forwards a fresh resume', async () => {
  const f = await fixture();
  const first = runPilot(['--config', f.path]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const result = outcome(first.stdout);
  assert.equal(result.kind, 'draft');
  assert(result.kind === 'draft');
  assert.deepEqual(Object.keys(result).sort(), [
    'checkpointPath',
    'draft',
    'investigation',
    'kind',
  ]);
  assert.equal(result.investigation.status, 'ISSUES');
  assert.equal(result.draft.status, 'PASS');
  assert.match(first.stderr, /Investigation: ISSUES; draft: PASS/);
  assert.match(first.stderr, /Checkpoint: /);
  assert(result.draft.evidencePaths.includes(f.intent.destination));
  await readFile(result.checkpointPath);
  for (const path of result.investigation.evidencePaths) await readFile(path);
  const events = await commandEvents(f.directory);
  assert.deepEqual(
    events.map((e) => e.request.role),
    ['assess', 'propose', 'review'],
  );
  const review = events[2].request.untrusted;
  const bytes = await readFile(f.intent.destination, 'utf8');
  assert.equal(bytes, review.candidate.markdown);
  assert.equal(digest(bytes), review.candidate.sha256);
  assert.equal(review.checkpoint.provider.instance, f.prepared.source.provider);
  assert.match(JSON.stringify(review.checkpoint.evidence), /execute evil/);
  assert.equal(
    events[0].request.trusted.brief.context,
    'Trusted coordinator instructions.',
  );
  assert.match(bytes, /Keep D1 open/);
  assert.match(bytes, /What is still unknown/);
  const inode = (await lstat(f.intent.destination)).ino;
  const retry = runPilot([`--config=${f.path}`]);
  assert.equal(retry.status, 0, retry.stdout);
  assert.deepEqual(outcome(retry.stdout).investigation, result.investigation);
  await rename(
    f.config.judgments.roles.review.args[0],
    join(f.directory, 'unavailable.mjs'),
  );
  const resumed = runPilotNx([`--config=${f.resume}`]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const jsonLine = resumed.stdout
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
    .find((line) => line.startsWith('{"kind":'));
  assert(jsonLine, resumed.stdout);
  assert.equal(outcome(jsonLine).kind, 'draft');
  assert.deepEqual(outcome(jsonLine).investigation, result.investigation);
  assert.equal((await lstat(f.intent.destination)).ino, inode);
  assert.deepEqual(await commandEvents(f.directory), events);
  const directResume = runPilot(['--config', f.resume]);
  assert.equal(directResume.status, 0, directResume.stdout);
  assert.equal(await readFile(f.intent.destination, 'utf8'), bytes);
  assert.deepEqual(await commandEvents(f.directory), events);
  await writeFile(
    join(f.prepared.base, 'sources', 'plan.txt'),
    'Changed required source.',
  );
  const drift = runPilot(['--config', f.resume]);
  assert.equal(drift.status, 2, drift.stdout);
  const blocked = outcome(drift.stdout);
  assert(blocked.kind === 'draft');
  assert.equal(blocked.draft.status, 'BLOCKED');
  assert.match(blocked.draft.summary, /before publication evidence .*changed/);
  assert(blocked.draft.evidencePaths.includes(f.intent.destination));
  assert(drift.stderr.includes(JSON.stringify(f.intent.destination)));
  assert.equal(await readFile(f.intent.destination, 'utf8'), bytes);
  assert.deepEqual(await commandEvents(f.directory), events);
});

test('ACTUAL Registrar pilot recovers accepted preparation after a process crash with unavailable judgments', async () => {
  const f = await fixture();
  const crash = runPilot(
    ['--config', f.path],
    [
      fileURLToPath(
        new URL('./support/pilot-prepared-crash.mjs', import.meta.url),
      ),
    ],
  );
  assert.equal(crash.status, 73, crash.stdout + crash.stderr);
  assert.equal(crash.stdout, '');
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  const preparationName = (await readdir(f.directory)).find((name) =>
    name.endsWith('-prepared.json'),
  );
  assert(preparationName);
  const saved = JSON.parse(
    await readFile(join(f.directory, preparationName), 'utf8'),
  );
  const events = await commandEvents(f.directory);
  assert.deepEqual(
    events.map((e) => e.request.role),
    ['assess', 'propose', 'review'],
  );
  assert.equal(
    saved.candidate.markdown,
    events[2].request.untrusted.candidate.markdown,
  );
  await rename(
    f.config.judgments.roles.review.args[0],
    join(f.directory, 'unavailable.mjs'),
  );
  const resumed = runPilot(['--config', f.resume]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const result = outcome(resumed.stdout);
  assert(result.kind === 'draft');
  assert.equal(result.draft.status, 'PASS');
  assert.equal(
    await readFile(f.intent.destination, 'utf8'),
    saved.candidate.markdown,
  );
  assert.deepEqual(await commandEvents(f.directory), events);
  await rename(f.intent.destination, join(f.directory, 'retained-draft.md'));
  const missing = runPilot(['--config', f.resume]);
  assert.equal(missing.status, 2, missing.stdout);
  const blocked = outcome(missing.stdout);
  assert(blocked.kind === 'draft');
  assert.equal(blocked.draft.status, 'BLOCKED');
  assert.match(blocked.draft.summary, /Completed output is missing/);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  assert.deepEqual(await commandEvents(f.directory), events);
});

test('ACTUAL Registrar pilot never replays uncertain review or accepts replacement service identity', async () => {
  const f = await fixture({ review: 'nonzero' });
  const first = runPilot(['--config', f.path]);
  assert.equal(first.status, 2, first.stdout);
  const result = outcome(first.stdout);
  assert(result.kind === 'draft');
  assert.equal(result.investigation.status, 'ISSUES');
  assert.equal(result.draft.status, 'BLOCKED');
  assert.match(result.draft.summary, /unsuccessful exit/);
  assert(!first.stdout.includes('sensitive-error'));
  const events = await commandEvents(f.directory);
  assert.deepEqual(
    events.map((e) => e.request.role),
    ['assess', 'propose', 'review'],
  );
  const resumed = runPilot(['--config', f.resume]);
  assert.equal(resumed.status, 2, resumed.stdout);
  const retry = outcome(resumed.stdout);
  assert(retry.kind === 'draft');
  assert.equal(retry.draft.status, 'BLOCKED');
  assert.match(retry.draft.summary, /may be unsaved or rejected/);
  const changed = JSON.parse(await readFile(f.resume, 'utf8'));
  changed.judgments.roles.review.service.id = 'replacement-service';
  await writeFile(f.resume, JSON.stringify(changed));
  const identity = runPilot(['--config', f.resume]);
  assert.equal(identity.status, 2, identity.stdout);
  const stopped = outcome(identity.stdout);
  assert(stopped.kind === 'stopped');
  assert.deepEqual(Object.keys(stopped).sort(), [
    'checkpointPath',
    'investigation',
    'kind',
    'result',
  ]);
  assert.equal(stopped.result.status, 'BLOCKED');
  assert.match(stopped.result.summary, /identit|binding|configuration/i);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  assert.deepEqual(await commandEvents(f.directory), events);
});

test('ACTUAL Registrar pilot retains a failed investigation in the complete stopped outcome', async () => {
  const f = await fixture({ assess: 'malformed' });
  const first = runPilot(['--config', f.path]);
  assert.equal(first.status, 2, first.stdout);
  const result = outcome(first.stdout);
  assert(result.kind === 'stopped');
  assert.equal(result.result.status, 'BLOCKED');
  assert.equal(result.investigation?.status, 'BLOCKED');
  assert.match(first.stderr, /Investigation: BLOCKED; stopped: BLOCKED/);
  assert(result.investigation);
  assert(result.investigation.evidencePaths.length > 0);
  for (const path of result.investigation.evidencePaths) await readFile(path);
  const events = await commandEvents(f.directory);
  assert.deepEqual(
    events.map((e) => e.request.role),
    ['assess'],
  );
  assert(!first.stdout.includes('sensitive-output'));
  const resumed = runPilot(['--config', f.resume]);
  assert.equal(resumed.status, 2, resumed.stdout);
  assert.deepEqual(outcome(resumed.stdout).investigation, result.investigation);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  assert.deepEqual(await commandEvents(f.directory), events);
});
