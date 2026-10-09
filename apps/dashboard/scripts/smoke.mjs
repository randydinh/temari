import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'temari-dashboard-artifact-'));
const root = join(temporary, 'tasks');
const executable = new URL('../dist/main.mjs', import.meta.url);
const input = join(temporary, 'create.json');
let server;

try {
  await writeFile(
    input,
    JSON.stringify({
      taskId: 'artifact-smoke',
      title: 'Artifact smoke',
      goal: 'Prove the packaged dashboard serves its UI.',
      workspaceRoot: process.cwd(),
      actor: 'release-smoke',
      idempotencyKey: 'create-artifact-smoke',
    }),
  );
  await run(process.execPath, [executable.pathname, 'create', '--root', root, '--input', input]);

  server = spawn(
    process.execPath,
    [executable.pathname, 'serve', '--root', root, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const started = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`Dashboard artifact did not start. ${stderr}`)),
      10_000,
    );
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stderr.on('data', (chunk) => (stderr += chunk));
    server.stdout.on('data', (chunk) => {
      stdout += chunk;
      try {
        const value = JSON.parse(stdout);
        clearTimeout(timer);
        resolve(value);
      } catch {
        // The CLI prints formatted JSON, so wait for the complete object.
      }
    });
    server.once('error', reject);
    server.once('exit', (code) =>
      reject(new Error(`Dashboard artifact exited before startup (${code}). ${stderr}`)),
    );
  });
  assert.equal(started.mode, 'read-only');
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(started.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Temari · Tasks<\/title>/);
  const response = await fetch(`${started.url}/api/tasks`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].taskId, 'artifact-smoke');
  console.log(`Dashboard artifact smoke passed at ${started.url}.`);
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
