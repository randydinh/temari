import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
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
import {
  runCodexWorkersRequest,
  type CodexWorkersRequest,
} from './run-codex-workers.mjs';

const rootFixture = fileURLToPath(new URL('..', import.meta.url));

async function fixture(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), 'temari-codex-cli-'));
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const match = prompt.match(/Goal: (\\S+)/);
  const id = match?.[1] ?? 'unknown';
  const delay = id.startsWith('hang') ? 30000 : id === 'slow' ? 450 : 90;
  fs.writeFileSync('started-' + id, String(process.pid));
  if (id.startsWith('large-')) { const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));}; fs.writeFileSync(final,JSON.stringify({status:'PASS',summary:'known result'}));Promise.all([emit(process.stdout,97,'PRIVATE_STDOUT_SENTINEL:'),emit(process.stderr,122,'PRIVATE_STDERR_SENTINEL:')]).then(()=>process.exit(id==='large-exit'?7:0));return; }
  setTimeout(() => {
    console.log(id === 'flood' ? 'x'.repeat(4096) : JSON.stringify({type:'worker',id}));
    if (id === 'exit') process.exit(7);
    fs.writeFileSync(final, id === 'malformed' ? '{oops' : JSON.stringify({status:'PASS',summary:id === 'huge-final' ? 'x'.repeat(4096) : id+' done'}));
  }, delay);
});
`,
  );
  await chmod(executable, 0o755);
  return { root, executable };
}

function assignment(id: string) {
  return {
    id,
    role: 'investigator' as const,
    required: true,
    brief: {
      goal: id,
      context: 'Local test',
      scope: 'Repository',
      acceptanceCriteria: ['Report a result'],
      verificationCommand: null,
      reportFormat: 'json' as const,
      forbiddenActions: ['Do not write files'],
    },
  };
}

function request(
  root: string,
  executable: string,
  ids: string[],
  suffix: string,
): CodexWorkersRequest {
  return {
    runId: `run-${suffix}`,
    revision: 'revision-1',
    workspaceRoot: root,
    evidenceRoot: join(root, 'evidence'),
    assignments: ids.map(assignment),
    maxConcurrency: 2,
    executable,
    timeoutMs: 2000,
  };
}

test('real child processes overlap within bound two and join in request order', async () => {
  const { root, executable } = await fixture();
  const ids = ['slow', 'fast', 'third', 'fourth'];
  const result = await runCodexWorkersRequest(
    request(root, executable, ids, 'overlap'),
  );
  assert.equal(result.status, 'PASS');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.deepEqual(
    receipt.outcomes.map(
      (entry: { assignment: { id: string } }) => entry.assignment.id,
    ),
    ids,
  );
  assert.equal(receipt.peakConcurrency, 2);
  const processes = await Promise.all(
    ids.map(async (id) =>
      JSON.parse(
        await readFile(
          join(
            root,
            'evidence',
            'run-overlap',
            'revision-1',
            id,
            'process.json',
          ),
          'utf8',
        ),
      ),
    ),
  );
  assert.equal(new Set(processes.map((entry) => entry.pid)).size, 4);
  const intervals = processes.map((entry) => [
    Date.parse(entry.startedAt),
    Date.parse(entry.endedAt),
  ]);
  assert(
    intervals[0]![0]! < intervals[1]![1]! &&
      intervals[1]![0]! < intervals[0]![1]!,
    'first two OS processes must overlap',
  );
  const times = intervals
    .flatMap(([start, end]) => [
      { time: start, delta: 1 },
      { time: end, delta: -1 },
    ])
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const event of times) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2);
});

test('malformed JSON, exit failure, and timeout retain sibling evidence', async () => {
  const { root, executable } = await fixture();
  const cases = [
    {
      ids: ['malformed', 'fast'],
      suffix: 'malformed',
      timeoutMs: 2000,
      expected: /final response is invalid/,
    },
    {
      ids: ['exit', 'fast'],
      suffix: 'exit',
      timeoutMs: 2000,
      expected: /exited with code 7/,
    },
    {
      ids: ['slow', 'fast'],
      suffix: 'timeout',
      timeoutMs: 300,
      expected: /exceeded 300 ms/,
    },
  ];
  for (const item of cases) {
    const result = await runCodexWorkersRequest({
      ...request(root, executable, item.ids, item.suffix),
      timeoutMs: item.timeoutMs,
    });
    assert.equal(result.status, 'BLOCKED');
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    assert.match(receipt.outcomes[0].result.summary, item.expected);
    assert.equal(receipt.outcomes[1].result.status, 'PASS');
    for (const id of item.ids) {
      const files = await readdir(
        join(root, 'evidence', `run-${item.suffix}`, 'revision-1', id),
      );
      assert(files.includes('process.json'));
      assert(files.includes('stdout.jsonl'));
    }
  }
});

test('legacy output limit bounds only final JSON and never kills or truncates raw output', async () => {
  const { root, executable } = await fixture();
  const result = await runCodexWorkersRequest({
    ...request(root, executable, ['flood', 'fast'], 'limit'),
    outputLimitBytes: 1024,
  });
  assert.equal(result.status, 'PASS');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.outcomes[0].result.summary, 'flood done');
  assert.equal(receipt.outcomes[1].result.status, 'PASS');
  const processEvidence = JSON.parse(
    await readFile(
      join(
        root,
        'evidence',
        'run-limit',
        'revision-1',
        'flood',
        'process.json',
      ),
      'utf8',
    ),
  );
  assert.equal(processEvidence.outputLimitExceeded, false);
  assert.equal(processEvidence.finalResponseLimitBytes, 1024);
  const retained = await readFile(
    join(root, 'evidence', 'run-limit', 'revision-1', 'flood', 'stdout.jsonl'),
  );
  assert.equal(retained.length, 4097);
});

test('oversized final response is blocked before parsing and retains diagnostics', async () => {
  const { root, executable } = await fixture();
  const result = await runCodexWorkersRequest({
    ...request(root, executable, ['huge-final', 'fast'], 'final-limit'),
    outputLimitBytes: 1024,
  });
  assert.equal(result.status, 'BLOCKED');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(
    receipt.outcomes[0].result.summary,
    /invalid or exceeds its semantic byte limit/,
  );
  assert.equal(receipt.outcomes[1].result.status, 'PASS');
  const finalPath = join(
    root,
    'evidence',
    'run-final-limit',
    'revision-1',
    'huge-final',
    'final.json',
  );
  assert((await stat(finalPath)).size > 1024);
  assert.equal(
    receipt.outcomes[0].result.evidencePaths.includes(finalPath),
    true,
  );
});

test(
  'evidence directories and files are private on POSIX',
  { skip: process.platform === 'win32' },
  async () => {
    const { root, executable } = await fixture();
    const result = await runCodexWorkersRequest(
      request(root, executable, ['fast'], 'permissions'),
    );
    const base = join(root, 'evidence', 'run-permissions');
    const run = join(base, 'revision-1');
    const worker = join(run, 'fast');
    for (const path of [base, run, worker]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
    for (const path of [
      result.receiptPath,
      ...[
        'stdout.jsonl',
        'stderr.log',
        'process.json',
        'output-schema.json',
        'final.json',
      ].map((name) => join(worker, name)),
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600, path);
    }
  },
);

for (const [interrupt, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  test(
    `${interrupt} cancels active process groups and writes a blocked receipt for queued work`,
    { skip: process.platform === 'win32' },
    async () => {
      const { root, executable } = await fixture();
      const inputPath = join(root, 'interrupt-request.json');
      await writeFile(
        inputPath,
        JSON.stringify(
          request(
            root,
            executable,
            ['hang-one', 'hang-two', 'queued'],
            'interrupt',
          ),
        ),
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          join(rootFixture, 'tools', 'run-codex-workers.mts'),
          inputPath,
        ],
        { cwd: rootFixture, shell: false },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk;
      });
      const started = Date.now();
      while (true) {
        try {
          await Promise.all(
            ['hang-one', 'hang-two'].map((id) =>
              stat(join(root, `started-${id}`)),
            ),
          );
          break;
        } catch {
          if (Date.now() - started > 5000) {
            child.kill('SIGKILL');
            throw new Error(`workers did not start: ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      child.kill(interrupt);
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('interrupted runner did not exit'));
        }, 5000);
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      assert.equal(exit, expectedCode, stderr);
      const result = JSON.parse(stdout);
      assert.equal(result.status, 'BLOCKED');
      const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
      assert.deepEqual(
        receipt.outcomes.map(
          (entry: { result: { status: string } }) => entry.result.status,
        ),
        ['BLOCKED', 'BLOCKED', 'BLOCKED'],
      );
      for (const id of ['hang-one', 'hang-two']) {
        const evidence = JSON.parse(
          await readFile(
            join(
              root,
              'evidence',
              'run-interrupt',
              'revision-1',
              id,
              'process.json',
            ),
            'utf8',
          ),
        );
        assert.equal(evidence.cancelled, true);
        assert(typeof evidence.pid === 'number');
        assert.throws(() => process.kill(evidence.pid, 0), /ESRCH/);
      }
      const queued = JSON.parse(
        await readFile(
          join(
            root,
            'evidence',
            'run-interrupt',
            'revision-1',
            'queued',
            'process.json',
          ),
          'utf8',
        ),
      );
      assert.equal(queued.pid, null);
      assert.equal(queued.cancelled, true);
    },
  );
}
test('an already-aborted request records every assignment without launching a process', async () => {
  const { root, executable } = await fixture();
  const controller = new AbortController();
  controller.abort('SIGTERM');
  const result = await runCodexWorkersRequest(
    request(root, executable, ['hang-one', 'queued'], 'pre-aborted'),
    controller.signal,
  );
  assert.equal(result.status, 'BLOCKED');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.outcomes.length, 2);
  for (const id of ['hang-one', 'queued']) {
    const evidence = JSON.parse(
      await readFile(
        join(
          root,
          'evidence',
          'run-pre-aborted',
          'revision-1',
          id,
          'process.json',
        ),
        'utf8',
      ),
    );
    assert.equal(evidence.pid, null);
    assert.equal(evidence.cancelled, true);
  }
  await assert.rejects(() => stat(join(root, 'started-hang-one')));
});

test('preflight rejects missing executable and invalid role before any worker starts', async () => {
  const { root, executable } = await fixture();
  await assert.rejects(
    () =>
      runCodexWorkersRequest({
        ...request(root, '/missing/codex', ['fast'], 'missing'),
      }),
    /missing or not executable/,
  );
  await assert.rejects(
    () =>
      runCodexWorkersRequest({
        ...request(root, executable, ['fast'], 'role'),
        assignments: [{ ...assignment('fast'), role: 'implementer' }],
      }),
    /investigator or reviewer/,
  );
  await assert.rejects(() => readdir(join(root, 'evidence')));
});

test('public CLI accepts a request file and prints receipt path', async () => {
  const { root, executable } = await fixture();
  const inputPath = join(root, 'request.json');
  await writeFile(
    inputPath,
    JSON.stringify(request(root, executable, ['fast'], 'public')),
  );
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
        join(rootFixture, 'tools', 'run-codex-workers.mts'),
        inputPath,
      ],
      { cwd: rootFixture, shell: false },
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
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, 'utf8')).outcomes.length,
    1,
  );
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

test('read worker runner retains full large pipes on normal and nonzero exits with concise receipts', async (t) => {
  for (const failed of [false, true])
    await t.test(failed ? 'nonzero' : 'normal', async () => {
      const f = await fixture();
      try {
        const goal = failed ? 'large-exit' : 'large-pass';
        const result = await runCodexWorkersRequest({
          ...request(f.root, f.executable, [goal, 'fast'], 'large'),
          timeoutMs: 10000,
          finalResponseLimitBytes: 1024,
        });
        assert.equal(result.status, failed ? 'BLOCKED' : 'PASS');
        const directory = join(
          f.root,
          'evidence',
          'run-large',
          'revision-1',
          goal,
        );
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

test('read runner retains private full schema and terminal metadata publication causes with controlled linked results', async (t) => {
  for (const name of ['output-schema.json', 'process.json'])
    await t.test(name, async (t) => {
      const f = await fixture(),
        cause =
          'PRIVATE_METADATA_CAUSE_SENTINEL:' + 'm'.repeat(16 * 1024 * 1024 + 1),
        originalWrite = fsPromises.writeFile;
      const patched = t.mock.method(
        fsPromises,
        'writeFile',
        async (...args: Parameters<typeof writeFile>) => {
          if (String(args[0]).endsWith('/' + name)) throw cause;
          return originalWrite(...args);
        },
      );
      syncBuiltinESMExports();
      let result: Awaited<ReturnType<typeof runCodexWorkersRequest>>;
      try {
        result = await runCodexWorkersRequest(
          request(f.root, f.executable, ['fast'], 'metadata'),
        );
      } finally {
        patched.mock.restore();
        syncBuiltinESMExports();
      }
      const receipt = JSON.parse(await readFile(result!.receiptPath, 'utf8'));
      assert.equal(receipt.status, 'BLOCKED');
      assert.equal(receipt.outcomes[0].error, null);
      const worker = receipt.outcomes[0].result;
      assert(worker);
      assert.equal(worker.status, 'BLOCKED');
      assert(
        !JSON.stringify(receipt).includes('PRIVATE_METADATA_CAUSE_SENTINEL'),
      );
      const path = worker.evidencePaths.find((path: string) =>
        path.includes('/adapter-'),
      );
      assert(path);
      assert.equal(await readFile(path, 'utf8'), cause);
      if (name === 'process.json') {
        assert(
          worker.evidencePaths.some((path: string) =>
            path.endsWith('/stdout.jsonl'),
          ),
        );
        assert(
          worker.evidencePaths.some((path: string) =>
            path.endsWith('/stderr.log'),
          ),
        );
        assert(
          !worker.evidencePaths.some((path: string) =>
            path.endsWith('/process.json'),
          ),
        );
      } else
        assert(
          !worker.evidencePaths.some((path: string) =>
            path.endsWith('/stdout.jsonl'),
          ),
        );
    });
});

test('read runner capture setup open failure retains full private cause and available prelaunch sources', async (t) => {
  for (const name of ['stdout.jsonl', 'stderr.log'])
    await t.test(name, async (t) => {
      const f = await fixture(),
        cause =
          'PRIVATE_CAPTURE_SETUP_SENTINEL:' + 's'.repeat(16 * 1024 * 1024 + 1),
        originalOpen = fsPromises.open;
      const patched = t.mock.method(
        fsPromises,
        'open',
        async (...args: Parameters<typeof open>) => {
          if (String(args[0]).endsWith('/' + name)) throw cause;
          return originalOpen(...args);
        },
      );
      syncBuiltinESMExports();
      let result: Awaited<ReturnType<typeof runCodexWorkersRequest>>;
      try {
        result = await runCodexWorkersRequest(
          request(f.root, f.executable, ['fast'], 'setup'),
        );
      } finally {
        patched.mock.restore();
        syncBuiltinESMExports();
      }
      const receipt = JSON.parse(await readFile(result!.receiptPath, 'utf8'));
      assert.equal(receipt.status, 'BLOCKED');
      const outcome = receipt.outcomes[0];
      assert(
        Boolean(outcome.result && outcome.error === null),
        'Setup error must become a controlled result with linked private sources.',
      );
      assert(
        !JSON.stringify(receipt).includes('PRIVATE_CAPTURE_SETUP_SENTINEL'),
      );
      const paths = outcome.result.evidencePaths;
      assert(
        paths.some((path: string) => path.endsWith('/output-schema.json')),
      );
      assert.equal(
        await readFile(
          paths.find((path: string) => path.includes('/capture-diagnostic-')),
          'utf8',
        ),
        cause,
      );
      if (name === 'stderr.log')
        assert.equal(
          await readFile(
            paths.find((path: string) => path.endsWith('/stdout.jsonl')),
            'utf8',
          ),
          '',
        );
      const metadata = JSON.parse(
        await readFile(
          paths.find((path: string) => path.endsWith('/process.json')),
          'utf8',
        ),
      );
      assert.equal(metadata.captureComplete, false);
      assert.equal(metadata.pid, null);
      assert.equal(
        await stat(join(f.root, 'started-fast')).catch(() => null),
        null,
      );
    });
});
