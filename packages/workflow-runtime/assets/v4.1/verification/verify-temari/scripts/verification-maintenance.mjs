#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const CADENCE_MS = 24 * 60 * 60 * 1000;
const SKILL = 'maintain-verification-skill';
const SUCCESS = new Set(['clean', 'changed']);

function repository(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('set --repo or TEMARI_MAINTENANCE_REPO to the owning repository root');
  const root = realpathSync(path);
  const gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (realpathSync(gitRoot) !== root) throw new Error('--repo must name the owning repository root, not a subdirectory');
  return root;
}

function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) throw new Error('completion time must be a UTC ISO timestamp');
  const time = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) throw new Error('invalid completion time');
  return time;
}

function evidence(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('retained evidence is required');
  const file = realpathSync(path);
  if (!statSync(file).isFile()) throw new Error('evidence must be a regular file');
  const bytes = readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim()) throw new Error('evidence must contain retained run notes or a transcript');
  return { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function receiptPath(root) {
  return join(root, '.temari/runs/verification-maintenance/last-success.json');
}

function readReceipt(root) {
  try {
    return { value: JSON.parse(readFileSync(receiptPath(root), 'utf8')) };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing-receipt' : 'invalid-receipt' };
  }
}

function validReceiptMetadata(value, root) {
  try {
    if (!value || value.version !== 1 || value.repositoryRoot !== root || value.skillId !== SKILL ||
        value.attestation !== 'caller-attested' || typeof value.runId !== 'string' || !value.runId.trim() ||
        !SUCCESS.has(value.outcome)) return false;
    utc(value.completedAt);
    return typeof value.evidence?.path === 'string' && isAbsolute(value.evidence.path) &&
      typeof value.evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.evidence.sha256);
  } catch {
    return false;
  }
}

function validReceipt(value, root) {
  if (!validReceiptMetadata(value, root)) return false;
  try {
    const retained = evidence(value.evidence?.path);
    return retained.path === value.evidence.path && retained.sha256 === value.evidence.sha256;
  } catch {
    return false;
  }
}

function due(reason) {
  return {
    due: true, reason,
    dispatch: { skillId: SKILL, reason, inputs: ['verification feature map', 'last-success receipt'] },
  };
}

export function maintenanceDecision(repositoryRoot, now = new Date()) {
  const root = repository(repositoryRoot);
  const loaded = readReceipt(root);
  if (loaded.error) return due(loaded.error);
  if (loaded.value?.outcome === 'blocked') return due('blocked-receipt');
  if (!validReceipt(loaded.value, root)) return due('invalid-receipt');
  const completed = utc(loaded.value.completedAt);
  if (!Number.isFinite(now.getTime()) || completed > now.getTime()) return due('invalid-receipt');
  if (now.getTime() - completed >= CADENCE_MS) return due('stale-receipt');
  return { due: false, reason: 'fresh-receipt', nextDueAt: new Date(completed + CADENCE_MS).toISOString() };
}

export function recordMaintenanceResult(repositoryRoot, result, now = new Date()) {
  const root = repository(repositoryRoot);
  if (result?.outcome === 'blocked' || result?.outcome === 'failed') {
    return { refreshed: false, outcome: result.outcome, attestation: 'caller-attested' };
  }
  if (!SUCCESS.has(result?.outcome) || result.attestCompleted !== true ||
      typeof result.runId !== 'string' || !result.runId.trim()) {
    throw new Error('clean/changed recording requires a run ID and explicit --attest-completed');
  }
  const completed = utc(result.completedAt);
  if (!Number.isFinite(now.getTime()) || completed > now.getTime()) throw new Error('completion time cannot be in the future');
  const receipt = {
    version: 1, repositoryRoot: root, skillId: SKILL, runId: result.runId,
    completedAt: new Date(completed).toISOString(), outcome: result.outcome,
    attestation: 'caller-attested', evidence: evidence(result.evidencePath),
  };
  const previous = readReceipt(root);
  if (!previous.error && previous.value?.runId === receipt.runId) {
    const same = validReceiptMetadata(previous.value, root) &&
      previous.value.outcome === receipt.outcome && utc(previous.value.completedAt) === completed &&
      previous.value.evidence.path === receipt.evidence.path && previous.value.evidence.sha256 === receipt.evidence.sha256;
    if (same) {
      return { refreshed: false, replay: true, receipt: previous.value };
    }
    throw new Error('conflicting replay of the last successful run ID');
  }
  if (!previous.error && validReceiptMetadata(previous.value, root) && utc(previous.value.completedAt) >= completed) {
    throw new Error('completion must be newer than the retained success');
  }
  const target = receiptPath(root);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { refreshed: true, receipt };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' }, 'run-id': { type: 'string' }, outcome: { type: 'string' },
      'completed-at': { type: 'string' }, evidence: { type: 'string' }, 'attest-completed': { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !['status', 'guard', 'record'].includes(command)) {
    throw new Error('use status, guard, or record with --repo ROOT');
  }
  const root = values.repo ?? process.env.TEMARI_MAINTENANCE_REPO;
  if (command === 'record') {
    const result = recordMaintenanceResult(root, {
      runId: values['run-id'], outcome: values.outcome, completedAt: values['completed-at'],
      evidencePath: values.evidence, attestCompleted: values['attest-completed'],
    });
    console.log(JSON.stringify({ operation: 'record-caller-attested-result', ...result }, null, 2));
    return;
  }
  if (Object.keys(values).some((key) => key !== 'repo')) throw new Error('status and guard accept only --repo');
  const decision = maintenanceDecision(root);
  if (command === 'status') console.log(JSON.stringify(decision, null, 2));
  if (command === 'guard' && decision.due) {
    console.error(JSON.stringify({ status: 'blocked', ...decision }, null, 2));
    console.error('No maintenance was executed. The Temari host coordinator must load maintain-verification-skill, complete its source/live pass using raw controls, record its caller-attested result, then retry drive. Automatic host dispatch is not implemented.');
    process.exitCode = 3;
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 2; }
}
