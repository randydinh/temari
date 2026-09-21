#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { maintenanceDecision, recordMaintenanceResult } from './verification-maintenance.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const control = join(scripts, 'control-temari');
const parent = process.env.TEMARI_MAINTENANCE_TEST_ROOT || tmpdir();
mkdirSync(parent, { recursive: true });
const suite = mkdtempSync(join(parent, 'maintenance-regression-'));
const completed = new Date('2026-09-20T12:00:00.000Z');
let commandNumber = 0;

function fixture() {
  const root = mkdtempSync(join(suite, 'repo-'));
  execFileSync('git', ['init', '-q', root]);
  const proof = join(root, 'synthetic-storage-evidence.md');
  writeFileSync(proof, 'Synthetic regression fixture. Tests storage only; no maintenance skill was executed.\n');
  return {
    root, proof,
    receipt: join(root, '.temari/runs/verification-maintenance/last-success.json'),
    result: { runId: 'synthetic-run', outcome: 'clean', completedAt: completed.toISOString(), evidencePath: proof, attestCompleted: true },
  };
}

function run(args, env = {}) {
  const result = spawnSync(control, args, {
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env, TEMARI_VERIFY_RUN_ID: '', TEMARI_MAINTENANCE_REPO: '',
      TEMARI_VERIFY_ROOT: join(suite, 'unused-scratch'),
      TEMARI_VERIFY_EVIDENCE: join(suite, 'unused-evidence'), ...env,
    },
  });
  writeFileSync(join(suite, `command-${++commandNumber}.json`), JSON.stringify({ command: [control, ...args], env, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.error, undefined);
  return result;
}

test('missing, malformed, invalid, future, blocked and unknown receipts remain due', () => {
  const f = fixture();
  assert.deepEqual(maintenanceDecision(f.root, completed), {
    due: true, reason: 'missing-receipt',
    dispatch: { skillId: 'maintain-verification-skill', reason: 'missing-receipt', inputs: ['verification feature map', 'last-success receipt'] },
  });
  assert.equal(existsSync(dirname(f.receipt)), false);
  recordMaintenanceResult(f.root, f.result, completed);
  const valid = JSON.parse(readFileSync(f.receipt, 'utf8'));
  for (const bad of [null, [], {}, { ...valid, runId: '' }, { ...valid, outcome: 'unknown' },
    { ...valid, completedAt: '2026-02-30T12:00:00Z' }, { ...valid, completedAt: '2026-09-20T12:00:00+00:00' },
    { ...valid, completedAt: '2026-09-21T12:00:00.000Z' }, { ...valid, evidence: { path: f.proof, sha256: 'bad' } }]) {
    const bytes = JSON.stringify(bad);
    writeFileSync(f.receipt, bytes);
    assert.equal(maintenanceDecision(f.root, completed).reason, 'invalid-receipt');
    assert.equal(readFileSync(f.receipt, 'utf8'), bytes);
  }
  writeFileSync(f.receipt, '{broken');
  assert.equal(maintenanceDecision(f.root, completed).reason, 'invalid-receipt');
  writeFileSync(f.receipt, JSON.stringify({ ...valid, outcome: 'blocked' }));
  assert.equal(maintenanceDecision(f.root, completed).reason, 'blocked-receipt');
});

test('exactly 24 hours is due; one millisecond before is fresh', () => {
  const f = fixture();
  recordMaintenanceResult(f.root, f.result, completed);
  const boundary = completed.getTime() + 86400000;
  assert.deepEqual(maintenanceDecision(f.root, new Date(boundary - 1)), {
    due: false, reason: 'fresh-receipt', nextDueAt: '2026-09-21T12:00:00.000Z',
  });
  assert.equal(maintenanceDecision(f.root, new Date(boundary)).reason, 'stale-receipt');
  assert.equal(maintenanceDecision(f.root, new Date(boundary + 1)).reason, 'stale-receipt');
  assert.equal(maintenanceDecision(f.root, new Date(NaN)).due, true);
});

test('clean and changed preserve UTC completion time and atomically persist evidence binding', () => {
  for (const outcome of ['clean', 'changed']) {
    const f = fixture();
    const result = recordMaintenanceResult(f.root, { ...f.result, outcome, completedAt: '2026-09-20T12:00:00Z' }, new Date('2026-09-21T00:00:00Z'));
    assert.equal(result.refreshed, true);
    const stored = JSON.parse(readFileSync(f.receipt, 'utf8'));
    assert.equal(stored.outcome, outcome);
    assert.equal(stored.completedAt, completed.toISOString());
    assert.equal(stored.runId, 'synthetic-run');
    assert.equal(stored.attestation, 'caller-attested');
    assert.equal(stored.evidence.path, realpathSync(f.proof));
    assert.match(stored.evidence.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(readdirSync(dirname(f.receipt)), ['last-success.json']);
  }
});

test('identical replay preserves bytes and age; conflicting or older results are refused', () => {
  const f = fixture();
  recordMaintenanceResult(f.root, f.result, completed);
  const original = readFileSync(f.receipt, 'utf8');
  const later = new Date(completed.getTime() + 86400001);
  assert.equal(recordMaintenanceResult(f.root, f.result, later).replay, true);
  assert.equal(readFileSync(f.receipt, 'utf8'), original);
  assert.equal(maintenanceDecision(f.root, later).reason, 'stale-receipt');
  for (const change of [{ outcome: 'changed' }, { completedAt: later.toISOString() }]) {
    assert.throws(() => recordMaintenanceResult(f.root, { ...f.result, ...change }, later), /conflicting replay/);
  }
  const otherProof = join(f.root, 'other-proof.md');
  writeFileSync(otherProof, 'Different synthetic evidence.');
  assert.throws(() => recordMaintenanceResult(f.root, { ...f.result, evidencePath: otherProof }, later), /conflicting replay/);
  assert.throws(() => recordMaintenanceResult(f.root, { ...f.result, runId: 'older', completedAt: '2026-09-19T12:00:00Z' }, later), /newer/);
  assert.equal(readFileSync(f.receipt, 'utf8'), original);
  recordMaintenanceResult(f.root, { ...f.result, runId: 'newer', completedAt: later.toISOString() }, later);
  const newer = readFileSync(f.receipt, 'utf8');
  assert.throws(() => recordMaintenanceResult(f.root, f.result, later), /newer/);
  assert.equal(readFileSync(f.receipt, 'utf8'), newer);
});

test('blocked, failed, missing attestation and invalid evidence never refresh success', () => {
  for (const existing of [false, true]) {
    const f = fixture();
    if (existing) recordMaintenanceResult(f.root, f.result, completed);
    const before = existing ? readFileSync(f.receipt, 'utf8') : undefined;
    for (const outcome of ['blocked', 'failed']) {
      assert.equal(recordMaintenanceResult(f.root, { outcome }).refreshed, false);
    }
    const empty = join(f.root, 'empty.md');
    writeFileSync(empty, ' \n');
    const binary = join(f.root, 'binary');
    writeFileSync(binary, Buffer.from([255]));
    for (const change of [{ attestCompleted: false }, { outcome: 'success' }, { runId: '' },
      { evidencePath: undefined }, { evidencePath: empty }, { evidencePath: binary }, { evidencePath: f.root },
      { evidencePath: join(f.root, 'missing') }, { completedAt: 'bad' }, { completedAt: '2026-09-21T12:00:00Z' }]) {
      assert.throws(() => recordMaintenanceResult(f.root, { ...f.result, ...change }, completed));
    }
    assert.equal(existsSync(f.receipt), existing);
    if (existing) assert.equal(readFileSync(f.receipt, 'utf8'), before);
    assert.equal(maintenanceDecision(f.root, new Date(completed.getTime() + 86400001)).due, true);
  }
});

test('changed or missing evidence makes status due without losing completion ordering', () => {
  for (const missing of [false, true]) {
    const f = fixture();
    recordMaintenanceResult(f.root, f.result, completed);
    const before = readFileSync(f.receipt, 'utf8');
    if (missing) unlinkSync(f.proof);
    else writeFileSync(f.proof, 'Changed synthetic evidence.');
    assert.equal(maintenanceDecision(f.root, completed).reason, 'invalid-receipt');
    const olderProof = join(f.root, 'older-proof.md');
    writeFileSync(olderProof, 'Older synthetic evidence.');
    assert.throws(() => recordMaintenanceResult(f.root, {
      ...f.result, runId: 'older-after-evidence-loss', evidencePath: olderProof,
      completedAt: '2026-09-19T12:00:00Z',
    }, completed), /newer/);
    assert.equal(readFileSync(f.receipt, 'utf8'), before);
  }
});

test('repository binding is explicit and copied receipts cannot freshen another repository', () => {
  const f = fixture();
  const other = fixture();
  recordMaintenanceResult(f.root, f.result, completed);
  mkdirSync(dirname(other.receipt), { recursive: true });
  writeFileSync(other.receipt, readFileSync(f.receipt));
  assert.equal(maintenanceDecision(other.root, completed).reason, 'invalid-receipt');
  const subdirectory = join(f.root, 'subdirectory');
  mkdirSync(subdirectory);
  assert.throws(() => maintenanceDecision(subdirectory), /repository root/);
  assert.equal(run(['maintenance-status']).status, 2);
  assert.equal(run(['maintenance-status', '--repo', other.root]).status, 0);
  assert.equal(existsSync(join(scripts, '../.temari')), false);
});

test('fresh processes record, read and replay caller attestation without renewal', () => {
  const f = fixture();
  const timestamp = new Date(Date.now() - 2000).toISOString();
  const args = ['maintenance-record', '--repo', f.root, '--run-id', 'subprocess-fixture', '--outcome', 'changed',
    '--completed-at', timestamp, '--evidence', f.proof, '--attest-completed'];
  const written = run(args);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).operation, 'record-caller-attested-result');
  const before = readFileSync(f.receipt, 'utf8');
  const status = run(['maintenance-status', '--repo', f.root]);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).due, false);
  const replay = run(args);
  assert.equal(replay.status, 0);
  assert.equal(JSON.parse(replay.stdout).replay, true);
  assert.equal(readFileSync(f.receipt, 'utf8'), before);
  assert.equal(JSON.parse(before).completedAt, timestamp);
  assert.equal(run(['maintenance-record', '--repo', f.root, '--outcome', 'failed']).status, 0);
  assert.equal(readFileSync(f.receipt, 'utf8'), before);
});

test('a symlinked package still runs the guard before its target', () => {
  const f = fixture();
  const alias = join(f.root, 'package-link');
  symlinkSync(join(scripts, '../../..'), alias, 'dir');
  const aliasControl = join(alias, 'verification/verify-temari/scripts/control-temari');
  const result = spawnSync(aliasControl, ['drive', '--repo', f.root, '--', 'plugin-catalog'], { encoding: 'utf8', timeout: 15000 });
  writeFileSync(join(suite, 'symlink-guard.json'), JSON.stringify({ command: [aliasControl, 'drive', '--repo', f.root, '--', 'plugin-catalog'], status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No maintenance was executed/);
  assert.equal(existsSync(f.receipt), false);
});

test('real due-before-drive refusal, fresh orch init, failure propagation and cleanup preservation', () => {
  const f = fixture();
  const env = {
    TEMARI_VERIFY_ROOT: join(f.root, 'scratch'), TEMARI_VERIFY_EVIDENCE: join(f.root, 'retained'),
    TEMARI_MAINTENANCE_REPO: f.root,
  };
  const launch = run(['launch', '--run-id', 'maintenance-drive-test'], env);
  assert.equal(launch.status, 0, launch.stderr);
  const units = join(env.TEMARI_VERIFY_ROOT, 'maintenance-drive-test/store/units.tsv');
  try {
    for (const args of [['--help'], ['doctor'], ['maintenance-status']]) {
      const diagnostic = run(args, env);
      assert.equal(diagnostic.status, 0, diagnostic.stderr);
      assert.equal(existsSync(f.receipt), false);
    }
    const denied = run(['capture', 'due-init', '--', 'drive', '--', 'orch', '--', 'init'], env);
    assert.equal(denied.status, 3);
    assert.equal(existsSync(units), false);
    assert.equal(existsSync(f.receipt), false);
    const deniedProof = readFileSync(join(env.TEMARI_VERIFY_EVIDENCE, 'maintenance-drive-test/due-init.stderr.txt'), 'utf8');
    assert.match(deniedProof, /maintain-verification-skill/);
    assert.match(deniedProof, /No maintenance was executed/);
    const write = run(['maintenance-record', '--run-id', 'drive-fixture', '--outcome', 'clean',
      '--completed-at', new Date(Date.now() - 1000).toISOString(), '--evidence', f.proof, '--attest-completed'], env);
    assert.equal(write.status, 0, write.stderr);
    const before = readFileSync(f.receipt, 'utf8');
    const driven = run(['drive', '--', 'orch', '--', 'init'], env);
    assert.equal(driven.status, 0, driven.stderr);
    assert.match(driven.stdout, /initialized/);
    assert.match(readFileSync(units, 'utf8'), /^id\ttrack\tstate\tbranch\tpr\tsha\tbrief/);
    const rawFailure = run(['orch', '--', 'nonexistent-maintenance-test-command'], env);
    const guardedFailure = run(['drive', '--', 'orch', '--', 'nonexistent-maintenance-test-command'], env);
    assert.notEqual(rawFailure.status, 0);
    assert.equal(guardedFailure.status, rawFailure.status);
    assert.equal(guardedFailure.stderr, rawFailure.stderr);
    const status = run(['drive', '--', 'orch', '--', 'status'], env);
    assert.equal(status.status, 0);
    assert.equal(readFileSync(f.receipt, 'utf8'), before);
    assert.equal(run(['snapshot', 'after-drive'], env).status, 0);
  } finally {
    assert.equal(run(['cleanup'], env).status, 0);
  }
  assert.equal(existsSync(units), false);
  assert.equal(existsSync(f.receipt), true);
  assert.equal(existsSync(join(env.TEMARI_VERIFY_EVIDENCE, 'maintenance-drive-test/after-drive/units.tsv')), true);
});

console.log(`Synthetic storage/entrypoint evidence retained at ${suite}; no full maintenance execution claimed.`);
