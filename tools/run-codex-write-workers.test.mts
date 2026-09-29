import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runCodexWriteWorkersRequest,
  type WriteRunRequest,
} from './run-codex-write-workers.mjs';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function fixture(): Promise<{
  root: string;
  repo: string;
  executable: string;
  baseCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'temari-write-'));
  const repo = join(root, 'repo');
  git(root, 'init', '-q', repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@localhost');
  await writeFile(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
if (args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(8);
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: (\\S+)/)?.[1] ?? 'unknown';
  const file = id === 'rogue' ? 'shared.txt' : id + '.txt';
  setTimeout(() => {
    if (id === 'rename') { fs.renameSync('README.md','renamed.md'); require('node:child_process').execFileSync('git',['add','-A']); }
    else fs.writeFileSync(file, id + '\\n');
    fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id+' done'}));
    console.log(JSON.stringify({id}));
  }, id === 'slow' ? 1000 : id === 'alpha' ? 280 : 100);
});
`,
  );
  await chmod(executable, 0o755);
  return { root, repo, executable, baseCommit };
}
function assignment(id: string, required = true) {
  return {
    worker: {
      id,
      role: 'implementer' as const,
      required,
      brief: {
        goal: id,
        context: 'test',
        scope: id,
        acceptanceCriteria: ['write one file'],
        verificationCommand: null,
        reportFormat: 'json' as const,
        forbiddenActions: ['do not touch other paths'],
      },
    },
    owns: [{ kind: 'file' as const, path: `${id}.txt` }],
  };
}
function request(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
  ids = ['alpha', 'beta'],
): WriteRunRequest {
  return {
    runId,
    sourceRepo: f.repo,
    baseCommit: f.baseCommit,
    evidenceRoot: join(f.root, 'evidence'),
    maxConcurrency: 2,
    executable: f.executable,
    timeoutMs: 2000,
    assignments: ids.map((id) => assignment(id)),
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          `const fs=require('fs');if(!fs.existsSync('alpha.txt'))process.exit(5)`,
        ],
      },
    ],
  };
}

test('disjoint write workers overlap in separate clones and join into one verified commit', async () => {
  const f = await fixture();
  const result = await runCodexWriteWorkersRequest(request(f, 'integrate'));
  assert.equal(result.status, 'PASS');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(
    git(result.integrationPath, 'rev-parse', 'HEAD'),
    result.integratedCommit,
  );
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD^'), f.baseCommit);
  assert.equal(
    await readFile(join(result.integrationPath, 'alpha.txt'), 'utf8'),
    'alpha\n',
  );
  assert.equal(
    await readFile(join(result.integrationPath, 'beta.txt'), 'utf8'),
    'beta\n',
  );
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.workerReceipt.peakConcurrency, 2);
  assert.deepEqual(
    receipt.patches.map(
      (patch: { assignmentId: string }) => patch.assignmentId,
    ),
    ['alpha', 'beta'],
  );
  assert.equal(receipt.verification[0].code, 0);
  const workerPaths = ['alpha', 'beta'].map((id) =>
    join(f.root, 'evidence', 'integrate', `evidence-${id}`, 'process.json'),
  );
  const processes = await Promise.all(
    workerPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  );
  assert.notEqual(processes[0].pid, processes[1].pid);
  assert(
    Date.parse(processes[0].startedAt) < Date.parse(processes[1].endedAt) &&
      Date.parse(processes[1].startedAt) < Date.parse(processes[0].endedAt),
  );
  assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
});

test('out-of-scope worker change cannot produce integration commit', async () => {
  const f = await fixture();
  const result = await runCodexWriteWorkersRequest(
    request(f, 'rogue', ['rogue']),
  );
  assert.equal(result.status, 'ISSUES');
  assert.equal(result.integratedCommit, null);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(
    receipt.workerReceipt.outcomes[0].result.summary,
    /Out-of-scope change/,
  );
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('both endpoints of a staged rename must be owned', async () => {
  const f = await fixture();
  const input = {
    ...request(f, 'rename', ['rename']),
    assignments: [
      {
        ...assignment('rename'),
        owns: [{ kind: 'file' as const, path: 'renamed.md' }],
      },
    ],
  };
  const result = await runCodexWriteWorkersRequest(input);
  assert.equal(result.status, 'ISSUES');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(
    receipt.workerReceipt.outcomes[0].result.summary,
    /Out-of-scope change: README.md/,
  );
  assert.equal(result.integratedCommit, null);
});

test('optional worker failure degrades while required patch still integrates', async () => {
  const f = await fixture();
  const input = {
    ...request(f, 'optional'),
    assignments: [assignment('alpha'), assignment('rogue', false)],
  };
  const result = await runCodexWriteWorkersRequest(input);
  assert.equal(result.status, 'PASS');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.workerReceipt.degradations[0].workerId, 'rogue');
  assert.deepEqual(
    receipt.patches.map(
      (patch: { assignmentId: string }) => patch.assignmentId,
    ),
    ['alpha'],
  );
  assert.equal(
    await readFile(join(result.integrationPath, 'alpha.txt'), 'utf8'),
    'alpha\n',
  );
});

test('tampered patch evidence cannot be applied during integration', async () => {
  const f = await fixture();
  const running = runCodexWriteWorkersRequest(
    request(f, 'patch-tamper', ['alpha', 'slow']),
  );
  const patchPath = join(
    f.root,
    'evidence',
    'patch-tamper',
    'evidence-alpha',
    'patch.diff',
  );
  const started = Date.now();
  while (true) {
    try {
      await stat(patchPath);
      break;
    } catch {
      if (Date.now() - started > 5000) throw new Error('patch was not written');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await writeFile(patchPath, 'corrupted patch');
  const result = await running;
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.integratedCommit, null);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(receipt.reason, /Patch digest changed/);
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('dirty and moved base are rejected before any worker starts', async () => {
  const f = await fixture();
  await writeFile(join(f.repo, 'dirty.txt'), 'dirty');
  await assert.rejects(
    () => runCodexWriteWorkersRequest(request(f, 'dirty')),
    /clean/,
  );
  await assert.rejects(() => stat(join(f.root, 'evidence', 'dirty')));
  git(f.repo, 'add', 'dirty.txt');
  git(f.repo, 'commit', '-qm', 'move');
  await assert.rejects(
    () => runCodexWriteWorkersRequest(request(f, 'moved')),
    /HEAD does not match/,
  );
});

test('untracked worker file is captured in its patch', async () => {
  const f = await fixture();
  const result = await runCodexWriteWorkersRequest(
    request(f, 'untracked', ['alpha']),
  );
  assert.equal(result.status, 'PASS');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.deepEqual(receipt.patches[0].changedPaths, ['alpha.txt']);
  assert.match(
    await readFile(receipt.patches[0].patchPath, 'utf8'),
    /new file mode/,
  );
});

test('failed integration verification retains checkout and never reports PASS', async () => {
  const f = await fixture();
  const input = {
    ...request(f, 'verify-fail', ['alpha']),
    verify: [{ program: process.execPath, args: ['-e', 'process.exit(9)'] }],
  };
  const result = await runCodexWriteWorkersRequest(input);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.integratedCommit, null);
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD'), f.baseCommit);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.verification[0].code, 9);
  assert.match(receipt.reason, /Verification command 0 failed/);
});

test('verification cannot alter and re-stage a candidate file', async () => {
  const f = await fixture();
  const code =
    "const fs=require('fs');const cp=require('child_process');fs.writeFileSync('alpha.txt','tampered\\n');cp.execFileSync('git',['add','alpha.txt']);";
  const input = {
    ...request(f, 'verify-tamper', ['alpha']),
    verify: [{ program: process.execPath, args: ['-e', code] }],
  };
  const result = await runCodexWriteWorkersRequest(input);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.integratedCommit, null);
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD'), f.baseCommit);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(receipt.reason, /Verification changed the candidate/);
});

test('preparation may not move HEAD even when it leaves a clean checkout', async () => {
  const f = await fixture();
  const input = {
    ...request(f, 'prepare-move', ['alpha']),
    prepare: [
      {
        program: 'git',
        args: [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@localhost',
          'commit',
          '--allow-empty',
          '-qm',
          'moved',
        ],
      },
    ],
  };
  const result = await runCodexWriteWorkersRequest(input);
  assert.equal(result.status, 'BLOCKED');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(receipt.reason, /Preparation moved HEAD/);
  assert.equal(receipt.workerReceipt, null);
});

test('abort during verification leaves no integration commit', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const verify = [
    {
      program: process.execPath,
      args: [
        '-e',
        "require('fs').writeFileSync('verify-started','yes');setTimeout(()=>{},30000)",
      ],
    },
  ];
  const running = runCodexWriteWorkersRequest(
    { ...request(f, 'verify-abort', ['alpha']), verify },
    controller.signal,
  );
  const marker = join(
    f.root,
    'evidence',
    'verify-abort',
    'integration',
    'verify-started',
  );
  const started = Date.now();
  while (true) {
    try {
      await stat(marker);
      break;
    } catch {
      if (Date.now() - started > 5000) {
        controller.abort();
        throw new Error('verification did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  controller.abort('test');
  const result = await running;
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.integratedCommit, null);
  assert.equal(git(result.integrationPath, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('nested source checkout and inherited Git routing are handled before launch', async () => {
  const f = await fixture();
  const nested = join(f.repo, 'nested');
  await mkdir(nested);
  await assert.rejects(
    () =>
      runCodexWriteWorkersRequest({
        ...request(f, 'nested'),
        sourceRepo: nested,
      }),
    /Git top-level/,
  );
  await assert.rejects(() => stat(join(f.root, 'evidence', 'nested')));
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, 'nonexistent-git-dir');
  try {
    const result = await runCodexWriteWorkersRequest(
      request(f, 'git-env', ['alpha']),
    );
    assert.equal(result.status, 'PASS');
  } finally {
    if (old === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = old;
  }
});

test('public write CLI isolates inherited Git routing variables at startup', async () => {
  const f = await fixture();
  const inputPath = join(f.root, 'write-request.json');
  await writeFile(
    inputPath,
    JSON.stringify(request(f, 'public-write', ['alpha'])),
  );
  const project = fileURLToPath(new URL('..', import.meta.url));
  const output = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        join(project, 'tools', 'run-codex-write-workers.mts'),
        inputPath,
      ],
      {
        cwd: project,
        shell: false,
        env: { ...process.env, GIT_DIR: join(f.root, 'nonexistent-git-dir') },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 'PASS');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('overlapping ownership and evidence inside source reject before work', async () => {
  const f = await fixture();
  const overlapping = {
    ...request(f, 'overlap'),
    assignments: [
      assignment('alpha'),
      {
        ...assignment('beta'),
        owns: [{ kind: 'directory' as const, path: 'alpha.txt' }],
      },
    ],
  };
  await assert.rejects(
    () => runCodexWriteWorkersRequest(overlapping),
    /overlap/,
  );
  const internal = {
    ...request(f, 'internal'),
    evidenceRoot: join(f.repo, 'private-evidence'),
  };
  await assert.rejects(() => runCodexWriteWorkersRequest(internal), /external/);
  await assert.rejects(() => stat(join(f.repo, 'private-evidence')));
});
