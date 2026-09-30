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
