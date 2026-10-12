import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCredentials } from './hosts.mjs';

export async function launch({ home, node, dashboard, args = [], env = process.env, stdio = 'inherit', signal }) {
  assert(isAbsolute(home ?? '') && isAbsolute(node ?? '') && isAbsolute(dashboard ?? ''), 'Launcher paths must be absolute.');
  const credentials = await readCredentials({ home });
  const receipt = JSON.parse(await readFile(join(home, 'setup.json'), 'utf8'));
  const installation = await realpath(receipt.installation);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = await readFile(join(installation, 'UNIFIED.json'));
  assert.equal(sha(manifestBytes), receipt.releaseSha256, 'Installed launcher manifest identity changed.');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(node, join(installation, manifest.assets.node.executable), 'Launcher must select the managed Node executable.');
  for (const path of [node, dashboard]) {
    const selected = await realpath(path), child = relative(installation, selected);
    assert(child && !child.startsWith('..') && !isAbsolute(child), 'Launcher executable must belong to the selected installation.');
    const record = manifest.files.find((file) => file.path === child);
    assert(record?.kind === 'file' && sha(await readFile(selected)) === record.sha256, 'Installed launcher executable identity changed.');
  }
  assert(dashboard === join(installation, 'dashboard', 'main.mjs'), 'Launcher must select the installed dashboard.');
  const selectedEnv = { ...env, ...credentials, PATH: `${dirname(node)}:${env.PATH ?? '/usr/bin:/bin'}`, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', ...(manifest.providers?.['claude-code'] ? { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' } : {}) };
  if (signal?.aborted) return { exitCode: 130, signal: 'SIGINT' };
  return await new Promise((done) => {
    const child = spawn(node, [dashboard, ...args, '--home', join(home, 'dashboard')], { env: selectedEnv, stdio, signal });
    const forward = (name) => () => { try { child.kill(name); } catch { /* Already exited. */ } };
    const interrupt = forward('SIGINT'), terminate = forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const finish = (result) => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); done(result); };
    child.once('error', () => finish({ exitCode: signal?.aborted ? 130 : 1, signal: signal?.aborted ? 'SIGINT' : null }));
    child.once('close', (code, nativeSignal) => finish({ exitCode: code ?? (nativeSignal === 'SIGINT' ? 130 : nativeSignal === 'SIGTERM' ? 143 : 1), signal: nativeSignal }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const boundary = process.argv.indexOf('--', 2);
    const options = parseArgs({ args: process.argv.slice(2, boundary === -1 ? undefined : boundary), options: { home: { type: 'string' }, node: { type: 'string' }, dashboard: { type: 'string' } }, strict: true });
    const result = await launch({ ...options.values, args: boundary === -1 ? [] : process.argv.slice(boundary + 1) });
    process.exitCode = result.exitCode;
  } catch { console.error('Temari could not start. Check installation ownership, credential permissions, and setup readiness.'); process.exitCode = 1; }
}
