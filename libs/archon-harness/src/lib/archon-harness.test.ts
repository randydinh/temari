import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { minimalPlan, type HarnessRunRef } from '@temari/contracts';
import { ArchonHarness, type ArchonCommandRunner } from './archon-harness.js';
import type { ManagedArchonRuntime } from './managed-runtime.js';

const runtime: ManagedArchonRuntime = {
  version: '0.10.1',
  commitPrefix: '9820785c',
  platform: 'darwin',
  arch: 'arm64',
  platformKey: 'darwin-arm64',
  assetName: 'archon-darwin-arm64',
  size: 100,
  sha256: 'a'.repeat(64),
  executablePath: '/tmp/temari-archon/archon',
};

function runReference(changes: Partial<HarnessRunRef> = {}): HarnessRunRef {
  return {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: 'temari-run-cancel',
    revision: 'revision-cancel',
    planSha256: 'd'.repeat(64),
    externalRunId: 'native-run-cancel',
    workspaceRoot: '/workspace',
    entrypoint: 'temari-feature',
    startedAt: new Date(0).toISOString(),
    ...changes,
  };
}

function commandRunner(
  calls: Array<{ args: readonly string[]; cwd: string }>,
): ArchonCommandRunner {
  return {
    async run(_executable, args, cwd) {
      calls.push({ args, cwd });
      if (args[0] === 'workflow' && args[1] === 'run') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ runId: 'native-run-1' }),
          stderr: '',
        };
      }
      if (args[0] === 'workflow' && args[1] === 'get') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: args[2],
            status: 'completed',
            log_path: '/tmp/archon-run.log',
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('starts a native run and binds its identity to the Temari plan', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({
    runtime,
    workflowSource: '/workspace/.archon/workflows',
    commandRunner: commandRunner(calls),
  });
  const reference = await harness.start({
    runId: 'temari-run-1',
    revision: 'revision-1',
    plan: minimalPlan('feature'),
    workspaceRoot: '/workspace',
    entrypoint: 'temari-feature',
    inputs: { request: 'Make the workflow portable' },
  });

  assert.equal(reference.harnessId, 'archon');
  assert.equal(reference.harnessVersion, '0.10.1');
  assert.equal(reference.externalRunId, 'native-run-1');
  assert.match(reference.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[0], {
    args: [
      'workflow',
      'run',
      'temari-feature',
      '--cwd',
      '/workspace',
      '--workflow-source',
      '/workspace/.archon/workflows',
      '--no-worktree',
      '--input',
      'request=Make the workflow portable',
      '--detach',
      '--json',
    ],
    cwd: '/workspace',
  });
});

test('reads provider status and resumes the same native run', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: commandRunner(calls),
  });
  const reference: HarnessRunRef = {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: 'temari-run-2',
    revision: 'revision-2',
    planSha256: 'b'.repeat(64),
    externalRunId: 'native-run-2',
    workspaceRoot: '/workspace',
    entrypoint: 'temari-feature',
    startedAt: new Date(0).toISOString(),
  };

  const status = await harness.status(reference);
  assert.equal(status.status, 'SUCCEEDED');
  assert.equal(status.rawLogPath, '/tmp/archon-run.log');
  const resumed = await harness.resume(reference);
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 3)),
    [
      ['workflow', 'get', 'native-run-2'],
      ['workflow', 'resume', 'native-run-2'],
      ['workflow', 'get', 'native-run-2'],
    ],
  );
});

test('resume detaches the exact native run and returns its current nonterminal status', async () => {
  const calls: Array<{
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
  }> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      async run(_executable, args, cwd, _environment, timeoutMs) {
        calls.push({ args, cwd, timeoutMs });
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            args[1] === 'resume'
              ? { runId: 'native-run-cancel', detached: true }
              : { id: 'native-run-cancel', status: 'running' },
          ),
          stderr: '',
        };
      },
    },
  });
  const snapshot = await harness.resume(runReference());
  assert.equal(snapshot.status, 'RUNNING');
  assert.deepEqual(calls, [
    {
      args: [
        'workflow',
        'resume',
        'native-run-cancel',
        '--cwd',
        '/workspace',
        '--detach',
        '--json',
      ],
      cwd: '/workspace',
      timeoutMs: 60_000,
    },
    {
      args: ['workflow', 'get', 'native-run-cancel', '--json'],
      cwd: '/workspace',
      timeoutMs: 15_000,
    },
  ]);
});

test('rejects malformed provider identities before invoking the CLI', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: commandRunner(calls),
  });
  const reference = {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: 'temari-run-3',
    revision: 'revision-3',
    planSha256: 'c'.repeat(64),
    externalRunId: '--help',
    workspaceRoot: '/workspace',
    entrypoint: 'temari-feature',
    startedAt: new Date(0).toISOString(),
  } as HarnessRunRef;
  await assert.rejects(harness.status(reference), /reference is invalid/);
  assert.equal(calls.length, 0);
});

test('verifies the exact pinned version and commit before use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-harness-test-'));
  try {
    const executablePath = join(root, 'archon');
    await writeFile(executablePath, 'fixture');
    const calls: string[][] = [];
    const harness = new ArchonHarness({
      runtime: { ...runtime, executablePath },
      commandRunner: {
        async run(_executable, args) {
          calls.push([...args]);
          return {
            exitCode: 0,
            stdout: 'Archon CLI v0.10.1\n  Git commit: 9820785c\n',
            stderr: '',
          };
        },
      },
    });
    await harness.verifyRuntime();
    assert.deepEqual(calls, [['version']]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancels the supplied exact native run and returns its observed status', async () => {
  for (const [nativeStatus, expectedStatus] of [
    ['cancelled', 'CANCELLED'],
    ['running', 'RUNNING'],
    ['failed', 'FAILED'],
    ['unrecognized', 'UNKNOWN'],
  ]) {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const harness = new ArchonHarness({
      runtime,
      commandRunner: {
        async run(executable, args, cwd) {
          assert.equal(executable, runtime.executablePath);
          calls.push({ args, cwd });
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              args[1] === 'cancel'
                ? { status: 'cancelled' }
                : {
                    id: 'native-run-cancel',
                    status: nativeStatus,
                    error: 'Native observation',
                    log_path: '/workspace/native-run-cancel.log',
                  },
            ),
            stderr: '',
          };
        },
      },
    });

    const result = await harness.cancel(runReference());
    assert.equal(result.status, expectedStatus);
    assert.equal(result.summary, 'Native observation');
    assert.equal(result.rawLogPath, '/workspace/native-run-cancel.log');
    assert.deepEqual(calls, [
      {
        args: ['workflow', 'cancel', 'native-run-cancel', '--json'],
        cwd: '/workspace',
      },
      {
        args: ['workflow', 'get', 'native-run-cancel', '--json'],
        cwd: '/workspace',
      },
    ]);
  }
});

test('rejects invalid cancellation references before invoking Archon', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: commandRunner(calls),
  });
  for (const changes of [
    { harnessId: 'different' },
    { harnessVersion: '0.11.0' },
    { externalRunId: '--help' },
    { externalRunId: '../another-run' },
    { planSha256: 'tampered' },
    { workspaceRoot: 'relative-workspace' },
  ]) {
    await assert.rejects(
      harness.cancel(runReference(changes)),
      /reference is invalid/,
    );
  }
  await assert.rejects(
    harness.cancel(runReference({ externalRunId: 'latest' })),
    /requires an exact native run ID/,
  );
  assert.equal(calls.length, 0);
});

test('a refused cancel command fails without reporting cancellation', async () => {
  const calls: Array<readonly string[]> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      async run(_executable, args) {
        calls.push(args);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Cannot cancel a server-owned workflow from the CLI',
        };
      },
    },
  });

  await assert.rejects(
    harness.cancel(runReference()),
    /workflow cancel failed with exit 1: Cannot cancel a server-owned workflow/,
  );
  assert.deepEqual(calls, [
    ['workflow', 'cancel', 'native-run-cancel', '--json'],
  ]);
});

test('cancellation does not accept a status response for a different run', async () => {
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      async run(_executable, args) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            args[1] === 'cancel'
              ? { status: 'cancelled' }
              : { id: 'another-native-run', status: 'cancelled' },
          ),
          stderr: '',
        };
      },
    },
  });

  await assert.rejects(
    harness.cancel(runReference()),
    /returned a different native run ID/,
  );
});

test('recoverable launches retain reserved Temari identity and reject input overrides', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({ runtime, commandRunner: commandRunner(calls) });
  const request = {
    runId: 'temari-recoverable',
    revision: 'recovery-revision',
    plan: minimalPlan('feature'),
    workspaceRoot: '/workspace',
    entrypoint: 'recovery-workflow',
    inputs: { request: 'Do work' },
  };
  const reference = await harness.start({ ...request, recovery: 'required' });
  const bindingArg = calls[0]?.args.find((arg) => arg.startsWith('temari_binding='));
  assert.ok(bindingArg);
  assert.deepEqual(JSON.parse(bindingArg.slice('temari_binding='.length)), {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    planSha256: reference.planSha256,
    workspaceRoot: request.workspaceRoot,
    entrypoint: request.entrypoint,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
  });
  for (const recovery of [undefined, 'required'] as const) {
    await assert.rejects(
      harness.start({ ...request, recovery, inputs: { temari_binding: '{}' } }),
      /temari_binding is reserved/,
    );
  }
  assert.equal(calls.length, 1);
});

test('recovery verifies retained native identity rather than caller fields', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'archon-native-identity-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const reference = runReference({ workspaceRoot });
  const binding = {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: reference.runId,
    revision: reference.revision,
    planSha256: reference.planSha256,
    workspaceRoot,
    entrypoint: reference.entrypoint,
  };
  let retained: Record<string, unknown> = {
    id: reference.externalRunId,
    workflow_name: reference.entrypoint,
    working_path: workspaceRoot,
    metadata: { inputs: { temari_binding: JSON.stringify(binding) } },
  };
  const original = retained;
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      async run(_executable, args, cwd) {
        calls.push({ args, cwd });
        return { exitCode: 0, stdout: JSON.stringify(retained), stderr: '' };
      },
    },
  });
  await harness.verifyRunIdentity(reference);
  assert.deepEqual(calls[0], {
    args: ['workflow', 'get', reference.externalRunId, '--json'],
    cwd: workspaceRoot,
  });

  for (const changes of [
    { runId: 'unrelated-temari-run' },
    { revision: 'different-revision' },
    { planSha256: 'e'.repeat(64) },
    { workspaceRoot: '/another-workspace' },
    { entrypoint: 'another-workflow' },
    { harnessVersion: '0.11.0' },
    { harnessId: 'another-harness' },
  ]) {
    retained = {
      ...original,
      metadata: { inputs: { temari_binding: JSON.stringify({ ...binding, ...changes }) } },
    };
    await assert.rejects(harness.verifyRunIdentity(reference), /native run identity does not match/);
  }
  for (const changes of [
    { workflow_name: 'another-workflow' },
    { working_path: tmpdir() },
  ]) {
    retained = { ...original, ...changes };
    await assert.rejects(harness.verifyRunIdentity(reference), /native run identity does not match/);
  }
  retained = { ...original, id: 'another-native-id' };
  await assert.rejects(harness.verifyRunIdentity(reference), /different native run ID/);
  retained = { ...original, metadata: { inputs: {} } };
  await assert.rejects(harness.verifyRunIdentity(reference), /no retained Temari identity binding/);
  retained = { ...original, metadata: { inputs: { temari_binding: 'not json' } } };
  await assert.rejects(harness.verifyRunIdentity(reference), /did not return valid JSON/);
});

test('native project links use only a safe observed codebase identity', async () => {
  for (const codebaseId of ['project-123', '../other-project', 'project/child', 'project..child', 'project?tab=other', '', null]) {
    const harness = new ArchonHarness({
      runtime,
      commandRunner: {
        async run() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: 'native-run-cancel', status: 'running', codebase_id: codebaseId }),
            stderr: '',
          };
        },
      },
    });
    const snapshot = await harness.status(runReference());
    assert.equal(snapshot.nativeProjectId, codebaseId === 'project-123' ? 'project-123' : undefined);
  }
});
