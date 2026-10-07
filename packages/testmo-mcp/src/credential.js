import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadWindowsToken() {
  if (process.env.TESTMO_TOKEN !== undefined || process.platform !== 'win32')
    return;
  const path = join(homedir(), '.temari', 'testmo-mcp', 'token.dpapi');
  if (!existsSync(path)) return;
  process.env.TESTMO_TOKEN = readWindowsToken(path);
}
export function readWindowsToken(path) {
  try {
    // Capture the decrypted value privately; never inherit this child's stdout/stderr.
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('../scripts/read-token.ps1', import.meta.url)),
        '-TokenPath',
        path,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    throw new Error(
      'Unable to decrypt the Testmo token for this Windows user. Save it again using save-token.ps1.',
    );
  }
}
