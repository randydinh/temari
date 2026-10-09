import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classifyCodexParallelRequest,
  runCodexParallelRequest,
} from './run-codex-parallel.mjs';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'temari-route-'));
  const repo = join(root, 'repo');
  git(root, 'init', '-q', repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@localhost');
  await writeFile(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'base');
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const mode = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: (\\S+)/)?.[1] ?? 'unknown';
  if (mode === 'read-only') fs.writeFileSync('started-' + id, mode);
  if (mode === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
  fs.writeFileSync(final, JSON.stringify({status:id === 'issues' ? 'ISSUES' : 'PASS',summary:id}));
  console.log(JSON.stringify({id}));
});
`,
  );
  await chmod(executable, 0o755);
  return { root, repo, executable, baseCommit: git(repo, 'rev-parse', 'HEAD') };
}
function brief(id: string) {
  return {
    goal: id,
    context: 'test',
    scope: id,
    acceptanceCriteria: ['produce result'],
    verificationCommand: null,
    reportFormat: 'json' as const,
    forbiddenActions: ['stay in scope'],
  };
}
function readAssignment(id: string) {
  return { id, role: 'investigator', required: true, brief: brief(id) };
}
function writeAssignment(id: string) {
  return {
    worker: { id, role: 'implementer', required: true, brief: brief(id) },
    owns: [{ kind: 'file', path: `${id}.txt` }],
  };
}
function readRequest(f: Awaited<ReturnType<typeof fixture>>, id = 'report') {
  return {
    runId: `read-${id}`,
    revision: 'revision-1',
    workspaceRoot: f.repo,
    evidenceRoot: join(f.root, 'evidence'),
    maxConcurrency: 2,
    executable: f.executable,
    timeoutMs: 2000,
    assignments: [readAssignment(id)],
  };
}
function writeRequest(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    runId: 'write-run',
    sourceRepo: f.repo,
    baseCommit: f.baseCommit,
    evidenceRoot: join(f.root, 'evidence'),
    maxConcurrency: 2,
    executable: f.executable,
    timeoutMs: 2000,
    verify: [{ program: process.execPath, args: ['-e', 'process.exit(0)'] }],
    assignments: [writeAssignment('alpha'), writeAssignment('beta')],
  };
}

test('routes read-only reports from assignment roles and returns its receipt', async () => {
  const f = await fixture();
  const request = readRequest(f);
  assert.equal(classifyCodexParallelRequest(request), 'read-only');
  const result = await runCodexParallelRequest(request);
  assert.equal(result.route, 'read-only');
  assert.equal(result.status, 'PASS');
  assert.equal(
    await readFile(join(f.repo, 'started-report'), 'utf8'),
    'read-only',
  );
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, 'utf8')).status,
    'PASS',
  );
});

test('routes implementers to isolated write runner and returns integration receipt', async () => {
  const f = await fixture();
  const result = await runCodexParallelRequest(writeRequest(f));
  assert.equal(result.route, 'write');
  assert.equal(result.status, 'PASS');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, 'utf8')).status,
    'PASS',
  );
  if (result.route !== 'write') throw new Error('expected write route');
  assert.equal(
    git(result.integrationPath, 'rev-parse', 'HEAD'),
    result.integratedCommit,
  );
  assert.equal(
    await readFile(join(result.integrationPath, 'alpha.txt'), 'utf8'),
    'alpha\n',
  );
  assert.equal(
    await readFile(join(result.integrationPath, 'beta.txt'), 'utf8'),
    'beta\n',
  );
});

test('rejects mixed and ambiguous batches before starting a process', async () => {
  const f = await fixture();
  for (const assignments of [
    [readAssignment('report'), writeAssignment('alpha')],
    [
      {
        id: 'unknown',
        role: 'implementer',
        required: true,
        brief: brief('unknown'),
      },
    ],
    [],
  ]) {
    await assert.rejects(
      () => runCodexParallelRequest({ ...readRequest(f), assignments }),
      /Mixed or ambiguous|nonempty assignments/,
    );
  }
  await assert.rejects(() => stat(join(f.repo, 'started-report')));
  await assert.rejects(() => stat(join(f.root, 'evidence')));
});

test('rejects mode labels on both request shapes before process or evidence', async () => {
  const f = await fixture();
  await assert.rejects(
    () => runCodexParallelRequest({ ...readRequest(f), mode: 'write' }),
    /mode is unsupported/,
  );
  await assert.rejects(
    () => runCodexParallelRequest({ ...writeRequest(f), mode: 'read-only' }),
    /mode is unsupported/,
  );
  await assert.rejects(() => stat(join(f.repo, 'started-report')));
  await assert.rejects(() => stat(join(f.root, 'evidence')));
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('malformed request is rejected by existing parser before launch', async () => {
  const f = await fixture();
  await assert.rejects(
    () => runCodexParallelRequest({ ...readRequest(f), timeoutMs: -1 }),
    /timeoutMs/,
  );
  await assert.rejects(() => stat(join(f.repo, 'started-report')));
});

test('non-PASS status and receipt are propagated', async () => {
  const f = await fixture();
  const result = await runCodexParallelRequest(readRequest(f, 'issues'));
  assert.equal(result.route, 'read-only');
  assert.equal(result.status, 'ISSUES');
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, 'utf8')).status,
    'ISSUES',
  );
});

test('CLI prints selected route and receipt, and exits nonzero for issues', async () => {
  const f = await fixture();
  const requestPath = join(f.root, 'request.json');
  await writeFile(requestPath, JSON.stringify(readRequest(f, 'issues')));
  let output = '';
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        'tools/run-codex-parallel.mts',
        requestPath,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.fail('issues should make the CLI exit nonzero');
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    assert.equal(failure.status, 1);
    output = failure.stdout ?? '';
  }
  const result = JSON.parse(output);
  assert.equal(result.route, 'read-only');
  assert.equal(result.status, 'ISSUES');
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, 'utf8')).status,
    'ISSUES',
  );
});

test('write routing preserves a locally available pinned read-only dependency', async () => {
  const f = await fixture();
  const dependency = join(f.root, 'dependency');
  git(f.root, 'clone', '-q', '--no-hardlinks', f.repo, dependency);
  git(
    f.repo,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    dependency,
    'dependencies/library',
  );
  git(f.repo, 'commit', '-qam', 'pin');
  const result = await runCodexParallelRequest({
    ...writeRequest(f),
    baseCommit: git(f.repo, 'rev-parse', 'HEAD'),
  });
  assert.equal(result.route, 'write');
  assert.equal(result.status, 'PASS');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(
    receipt.dependencies.dependencies[0].path,
    'dependencies/library',
  );
  assert.equal(
    await readFile(
      join(receipt.integrationPath, 'dependencies/library/README.md'),
      'utf8',
    ),
    'base\n',
  );
});
