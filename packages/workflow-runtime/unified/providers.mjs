import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { digest, inside } from './inventory.mjs';

const executeNative = promisify(execFile);
export const managedProviderEnvironment = Object.freeze({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
/** Select a bundled immutable executable before authentication. No download, home adoption, or global install. */
export async function installManagedProvider({ root, manifest, kind, platformKey = process.platform + '-' + process.arch, execute = executeNative, env = process.env }) {
  assert(['codex', 'claude-code'].includes(kind), 'Select Codex or Claude Code.');
  assert(isAbsolute(root ?? '') && root === await realpath(root) && !(await lstat(root)).isSymbolicLink(), 'Managed provider root must be canonical.');
  assert(manifest?.providers?.platform === platformKey && manifest.assets?.platform === platformKey, 'Managed provider platform differs from this host.');
  const provider = manifest.providers[kind], prefix = `runtime/providers/${kind}/`;
  assert(provider && /^\d+\.\d+\.\d+$/u.test(provider.version), 'Managed provider is unavailable.');
  assert(typeof provider.executable === 'string' && provider.executable.startsWith(prefix) && provider.executable.split('/').every(part => /^[A-Za-z0-9._-]+$/u.test(part) && !['.', '..'].includes(part)), 'Unsafe managed provider executable.');
  assert(/^[a-f0-9]{64}$/u.test(provider.executableSha256), 'Invalid managed provider digest.');
  const location = join(root, provider.executable), record = manifest.files?.find(item => item.path === provider.executable);
  assert(record?.kind === 'file' && record.executable && record.sha256 === provider.executableSha256 && record.bytes === provider.executableSize, 'Managed provider executable is not inventoried.');
  assert(inside(root, location) && location === await realpath(location), 'Managed provider path drift.');
  const stat = await lstat(location);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === record.bytes, 'Invalid managed provider file.');
  await access(location, constants.X_OK);
  assert(digest(await readFile(location)) === record.sha256, 'Managed provider executable changed.');
  const environment = kind === 'claude-code' ? { ...managedProviderEnvironment } : {};
  let observation;
  try { observation = await execute(location, ['--version'], { cwd: root, env: { ...env, ...environment }, timeout: 15000, maxBuffer: 65536 }); }
  catch { throw new Error('The bundled provider cannot run on this machine. Check the supported operating system and CPU requirements.'); }
  const observed = `${observation.stdout ?? ''}\n${observation.stderr ?? ''}`.trim();
  const version = kind === 'codex' ? observed.match(/(?:^|\n)codex-cli (\d+\.\d+\.\d+)(?:\n|$)/u)?.[1] : observed.match(/(?:^|\n)(\d+\.\d+\.\d+) \(Claude Code\)(?:\n|$)/u)?.[1];
  assert(version === provider.version, 'Bundled provider version differs from its pinned release.');
  assert(location === await realpath(location) && digest(await readFile(location)) === record.sha256, 'Managed provider changed during inspection.');
  return { kind, managed: true, version, executable: location, executableSha256: record.sha256, environment };
}
