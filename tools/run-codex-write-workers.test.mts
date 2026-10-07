import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
  open,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runCodexWriteWorkersRequest,
  verificationEvidencePaths,
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
    if(id.startsWith('large-')){ const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));}; Promise.all([emit(process.stdout,97,'PRIVATE_STDOUT_SENTINEL:'),emit(process.stderr,122,'PRIVATE_STDERR_SENTINEL:')]).then(()=>process.exit(id==='large-exit'?7:0)); }else console.log(JSON.stringify({id}));
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
    timeoutMs: 10_000,
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
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(
    result.status,
    'PASS',
    JSON.stringify({ reason: receipt.reason, receiptPath: result.receiptPath }),
  );
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

const diagnosticStdoutPrefix = 'PRIVATE_STDOUT_SENTINEL:';
const diagnosticStderrPrefix = 'PRIVATE_STDERR_SENTINEL:';
function diagnosticHash(prefix: string, value: number): string {
  const hashing = createHash('sha256').update(prefix);
  const chunk = Buffer.alloc(65_536, value);
  for (let index = 0; index < 256; index++) hashing.update(chunk);
  return hashing.update('!').digest('hex');
}
async function actualDiagnosticHash(path: string): Promise<string> {
  const hashing = createHash('sha256');
  const file = await open(path, 'r');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hashing.update(chunk);
  } finally {
    await file.close();
  }
  return hashing.digest('hex');
}
async function assertLargeDiagnostic(
  path: string,
  stderr = false,
): Promise<void> {
  const prefix = stderr ? diagnosticStderrPrefix : diagnosticStdoutPrefix;
  assert.equal((await stat(path)).size, 16_777_217 + Buffer.byteLength(prefix));
  assert.equal(
    await actualDiagnosticHash(path),
    diagnosticHash(prefix, stderr ? 122 : 97),
  );
}

test('write worker runner retains full large pipes on normal and nonzero worker exits', async (t) => {
  for (const failed of [false, true])
    await t.test(failed ? 'nonzero' : 'normal', async () => {
      const f = await fixture();
      try {
        const goal = failed ? 'large-exit' : 'large-pass';
        const result = await runCodexWriteWorkersRequest({
          ...request(f, 'large', [goal]),
          verify: [
            { program: process.execPath, args: ['-e', 'process.exit(0)'] },
          ],
          finalResponseLimitBytes: 1024,
        });
        assert.equal(result.status, failed ? 'BLOCKED' : 'PASS');
        const directory = join(f.root, 'evidence', 'large', `evidence-${goal}`);
        await assertLargeDiagnostic(join(directory, 'stdout.jsonl'));
        await assertLargeDiagnostic(join(directory, 'stderr.log'), true);
        assert(
          !(await readFile(result.receiptPath, 'utf8')).includes('PRIVATE_STD'),
        );
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
});

test('write verification streams exact full transcripts beyond 16 MiB for normal and nonzero exits', async (t) => {
  for (const code of [0, 7])
    await t.test(`exit ${code}`, async () => {
      const f = await fixture();
      try {
        const emitter =
          "const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));};";
        const program =
          emitter +
          `Promise.all([emit(process.stdout,97,'PRIVATE_STDOUT_SENTINEL:'),emit(process.stderr,122,'PRIVATE_STDERR_SENTINEL:')]).then(()=>process.exit(${code}));`;
        const result = await runCodexWriteWorkersRequest({
          ...request(f, 'large-verify'),
          verify: [{ program: process.execPath, args: ['-e', program] }],
        });
        assert.equal(result.status, code === 0 ? 'PASS' : 'BLOCKED');
        const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
        const path = receipt.verification[0].logPath;
        assert.equal(receipt.verification[0].code, code);
        const hashing = createHash('sha256').update(diagnosticStdoutPrefix);
        for (let n = 0; n < 256; n++) hashing.update(Buffer.alloc(65536, 97));
        hashing.update('!\n--- stderr ---\n').update(diagnosticStderrPrefix);
        for (let n = 0; n < 256; n++) hashing.update(Buffer.alloc(65536, 122));
        hashing.update('!');
        assert.equal(await actualDiagnosticHash(path), hashing.digest('hex'));
        assert.equal(
          (await stat(path)).size,
          2 * 16_777_217 +
            Buffer.byteLength(
              diagnosticStdoutPrefix +
                diagnosticStderrPrefix +
                '\n--- stderr ---\n',
            ),
        );
        assert(!String(receipt.reason).includes('PRIVATE_STD'));
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
});

test('transcript write failure preserves typed raw pipes and the full private assembly cause', async (t) => {
  const f = await fixture(),
    cause =
      'PRIVATE_TRANSCRIPT_ASSEMBLY_SENTINEL:' +
      'q'.repeat(16 * 1024 * 1024 + 1),
    originalOpen = fsPromises.open;
  const patched = t.mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof open>) => {
      const file = await originalOpen(...args);
      if (String(args[0]).endsWith('/verify-0.log'))
        t.mock.method(file, 'writeFile', async () => {
          throw cause;
        });
      return file;
    },
  );
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof runCodexWriteWorkersRequest>>;
  try {
    result = await runCodexWriteWorkersRequest({
      ...request(f, 'transcript-failure'),
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "process.stdout.write('original stdout');process.stderr.write('original stderr');",
          ],
        },
      ],
    });
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  const receipt = JSON.parse(await readFile(result!.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.integratedCommit, null);
  assert.equal(
    receipt.reason,
    'Verification command 0 transcript capture failed.',
  );
  assert.equal(receipt.verification.length, 1);
  const capture = receipt.verification[0].capture;
  assert.equal(capture.complete, false);
  assert.equal(capture.transcript.status, 'capture-failed');
  assert.equal(capture.transcript.bytes, 0);
  assert.equal(await readFile(capture.stdout.path, 'utf8'), 'original stdout');
  assert.equal(await readFile(capture.stderr.path, 'utf8'), 'original stderr');
  const diagnostic = capture.diagnostics.find(
    (d: { category: string }) => d.category === 'verification-transcript',
  );
  assert(diagnostic);
  assert(capture.evidencePaths.includes(diagnostic.path));
  assert.equal(await readFile(diagnostic.path, 'utf8'), cause);
  assert.equal(diagnostic.bytes, Buffer.byteLength(cause));
  assert.equal(
    diagnostic.sha256,
    createHash('sha256').update(cause).digest('hex'),
  );
  assert(
    !JSON.stringify(receipt).includes('PRIVATE_TRANSCRIPT_ASSEMBLY_SENTINEL'),
  );
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('write runner terminal metadata publication failure keeps linked captures and full private cause without integration', async (t) => {
  const f = await fixture(),
    cause =
      'PRIVATE_WRITE_METADATA_SENTINEL:' + 'm'.repeat(16 * 1024 * 1024 + 1),
    originalWrite = fsPromises.writeFile;
  const patched = t.mock.method(
    fsPromises,
    'writeFile',
    async (...args: Parameters<typeof writeFile>) => {
      if (String(args[0]).endsWith('/process.json')) throw cause;
      return originalWrite(...args);
    },
  );
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof runCodexWriteWorkersRequest>>;
  try {
    result = await runCodexWriteWorkersRequest(request(f, 'metadata-failure'));
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  const receipt = JSON.parse(await readFile(result!.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.integratedCommit, null);
  assert(!JSON.stringify(receipt).includes('PRIVATE_WRITE_METADATA_SENTINEL'));
  for (const outcome of receipt.workerReceipt.outcomes) {
    assert.equal(outcome.error, null);
    assert.equal(outcome.result.status, 'BLOCKED');
    const paths = outcome.result.evidencePaths;
    assert(paths.some((path: string) => path.endsWith('/stdout.jsonl')));
    assert(paths.some((path: string) => path.endsWith('/stderr.log')));
    assert.equal(
      await readFile(
        paths.find((path: string) => path.includes('/adapter-metadata-')),
        'utf8',
      ),
      cause,
    );
  }
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
});

test('write verification setup failure retains the empty owned stdout and full private cause without nonexistent seal members', async (t) => {
  const f = await fixture(),
    cause = 'PRIVATE_VERIFICATION_SETUP:' + 'x'.repeat(16_777_217),
    original = fsPromises.open;
  const patch = t.mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof open>) => {
      if (String(args[0]).endsWith('/verify-0.stderr.log')) throw cause;
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof runCodexWriteWorkersRequest>>;
  try {
    result = await runCodexWriteWorkersRequest({
      ...request(f, 'verification-bootstrap'),
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "process.stdout.write('retained stdout');process.stderr.write('retained stderr');",
          ],
        },
      ],
    });
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
  const receipt = JSON.parse(await readFile(result!.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.integratedCommit, null);
  assert.equal(receipt.reason, 'Verification command 0 capture setup failed.');
  assert.equal(receipt.verification.length, 1);
  const entry = receipt.verification[0],
    capture = entry.capture;
  assert.equal(entry.code, null);
  assert.equal(capture.complete, false);
  assert.equal(capture.transcript, null);
  assert.equal(capture.stdout.available, true);
  assert.equal(capture.stdout.bytes, 0);
  assert.equal(capture.stderr.available, false);
  assert.equal(capture.stderr.status, 'capture-failed');
  assert.equal(await readFile(capture.stdout.path, 'utf8'), '');
  assert.equal(await stat(capture.stderr.path).catch(() => null), null);
  assert.equal(await stat(entry.logPath).catch(() => null), null);
  const diagnostic = capture.diagnostics.find(
    (d: { category: string }) => d.category === 'launch',
  );
  assert(diagnostic);
  assert.equal(await readFile(diagnostic.path, 'utf8'), cause);
  assert.equal(diagnostic.bytes, Buffer.byteLength(cause));
  assert.equal(
    diagnostic.sha256,
    createHash('sha256').update(cause).digest('hex'),
  );
  assert.deepEqual(verificationEvidencePaths(receipt), [
    capture.stdout.path,
    diagnostic.path,
  ]);
  assert(!JSON.stringify(receipt).includes('PRIVATE_VERIFICATION_SETUP'));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseCommit);
});
