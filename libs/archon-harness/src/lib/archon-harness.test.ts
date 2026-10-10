import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, cp, realpath, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { minimalPlan, reconcilePlan, type ExecutionPlan, type HarnessRunRef } from '@temari/contracts';
import { ArchonHarness, ArchonIdentityInitializationError, type ArchonCommandRunner } from './archon-harness.js';
import { FileTaskStore, FileChildTaskStore, TaskRuntime, taskDigest } from '@temari/runtime';
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

test('managed candidate admission is pinned and refuses missing capabilities before native dispatch', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { reconcilePlan } = await import('@temari/contracts');
  const root = await mkdtemp(join(tmpdir(), 'temari-managed-admission-'));
  const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    const workflowSource = join(root, 'source');
    await mkdir(join(workflowSource, '.archon/workflows'), { recursive: true });
    await writeFile(join(workflowSource, '.archon/workflows/temari-reviewed-local-candidate.yaml'), 'fixture');
    const plan = reconcilePlan({workType:'feature',delegation:'required',review:'independent',evidence:'revision-bound',delivery:'local',parallelism:{maxConcurrency:1}});
    const specPath=join(root,'spec.json');const bridgePath=join(root,'bridge.mjs');
    const bridgeRuntimeExecutable=await realpath(process.execPath),bridgeRuntimeSha256=sha(await readFile(bridgeRuntimeExecutable));
    const spec=JSON.stringify({profile:'reviewed-local-candidate-v1',runId:'managed-run',baseCommit:'b'.repeat(40),repositoryRoot:root,plan,bridgeRuntime:{executable:bridgeRuntimeExecutable,sha256:bridgeRuntimeSha256}});
    await writeFile(specPath,spec);await writeFile(bridgePath,'fixture');
    const paths={specPath,bridgePath,expectedRequestSha256:sha(spec),expectedBridgeSha256:sha('fixture'),bridgeRuntimeExecutable,bridgeRuntimeSha256};
    const calls: Array<{args:readonly string[];cwd:string}>=[];
    const harness=new ArchonHarness({runtime,workflowSource,commandRunner:{async run(executable,args,cwd){calls.push({args,cwd});assert.equal(executable,bridgeRuntimeExecutable);return {exitCode:1,stdout:'',stderr:'Missing supported coding transport'};}}});
    const request={runId:'managed-run',revision:'b'.repeat(40),plan,workspaceRoot:root,recovery:'required' as const};
    await assert.rejects(harness.startReviewedLocalCandidate(request,paths),/before native dispatch/);
    assert.equal(calls.length,1);assert.equal(calls[0]!.args[1],'admit');
    await assert.rejects(harness.startReviewedLocalCandidate(request,{...paths,expectedBridgeSha256:'0'.repeat(64)}),/pin changed/);
    assert.equal(calls.length,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('managed Archon admission invokes the exact pinned runtime despite a shadow bun on PATH',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'archon-runtime-pin-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workflowSource=join(root,'source');
  await mkdir(join(workflowSource,'.archon','workflows'),{recursive:true});
  await writeFile(join(workflowSource,'.archon','workflows','temari-reviewed-local-candidate.yaml'),'fixture');
  const node=await realpath(process.execPath),sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  const runtimeMarker=join(root,'runtime-called'),shadowMarker=join(root,'shadow-called');
  const bridgeRuntimeExecutable=join(root,'pinned-runtime');
  await writeFile(bridgeRuntimeExecutable,`#!${node}\nrequire('node:fs').appendFileSync(${JSON.stringify(runtimeMarker)},'called\\n');console.error('Fixture admission refusal');process.exit(1);\n`,{mode:0o700});
  const shadowRoot=join(root,'shadow');await mkdir(shadowRoot);
  await writeFile(join(shadowRoot,'bun'),`#!${node}\nrequire('node:fs').writeFileSync(${JSON.stringify(shadowMarker)},'spoofed');console.log('{}');\n`,{mode:0o700});
  const bridgeRuntimeSha256=sha(await readFile(bridgeRuntimeExecutable));
  const plan=reconcilePlan({workType:'feature',delegation:'required',review:'independent',evidence:'revision-bound',delivery:'local',parallelism:{maxConcurrency:1}});
  const specPath=join(root,'spec.json'),bridgePath=join(root,'bridge.mjs');
  const spec=JSON.stringify({profile:'reviewed-local-candidate-v1',runId:'managed-run',baseCommit:'b'.repeat(40),repositoryRoot:root,plan,bridgeRuntime:{executable:bridgeRuntimeExecutable,sha256:bridgeRuntimeSha256}});
  await writeFile(specPath,spec);await writeFile(bridgePath,'fixture');
  const paths={specPath,bridgePath,expectedRequestSha256:sha(spec),expectedBridgeSha256:sha('fixture'),bridgeRuntimeExecutable,bridgeRuntimeSha256};
  const harness=new ArchonHarness({runtime,workflowSource,environment:{PATH:shadowRoot}});
  const request={runId:'managed-run',revision:'b'.repeat(40),workspaceRoot:root,plan,recovery:'required' as const};
  await assert.rejects(harness.startReviewedLocalCandidate(request,paths),/Fixture admission refusal/);
  assert.equal(await readFile(runtimeMarker,'utf8'),'called\n');
  await assert.rejects(readFile(shadowMarker),(error:any)=>error.code==='ENOENT');
  await assert.rejects(harness.startReviewedLocalCandidate(request,{...paths,bridgeRuntimeSha256:'0'.repeat(64)}),/runtime canonical identity\/pin changed/);
  const alias=join(root,'runtime-alias');await symlink(bridgeRuntimeExecutable,alias);
  await assert.rejects(harness.startReviewedLocalCandidate(request,{...paths,bridgeRuntimeExecutable:alias}),/runtime canonical identity\/pin changed/);
  await assert.rejects(harness.startReviewedLocalCandidate(request,{...paths,bridgeRuntimeExecutable:'bun'}),/paths must be absolute/);
  assert.equal(await readFile(runtimeMarker,'utf8'),'called\n');
});

test('retained pending-null pilot record reproduces strict identity refusal before its ready record', async () => {
  const records = JSON.parse(
    await readFile(
      new URL(
        './fixtures/native-identity-initialization.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const binding = JSON.parse(records[0].metadata.inputs.temari_binding);
  const reference: HarnessRunRef = {
    ...binding,
    externalRunId: records[0].id,
    startedAt: new Date(0).toISOString(),
  };
  let record = records[0];
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      async run() {
        return { exitCode: 0, stdout: JSON.stringify(record), stderr: '' };
      },
    },
  });
  await assert.rejects(
    harness.verifyRunIdentity(reference),
    /native run identity does not match/,
  );
  // Exact pending bytes need no local path. Rebase only workspace fields for
  // the ready positive control so the retained fixture remains portable.
  const root = await mkdtemp(join(tmpdir(), 'archon-retained-ready-'));
  try {
    const readyBinding = { ...binding, workspaceRoot: root };
    record = {
      ...records[1],
      working_path: root,
      metadata: { inputs: { temari_binding: JSON.stringify(readyBinding) } },
    };
    await harness.verifyRunIdentity({ ...reference, workspaceRoot: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function initializationFixture(t: import('node:test').TestContext, plan:ExecutionPlan=minimalPlan('investigation')) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'archon-initialization-'));
  t.after(async () => {
    const destination = process.env.NATIVE_IDENTITY_FIXTURE_EVIDENCE_ROOT;
    if (destination) {
      await mkdir(destination, { recursive: true });
      const target = join(destination, basename(workspaceRoot));
      await writeFile(
        join(workspaceRoot, 'fixture-native-records.json'),
        JSON.stringify(
          {
            reference,
            initialRecord: pending,
            lastRecord: selected,
            commands,
            scope:
              'Injected read/cancel responses only; no native command process',
          },
          null,
          2,
        ) + '\n',
      );
      await cp(workspaceRoot, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await writeFile(
        join(target, 'archive-origin.json'),
        JSON.stringify(
          {
            test: t.name,
            sourceRoot: workspaceRoot,
            scope:
              'Owned synthetic responses/ledgers only; no native command, model or recovered PID control.',
          },
          null,
          2,
        ) + '\n',
      );
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const records = JSON.parse(
    await readFile(
      new URL(
        './fixtures/native-identity-initialization.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const originalBinding = JSON.parse(records[0].metadata.inputs.temari_binding);
  const binding = {
    ...originalBinding,
    workspaceRoot,
    planSha256: taskDigest(plan),
  };
  const reference: HarnessRunRef = {
    ...binding,
    externalRunId: records[0].id,
    startedAt: new Date(0).toISOString(),
  };
  const pending = {
    ...records[0],
    metadata: { inputs: { temari_binding: JSON.stringify(binding) } },
  };
  const ready = {
    ...records[1],
    working_path: workspaceRoot,
    metadata: pending.metadata,
  };
  let selected: Record<string, unknown> = pending;
  let calls = 0;
  const commands: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  const harness = new ArchonHarness({
    runtime,
    environment: { ARCHON_HOME: join(workspaceRoot, 'archon-home') },
    commandRunner: {
      async run(_exe, args, cwd, _env, timeoutMs) {
        calls++;
        commands.push({ args, timeoutMs });
        assert.equal(cwd, workspaceRoot);
        assert.equal(_env.ARCHON_HOME, join(workspaceRoot, 'archon-home'));
        assert.equal(args[0], 'workflow');
        assert.equal(args[2], reference.externalRunId);
        assert(['get', 'cancel'].includes(args[1]!));
        if (args[1] === 'cancel') selected = { ...ready, status: 'cancelled' };
        return { exitCode: 0, stdout: JSON.stringify(selected), stderr: '' };
      },
    },
  });
  return {
    harness,
    reference,
    pending,
    ready,
    commands,
    set(record: Record<string, unknown>) {
      selected = record;
    },
    get calls() {
      return calls;
    },
  };
}

test('initialization observes pending-null then exact ready after caller durably retains the native reference', async (t) => {
  const f = await initializationFixture(t);
  // Host/runtime persistence happens before this adapter gate, including failures.
  const retainedPath = join(
    f.reference.workspaceRoot,
    'retained-native-reference.json',
  );
  await writeFile(retainedPath, JSON.stringify(f.reference));
  const seen: string[] = [];
  const result = await f.harness.waitForRunIdentityInitialization(f.reference, {
    onObservation(event) {
      seen.push(event.state);
      if (event.state === 'PENDING') f.set(f.ready);
    },
  });
  assert.deepEqual(seen, ['PENDING', 'READY']);
  assert.deepEqual(
    result.map((x) => x.attempt),
    [1, 2],
  );
  assert.deepEqual(
    JSON.parse(await readFile(retainedPath, 'utf8')),
    f.reference,
  );
  assert(
    f.commands.every(
      (c) =>
        c.timeoutMs > 0 &&
        c.timeoutMs <= 2000 &&
        c.args.join(' ') === `workflow get ${f.reference.externalRunId} --json`,
    ),
  );
  f.set(f.pending);
  await assert.rejects(
    f.harness.verifyRunIdentity(f.reference),
    /identity does not match/,
  );
  const calls = f.calls;
  await assert.rejects(
    f.harness.waitForRunIdentityInitialization({
      ...f.reference,
      startedAt: new Date().toISOString(),
    }),
    /already attempted/,
  );
  assert.equal(f.calls, calls);
});

test('permanent pending initialization expires, retains the reference/observations, and cannot retry', async (t) => {
  const f = await initializationFixture(t);
  const start = performance.now();
  let failure!: ArchonIdentityInitializationError;
  await assert.rejects(
    f.harness.waitForRunIdentityInitialization(f.reference),
    (error) => {
      assert(error instanceof ArchonIdentityInitializationError);
      failure = error;
      assert.deepEqual(error.reference, f.reference);
      assert(
        error.observations.length > 0 &&
          error.observations.every((o) => o.state === 'PENDING'),
      );
      assert.match(error.message, /deadline expired/);
      return true;
    },
  );
  assert(
    performance.now() - start >= 9900 && performance.now() - start < 14000,
  );
  assert(f.calls > 0 && f.calls <= 110);
  assert(
    f.commands.every(
      (command) => command.timeoutMs > 0 && command.timeoutMs <= 2000,
    ),
  );
  await writeFile(
    join(f.reference.workspaceRoot, 'default-deadline-observation.json'),
    JSON.stringify(
      {
        reason: failure.message,
        reference: failure.reference,
        observations: failure.observations,
        elapsedMs: performance.now() - start,
      },
      null,
      2,
    ) + '\n',
  );
  await assert.rejects(
    f.harness.waitForRunIdentityInitialization(f.reference),
    /already attempted/,
  );
});

test('initialization cancels while pending and obeys the earlier caller deadline', async (t) => {
  const f = await initializationFixture(t);
  const controller = new AbortController();
  await assert.rejects(
    f.harness.waitForRunIdentityInitialization(f.reference, {
      signal: controller.signal,
      onObservation() {
        controller.abort();
      },
    }),
    /cancelled/,
  );
  const g = await initializationFixture(t);
  const start = performance.now();
  await assert.rejects(
    g.harness.waitForRunIdentityInitialization(g.reference, {
      deadlineAtMs: Date.now() + 80,
    }),
    /deadline expired/,
  );
  assert(performance.now() - start < 1500);
  const h = await initializationFixture(t);
  await assert.rejects(
    h.harness.waitForRunIdentityInitialization(h.reference, {
      deadlineAtMs: Date.now() - 1,
    }),
    /deadline expired/,
  );
  assert.equal(h.calls, 0);
});

for (const kind of [
  'wrong-id',
  'wrong-binding',
  'missing-binding',
  'malformed-binding',
  'wrong-workflow',
  'wrong-workspace',
  'pending-with-workspace',
  'running-with-null',
  'missing-workspace',
  'unknown-status',
  'cancelled',
  'failed',
  'completed',
] as const) {
  test(`initialization refuses ${kind} immediately without waiting or returning ready`, async (t) => {
    const f = await initializationFixture(t);
    let bad: Record<string, unknown> = structuredClone(f.pending);
    if (kind === 'wrong-id') bad.id = 'foreign';
    if (kind === 'wrong-workflow') bad.workflow_name = 'foreign';
    if (kind === 'wrong-binding')
      bad.metadata = {
        inputs: {
          temari_binding: JSON.stringify({
            ...JSON.parse(f.pending.metadata.inputs.temari_binding),
            runId: 'foreign',
          }),
        },
      };
    if (kind === 'missing-binding') bad.metadata = { inputs: {} };
    if (kind === 'malformed-binding')
      bad.metadata = { inputs: { temari_binding: '{' } };
    if (kind === 'wrong-workspace') bad.working_path = tmpdir();
    if (kind === 'pending-with-workspace')
      bad.working_path = f.reference.workspaceRoot;
    if (kind === 'running-with-null') bad.status = 'running';
    if (kind === 'missing-workspace') delete bad.working_path;
    if (kind === 'unknown-status') bad.status = 'unknown';
    if (['cancelled', 'failed', 'completed'].includes(kind)) {
      bad = { ...f.ready, status: kind };
    }
    f.set(bad);
    let events = 0;
    await assert.rejects(
      f.harness.waitForRunIdentityInitialization(f.reference, {
        onObservation() {
          events++;
        },
      }),
    );
    assert.equal(f.calls, 1);
    assert.equal(events, 0);
  });
}

test('initialization refuses malformed responses and command failures without retry', async (t) => {
  const f = await initializationFixture(t);
  for (const result of [
    { exitCode: 0, stdout: '{', stderr: '' },
    { exitCode: 0, stdout: 'null', stderr: '' },
    { exitCode: 7, stdout: '', stderr: 'fixture failure' },
  ]) {
    let calls = 0;
    const harness = new ArchonHarness({
      runtime,
      commandRunner: {
        async run() {
          calls++;
          return result;
        },
      },
    });
    await assert.rejects(harness.waitForRunIdentityInitialization(f.reference));
    assert.equal(calls, 1);
  }
});

test('initialization bounds a stalled reader and interrupted observation retention; no late ready is accepted', async (t) => {
  const f = await initializationFixture(t);
  let resolveRead!: (value: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }) => void;
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      run() {
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    },
  });
  await assert.rejects(
    harness.waitForRunIdentityInitialization(f.reference, { timeoutMs: 60 }),
    /deadline expired/,
  );
  resolveRead({ exitCode: 0, stdout: JSON.stringify(f.ready), stderr: '' });
  await assert.rejects(
    harness.waitForRunIdentityInitialization(f.reference),
    /already attempted/,
  );
  const g = await initializationFixture(t);
  g.set(g.ready);
  await assert.rejects(
    g.harness.waitForRunIdentityInitialization(g.reference, {
      timeoutMs: 60,
      onObservation() {
        return new Promise(() => {});
      },
    }),
    /deadline expired/,
  );
});

test('initialization rejects invalid bounds and pre-aborted cancellation before a native read', async (t) => {
  const f = await initializationFixture(t);
  for (const timeoutMs of [0, -1, 10001, NaN])
    await assert.rejects(
      f.harness.waitForRunIdentityInitialization(f.reference, { timeoutMs }),
      /Invalid.*bound/,
    );
  await assert.rejects(f.harness.waitForRunIdentityInitialization({ ...f.reference, externalRunId: 'LaTeSt' }), /exact native run ID/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.harness.waitForRunIdentityInitialization(f.reference, {
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(f.calls, 0);
});

test('ready first observation succeeds once; later default identity loss never waits', async (t) => {
  const f = await initializationFixture(t);
  f.set(f.ready);
  const result = await f.harness.waitForRunIdentityInitialization(f.reference);
  assert.deepEqual(
    result.map((x) => x.state),
    ['READY'],
  );
  assert.equal(f.calls, 1);
  f.set(f.pending);
  await assert.rejects(f.harness.verifyRunIdentity(f.reference));
  assert.equal(f.calls, 2);
  const g = await initializationFixture(t);
  g.set(g.ready);
  await g.harness.verifyRunIdentity(g.reference);
  g.set(g.pending);
  await assert.rejects(
    g.harness.waitForRunIdentityInitialization(g.reference),
    /already attempted/,
  );
  assert.equal(g.calls, 1);
});

test('abort during an outstanding initialization read rejects before its late ready response', async (t) => {
  const f = await initializationFixture(t);
  const controller = new AbortController();
  let resolveRead!: (value: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }) => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const harness = new ArchonHarness({
    runtime,
    commandRunner: {
      run() {
        entered();
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    },
  });
  const waiting = assert.rejects(
    harness.waitForRunIdentityInitialization(f.reference, {
      signal: controller.signal,
    }),
    (error) => {
      assert(error instanceof ArchonIdentityInitializationError);
      assert.deepEqual(error.reference, f.reference);
      assert.match(error.message, /cancelled/);
      return true;
    },
  );
  await reading;
  controller.abort();
  await waiting;
  resolveRead({ exitCode: 0, stdout: JSON.stringify(f.ready), stderr: '' });
  await assert.rejects(
    harness.waitForRunIdentityInitialization(f.reference),
    /already attempted/,
  );
});

test('a contradictory binding or terminal transition after pending cannot be erased by later ready', async (t) => {
  for (const change of [
    { schema: 2 },
    { runId: 'foreign' },
    { revision: 'foreign' },
    { planSha256: 'e'.repeat(64) },
    { workspaceRoot: tmpdir() },
    { entrypoint: 'foreign' },
    { harnessId: 'foreign' },
    { harnessVersion: '9.9.9' },
    { extra: 'foreign' },
  ]) {
    const g = await initializationFixture(t);
    g.set({
      ...g.pending,
      metadata: {
        inputs: {
          temari_binding: JSON.stringify({
            ...JSON.parse(g.pending.metadata.inputs.temari_binding),
            ...change,
          }),
        },
      },
    });
    await assert.rejects(
      g.harness.waitForRunIdentityInitialization(g.reference),
    );
    assert.equal(g.calls, 1);
  }
  for (const kind of ['terminal', 'binding']) {
    const g = await initializationFixture(t);
    const changed =
      kind === 'terminal'
        ? { ...g.ready, status: 'cancelled' }
        : {
            ...g.pending,
            metadata: {
              inputs: {
                temari_binding: JSON.stringify({
                  ...JSON.parse(g.pending.metadata.inputs.temari_binding),
                  revision: 'foreign',
                }),
              },
            },
          };
    let observations = 0;
    await assert.rejects(
      g.harness.waitForRunIdentityInitialization(g.reference, {
        onObservation() {
          observations++;
          g.set(changed);
        },
      }),
    );
    assert.equal(observations, 1);
    assert.equal(g.calls, 2);
    g.set(g.ready);
    await assert.rejects(
      g.harness.waitForRunIdentityInitialization(g.reference),
      /already attempted/,
    );
  }
});

test('ready workspace must be absolute and resolve to the exact selected workspace', async (t) => {
  for (const working_path of [
    'relative',
    tmpdir(),
    '/not-present-native-readiness-workspace',
  ]) {
    const f = await initializationFixture(t);
    f.set({ ...f.ready, working_path });
    await assert.rejects(
      f.harness.waitForRunIdentityInitialization(f.reference),
    );
    assert.equal(f.calls, 1);
  }
});

test('caller dispatch retains exact reference before readiness timeout and uses existing strict cleanup without redispatch', async (t) => {
  const plan = reconcilePlan({workType:'feature',delegation:'required',review:'independent',evidence:'revision-bound',delivery:'local',parallelism:{maxConcurrency:1}});
  const f = await initializationFixture(t,plan);
  const tasks = await FileTaskStore.create(
    join(f.reference.workspaceRoot, 'tasks'),
  );
  const children = await FileChildTaskStore.create(
    join(f.reference.workspaceRoot, 'children'),
  );
  let parent = await tasks.createTask({
    taskId: 'parent',
    title: 'fixture',
    goal: 'fixture',
    workspaceRoot: f.reference.workspaceRoot,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  parent = await tasks.bindRun({
    taskId: 'parent',
    actor: 'fixture',
    idempotencyKey: 'bind',
    expectedVersion: parent.version,
    run: {
      runId: f.reference.runId,
      revision: f.reference.revision,
      plan,
      executionStoreRoot: join(f.reference.workspaceRoot, 'children'),
    },
  });
  let dispatches = 0;
  let usefulWork = 0;
  const root=await realpath(f.reference.workspaceRoot);
  const specPath=join(root,'managed-request.json'),bridgePath=join(root,'managed-bridge.mjs');
  const bridgeRuntimeExecutable=await realpath(process.execPath);
  const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  const bridgeRuntimeSha256=sha(await readFile(bridgeRuntimeExecutable));
  const spec=JSON.stringify({profile:'reviewed-local-candidate-v1',runId:f.reference.runId,baseCommit:f.reference.revision,repositoryRoot:f.reference.workspaceRoot,plan,bridgeRuntime:{executable:bridgeRuntimeExecutable,sha256:bridgeRuntimeSha256}});
  await writeFile(specPath,spec);await writeFile(bridgePath,'fixture');
  const paths={specPath,bridgePath,expectedRequestSha256:sha(spec),expectedBridgeSha256:sha('fixture'),bridgeRuntimeExecutable,bridgeRuntimeSha256};
  const host = {
    id: 'archon',
    version: '0.10.1',
    async start():Promise<never> {throw new Error('Generic dispatch cannot admit a managed candidate.');},
    async startReviewedLocalCandidate(request:Omit<import('@temari/contracts').HarnessRunRequest,'entrypoint'|'inputs'>,selected:typeof paths) {
      assert.deepEqual(selected,paths);
      assert.deepEqual(request.plan,plan);
      assert.equal(sha(await readFile(selected.specPath)),selected.expectedRequestSha256);
      assert.equal(sha(await readFile(selected.bridgePath)),selected.expectedBridgeSha256);
      assert.equal(sha(await readFile(selected.bridgeRuntimeExecutable)),selected.bridgeRuntimeSha256);
      dispatches++;
      return f.reference;
    },
    status: (r: HarnessRunRef) => f.harness.status(r),
    cancel: (r: HarnessRunRef) => f.harness.cancel(r),
    verifyRunIdentity: (r: HarnessRunRef) => f.harness.verifyRunIdentity(r),
    async resume(): Promise<never> {
      throw new Error('No replay.');
    },
  };
  const control = new TaskRuntime({
    store: tasks,
    selection: {
      hostHarness: host,
      configuredHarness: null,
      managedDefault: null,
    },
  });
  await control.dispatchReviewedLocalCandidate({
    taskId: 'parent',
    runId: f.reference.runId,
    actor: 'fixture',
    idempotencyKey: 'dispatch',
    expectedVersion: parent.version,
    paths,
  });
  const retained = (await tasks.load('parent'))!.runs[0]!.nativeRef!;
  assert.deepEqual(retained, f.reference);
  try {
    await f.harness.waitForRunIdentityInitialization(retained, {
      timeoutMs: 80,
      onObservation: async () => {
        assert.deepEqual(
          (await tasks.load('parent'))!.runs[0]!.nativeRef,
          retained,
        );
        assert.equal(usefulWork, 0);
        assert.deepEqual(await children.executionRecords(retained.runId), []);
      },
    });
    usefulWork++;
  } catch (error) {
    assert(error instanceof ArchonIdentityInitializationError);
    assert.deepEqual(error.reference, retained);
    await writeFile(
      join(f.reference.workspaceRoot, 'readiness-failure.json'),
      JSON.stringify(
        {
          reference: error.reference,
          observations: error.observations,
          reason: error.message,
        },
        null,
        2,
      ),
    );
    // Simulate later workspace publication; initial timeout remains a failure.
    // Cleanup requires ordinary exact identity verification before native cancel.
    f.set(f.ready);
    await f.harness.verifyRunIdentity(retained);
    const selected = (await tasks.load('parent'))!;
    await control.cancel({
      taskId: 'parent',
      runId: retained.runId,
      actor: 'fixture',
      idempotencyKey: 'cleanup',
      expectedVersion: selected.version,
    });
  }
  assert.equal(usefulWork, 0);
  assert.equal(dispatches, 1);
  assert.deepEqual((await tasks.load('parent'))!.runs[0]!.nativeRef, retained);
  assert.equal(
    (await tasks.load('parent'))!.runs[0]!.nativeSnapshot?.status,
    'CANCELLED',
  );
  assert.equal(f.commands.filter((c) => c.args[1] === 'cancel').length, 1);
  assert.deepEqual(await children.executionRecords(retained.runId), []);
});
