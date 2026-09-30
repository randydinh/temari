import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { DEFAULT_STAGES, HOST_CAPABILITIES, minimalPlan } from '@temari/contracts';
import {
  executeAndPersist,
  FileEvidenceStore,
  FileWorkflowReceiptStore,
  verifyDeterministicArchonReceiptParity,
} from '@temari/runtime';
import { ArchonHarness } from './archon-harness.js';
import { installArchonRuntime } from './managed-runtime.js';

const runFile = promisify(execFile);
const bridgePath = resolve('packages/workflow-runtime/assets/v4.1/integrations/archon/canonical-bridge.ts');
const finalizerPath = fileURLToPath(new URL('./canonical-finalize.ts', import.meta.url));

test('pinned native Archon schedules six stages and yields matching persisted Nx evidence', { timeout: 120_000, skip: process.platform !== 'darwin' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-archon-native-parity-'));
  let passed = false;
  t.after(async () => {
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`Native Archon evidence retained at ${root}`);
  });
  const cacheDirectory = join(homedir(), 'Library', 'Caches', 'Temari');
  const runtime = await installArchonRuntime({ cacheDirectory, platform: process.platform, arch: process.arch });
  const workspaceRoot = resolve(process.cwd());
  const plan = minimalPlan('feature');
  const runId = `archon-parity-${Date.now()}`;
  const revision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim();
  const specPath = join(root, 'spec.json');
  await writeFile(specPath, JSON.stringify({
    schema: 1, runId, revision, repositoryRoot: workspaceRoot, plan,
    stages: Object.fromEntries(DEFAULT_STAGES.map((stage) => [stage, {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TEMARI_STAGE + "\\n")'],
      timeoutMs: 3000, summary: `${stage} complete`,
    }])),
  }));
  const harness = new ArchonHarness({
    runtime,
    workflowSource: dirname(bridgePath),
    environment: {
      ARCHON_HOME: join(root, 'archon-home'),
      LOG_LEVEL: 'error',
      DO_NOT_TRACK: '1',
      CLAUDE_BIN_PATH: '/usr/bin/false',
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    },
  });
  await harness.verifyRuntime();
  const reference = await harness.startCanonical({ runId, revision, plan, workspaceRoot }, { specPath, bridgePath, finalizerPath });
  let status = await harness.status(reference);
  for (let attempt = 0; attempt < 100 && (status.status === 'QUEUED' || status.status === 'RUNNING'); attempt++) {
    await new Promise((done) => setTimeout(done, 500));
    status = await harness.status(reference);
  }
  const native = JSON.parse((await runFile(runtime.executablePath, ['workflow', 'get', reference.externalRunId, '--json'], {
    cwd: workspaceRoot,
    env: { ...process.env, ARCHON_HOME: join(root, 'archon-home') },
  })).stdout) as { output_root: string };
  if (status.status !== 'SUCCEEDED') console.error(JSON.stringify(native));
  assert.equal(status.status, 'SUCCEEDED', `Native Archon status: ${status.status}: ${status.summary}`);
  const artifactsDirectory = join(native.output_root, 'artifacts', 'runs', reference.externalRunId);
  const archonReceipts = await FileWorkflowReceiptStore.openExisting(join(artifactsDirectory, 'temari-nx-canonical', 'receipts'));
  const archonEvidence = await FileEvidenceStore.openExisting(join(artifactsDirectory, 'temari-nx-canonical', 'evidence'));
  const marker = JSON.parse(await readFile(join(artifactsDirectory, 'temari-nx-canonical', 'completion.json'), 'utf8'));
  assert.equal(marker.nativeRunId, reference.externalRunId);
  const serialReceipts = await FileWorkflowReceiptStore.create(join(root, 'serial-receipts'));
  const serialEvidence = await FileEvidenceStore.create(join(root, 'serial-evidence'));
  const serialRunId = `serial-parity-${Date.now()}`;
  await executeAndPersist({
    runId: serialRunId, revision, plan,
    capabilities: { host: 'fixture', available: [], missing: HOST_CAPABILITIES, notes: {} },
    store: serialReceipts, stageEvidence: { store: serialEvidence },
    handler: (stage) => ({ status: 'PASS', summary: `${stage} complete`, evidence: [
      { name: 'stdout', kind: 'stdout', content: `${stage}\n` },
      { name: 'stderr', kind: 'stderr', content: '' },
    ] }),
  });
  const bundle = await verifyDeterministicArchonReceiptParity({
    harness, reference,
    serial: { runId: serialRunId, receipts: serialReceipts, evidence: serialEvidence },
    archon: { runId, receipts: archonReceipts, evidence: archonEvidence },
  });
  assert.deepEqual(bundle.archonReceipt.stages.map((stage) => stage.stage), DEFAULT_STAGES);
  assert.equal(bundle.nativeRun.externalRunId, reference.externalRunId);
  passed = true;
  console.log(`Native Archon six-stage fixture parity: ${reference.externalRunId}`);
});
