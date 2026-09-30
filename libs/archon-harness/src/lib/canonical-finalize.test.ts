import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { finalizeCanonicalArchonReceipt } from './canonical-finalize.js';

const runFile = promisify(execFile);
const bridgePath = resolve('packages/workflow-runtime/assets/v4.1/integrations/archon/canonical-bridge.ts');
const finalizerPath = fileURLToPath(new URL('./canonical-finalize.ts', import.meta.url));
const workflowSource = dirname(bridgePath);

test('six canonical bridge stages publish a persisted Nx receipt and match serial evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'archon-canonical-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'repo');
  const artifactsDirectory = join(root, 'artifacts');
  await mkdir(repositoryRoot);
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'stable\n');
  execFileSync('git', ['-C', repositoryRoot, 'init', '-q']);
  execFileSync('git', ['-C', repositoryRoot, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', repositoryRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']);
  const plan = minimalPlan('feature');
  const request = { runId: 'archon-receipt-run', revision: 'frozen-revision', plan, workspaceRoot: repositoryRoot };
  const specPath = join(root, 'spec.json');
  const spec = {
    schema: 1, runId: request.runId, revision: request.revision,
    repositoryRoot, plan,
    stages: Object.fromEntries(DEFAULT_STAGES.map((stage) => [stage, {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TEMARI_STAGE + "\\n")'],
      timeoutMs: 3000, summary: `${stage} complete`,
    }])),
  };
  await writeFile(specPath, JSON.stringify(spec));
  const harness = new ArchonHarness({
    runtime: {
      version: '0.10.1', commitPrefix: '9820785c', platform: 'darwin', arch: 'arm64',
      platformKey: 'darwin-arm64', assetName: 'archon-darwin-arm64',
      size: 100, sha256: 'a'.repeat(64), executablePath: '/tmp/fixture-archon',
    },
    workflowSource,
    commandRunner: {
      async run(_executable, args) {
        if (args[0] === 'workflow' && args[1] === 'run')
          return { exitCode: 0, stdout: JSON.stringify({ runId: 'native-fixture-1' }), stderr: '' };
        if (args[0] === 'workflow' && args[1] === 'get')
          return { exitCode: 0, stdout: JSON.stringify({ id: args[2], status: 'completed' }), stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const reference = await harness.startCanonical(request, { specPath, bridgePath, finalizerPath });
  assert.equal(reference.externalRunId, 'native-fixture-1');
  const changedSpec = { ...spec, revision: 'older-revision' };
  await writeFile(specPath, JSON.stringify(changedSpec));
  await assert.rejects(
    harness.startCanonical(request, { specPath, bridgePath, finalizerPath }),
    /does not match the frozen Temari request/,
  );
  await writeFile(specPath, JSON.stringify(spec));
  const finalizerRequest = { bridgePath, specPath, artifactsDirectory, nativeRunId: reference.externalRunId };
  await assert.rejects(finalizeCanonicalArchonReceipt(finalizerRequest), /investigate has no completed capture/);
  for (const stage of DEFAULT_STAGES)
    await runFile('bun', [bridgePath, 'capture', '--spec', specPath,
      '--artifacts', artifactsDirectory, '--workflow-id', reference.externalRunId,
      '--stage', stage]);
  const marker = await finalizeCanonicalArchonReceipt(finalizerRequest);
  assert.equal(marker.nativeRunId, reference.externalRunId);
  assert.deepEqual(await finalizeCanonicalArchonReceipt(finalizerRequest), marker);
  const archonReceipts = await FileWorkflowReceiptStore.openExisting(join(artifactsDirectory, 'temari-nx-canonical', 'receipts'));
  const archonEvidence = await FileEvidenceStore.openExisting(join(artifactsDirectory, 'temari-nx-canonical', 'evidence'));
  const archonReceipt = await archonReceipts.load(request.runId);
  assert.deepEqual(archonReceipt?.stages.map((stage) => stage.stage), DEFAULT_STAGES);
  const serialReceipts = await FileWorkflowReceiptStore.create(join(root, 'serial-receipts'));
  const serialEvidence = await FileEvidenceStore.create(join(root, 'serial-evidence'));
  await executeAndPersist({
    runId: 'serial-receipt-run', revision: request.revision, plan,
    capabilities: { host: 'fixture', available: [], missing: HOST_CAPABILITIES, notes: {} },
    store: serialReceipts, stageEvidence: { store: serialEvidence },
    handler: (stage) => ({ status: 'PASS', summary: `${stage} complete`, evidence: [
      { name: 'stdout', kind: 'stdout', content: `${stage}\n` },
      { name: 'stderr', kind: 'stderr', content: '' },
    ] }),
  });
  const bundle = await verifyDeterministicArchonReceiptParity({
    harness, reference,
    serial: { runId: 'serial-receipt-run', receipts: serialReceipts, evidence: serialEvidence },
    archon: { runId: request.runId, receipts: archonReceipts, evidence: archonEvidence },
  });
  assert.equal(bundle.nativeRun.externalRunId, 'native-fixture-1');
  assert.equal(bundle.archonReceipt.status, 'PASS');
  assert.equal(JSON.parse(await readFile(join(artifactsDirectory, 'temari-nx-canonical', 'completion.json'), 'utf8')).receiptSha256, marker.receiptSha256);
  assert.equal(JSON.parse(await readFile(join(artifactsDirectory, 'evidence.json'), 'utf8')).nativeRunId, reference.externalRunId);
  await writeFile(join(artifactsDirectory, 'temari-nx-canonical', 'stages', 'investigate.json'), '{}');
  await assert.rejects(finalizeCanonicalArchonReceipt(finalizerRequest));
  await assert.rejects(readFile(join(artifactsDirectory, 'evidence.json')), { code: 'ENOENT' });
});
