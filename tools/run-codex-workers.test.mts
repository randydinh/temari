import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('excessive output is bounded and retained as a blocked result', async () => {
  const { root, executable } = await fixture();
  const result = await runCodexWorkersRequest({
    ...request(root, executable, ['flood', 'fast'], 'limit'),
    outputLimitBytes: 1024,
  });
  assert.equal(result.status, 'BLOCKED');
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.match(
    receipt.outcomes[0].result.summary,
    /exceeded 1024 output bytes/,
  );
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
  assert.equal(processEvidence.outputLimitExceeded, true);
  const retained = await readFile(
    join(root, 'evidence', 'run-limit', 'revision-1', 'flood', 'stdout.jsonl'),
  );
  assert(retained.length <= 1024);
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
    /final response exceeds 1024 bytes/,
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
