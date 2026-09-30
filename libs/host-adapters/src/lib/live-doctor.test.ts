import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HOST_CAPABILITIES } from '@temari/contracts';

import { runLiveHostDoctor } from './live-doctor.js';

async function executable(
  source: string,
  version = 'codex-cli 0.154.0',
): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'temari-live-doctor-test-'));
  const path = join(root, 'fake-host');
  await writeFile(
    path,
    `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\n${source}\n`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return { root, path };
}

test('Codex live doctor proves only an observed read-only child process', async () => {
  const fake = await executable(`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec' || !args.includes('--ignore-user-config') || args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(9);
const token = fs.readFileSync('challenge.txt', 'utf8').trim();
const final = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:token}));
console.log(JSON.stringify({type:'event',ok:true}));
`);
  const report = await runLiveHostDoctor({
    host: 'codex',
    dataDirectory: fake.root,
    executable: fake.path,
    timeoutMs: 5000,
  });
  assert.equal(report.status, 'OBSERVED');
  assert.equal(report.scope, 'installation-preflight-only');
  assert.deepEqual(report.observedCapabilities, ['subagents']);
  assert.deepEqual(
    report.unprovenCapabilities,
    HOST_CAPABILITIES.filter((capability) => capability !== 'subagents'),
  );
  assert.match(report.processEvidenceSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(report.executableVersion, 'codex-cli 0.154.0');
  assert.match(report.executableSha256 ?? '', /^[0-9a-f]{64}$/);
  const processEvidence = JSON.parse(
    await readFile(report.processEvidencePath!, 'utf8'),
  );
  assert.ok(processEvidence.pid > 0);
  assert.notEqual(processEvidence.pid, process.pid);
  assert.equal(processEvidence.exitCode, 0);
  const saved = JSON.parse(
    await readFile(join(report.runDirectory, 'doctor-report.json'), 'utf8'),
  );
  assert.deepEqual(saved, report);
});

test('a successful child exit without the private token remains blocked', async () => {
  const fake = await executable(`
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:'fabricated'}));
console.log(JSON.stringify({type:'event',ok:true}));
`);
  const report = await runLiveHostDoctor({
    host: 'codex',
    dataDirectory: fake.root,
    executable: fake.path,
    timeoutMs: 5000,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.observedCapabilities, []);
  assert.deepEqual(report.unprovenCapabilities, HOST_CAPABILITIES);
});

test('Claude Code live doctor uses a read-only process and structured result', async () => {
  const fake = await executable(
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('--safe-mode') || !args.includes('--no-session-persistence') || args[args.indexOf('--tools') + 1] !== 'Read' || args[args.indexOf('--permission-mode') + 1] !== 'plan') process.exit(9);
const token = fs.readFileSync('challenge.txt', 'utf8').trim();
console.log(JSON.stringify({structured_output:{token}}));
`,
    '2.1.205 (Claude Code)',
  );
  const report = await runLiveHostDoctor({
    host: 'claude-code',
    dataDirectory: fake.root,
    executable: fake.path,
    timeoutMs: 5000,
  });
  assert.equal(report.status, 'OBSERVED');
  assert.deepEqual(report.observedCapabilities, ['subagents']);
  assert.equal(report.executableVersion, '2.1.205 (Claude Code)');
});

test('a mismatched host executable is refused before the model probe', async () => {
  const fake = await executable(
    `throw new Error('probe must not run');`,
    '2.1.205 (Claude Code)',
  );
  const report = await runLiveHostDoctor({
    host: 'codex',
    dataDirectory: fake.root,
    executable: fake.path,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.observedCapabilities, []);
  assert.equal(report.processEvidencePath, null);
});

test('Cursor and a missing host executable fail closed with retained reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-live-doctor-gap-'));
  for (const [host, executablePath] of [
    ['cursor', undefined],
    ['codex', join(root, 'missing-codex')],
  ] as const) {
    const report = await runLiveHostDoctor({
      host,
      dataDirectory: root,
      ...(executablePath ? { executable: executablePath } : {}),
    });
    assert.equal(report.status, 'BLOCKED');
    assert.deepEqual(report.observedCapabilities, []);
    assert.deepEqual(report.unprovenCapabilities, HOST_CAPABILITIES);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(report.runDirectory, 'doctor-report.json'), 'utf8'),
      ),
      report,
    );
  }
});
