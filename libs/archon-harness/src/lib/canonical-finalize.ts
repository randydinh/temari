import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_STAGES, HOST_CAPABILITIES, type ExecutionPlan } from '@temari/contracts';
import {
  executeAndPersist,
  FileEvidenceStore,
  FileWorkflowReceiptStore,
  verifyPersistedStageEvidence,
} from '@temari/runtime';

const runFile = promisify(execFile);

export interface CanonicalFinalizeRequest {
  readonly bridgePath: string;
  readonly specPath: string;
  readonly artifactsDirectory: string;
  readonly nativeRunId: string;
}

interface CanonicalSpec {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly repositoryRoot: string;
  readonly plan: ExecutionPlan;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decoded(value: unknown): Uint8Array {
  assert(typeof value === 'string' && value.length <= 90_000);
  const bytes = Buffer.from(value, 'base64');
  assert.equal(bytes.toString('base64'), value, 'Invalid sealed output encoding.');
  return bytes;
}

/** Publish canonical Nx receipt only after the installed bridge verifies all six captures. */
export async function finalizeCanonicalArchonReceipt(
  request: CanonicalFinalizeRequest,
): Promise<{ readonly runId: string; readonly revision: string; readonly nativeRunId: string; readonly receiptSha256: string }> {
  assert(isAbsolute(request.bridgePath), 'Bridge path must be absolute.');
  assert(isAbsolute(request.specPath), 'Spec path must be absolute.');
  assert(isAbsolute(request.artifactsDirectory), 'Artifacts path must be absolute.');
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.nativeRunId));
  const nativeEvidencePath = join(resolve(request.artifactsDirectory), 'evidence.json');
  await rm(nativeEvidencePath, { force: true });
  const specBytes = await readFile(request.specPath);
  const spec = JSON.parse(specBytes.toString('utf8')) as CanonicalSpec;
  assert.equal(spec.schema, 1);
  assert.deepEqual(spec.plan.stages, DEFAULT_STAGES);
  const { stdout } = await runFile('bun', [
    request.bridgePath,
    'verify',
    '--spec', request.specPath,
    '--artifacts', request.artifactsDirectory,
    '--workflow-id', request.nativeRunId,
  ], { maxBuffer: 2 * 1024 * 1024 });
  const verified = JSON.parse(stdout) as {
    binding: { nativeRunId: string; runId: string; revision: string; planSha256: string; specSha256: string };
    stages: { stage: string; summary: string; stdoutBase64: string; stderrBase64: string }[];
  };
  assert.equal(verified.binding.nativeRunId, request.nativeRunId);
  assert.equal(verified.binding.runId, spec.runId);
  assert.equal(verified.binding.revision, spec.revision);
  assert.equal(verified.binding.planSha256, sha256(canonical(spec.plan)));
  assert.equal(verified.binding.specSha256, sha256(specBytes));
  assert.deepEqual(verified.stages.map((stage) => stage.stage), DEFAULT_STAGES);
  const results = verified.stages.map((stage) => ({
    summary: stage.summary,
    stdout: decoded(stage.stdoutBase64),
    stderr: decoded(stage.stderrBase64),
  }));
  const root = join(resolve(request.artifactsDirectory), 'temari-nx-canonical');
  const receipts = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  let receipt = await receipts.load(spec.runId);
  if (receipt === null) {
    receipt = await executeAndPersist({
      runId: spec.runId,
      revision: spec.revision,
      plan: spec.plan,
      capabilities: {
        host: 'archon-deterministic-fixture',
        available: [],
        missing: HOST_CAPABILITIES,
        notes: {},
      },
      store: receipts,
      stageEvidence: { store: evidence },
      handler: (stage) => {
        const result = results[DEFAULT_STAGES.indexOf(stage)]!;
        return {
          status: 'PASS',
          summary: result.summary,
          evidence: [
            { name: 'stdout', kind: 'stdout', content: result.stdout },
            { name: 'stderr', kind: 'stderr', content: result.stderr },
          ],
        };
      },
    });
  }
  assert.equal(receipt.revision, spec.revision, 'Persisted receipt is stale.');
  assert.equal(sha256(canonical(receipt.plan)), verified.binding.planSha256);
  assert.equal(receipt.status, 'PASS', 'Canonical receipt did not pass.');
  assert.deepEqual(receipt.stages.map((stage) => stage.summary), results.map((stage) => stage.summary));
  const verifiedReceipt = await verifyPersistedStageEvidence({ runId: spec.runId, revision: spec.revision, store: receipts, evidenceStore: evidence });
  for (let index = 0; index < results.length; index++) {
    const payloads = verifiedReceipt.stages[index]!.payloads;
    assert.deepEqual(payloads.map((payload) => [payload.name, payload.kind]), [['stdout', 'stdout'], ['stderr', 'stderr']], 'Persisted stage payload mapping changed.');
    assert.deepEqual(payloads[0]!.content, results[index]!.stdout, 'Persisted stdout differs from native capture.');
    assert.deepEqual(payloads[1]!.content, results[index]!.stderr, 'Persisted stderr differs from native capture.');
  }
  const marker = { runId: spec.runId, revision: spec.revision, nativeRunId: request.nativeRunId, receiptSha256: sha256(canonical(receipt)) };
  const markerPath = join(root, 'completion.json');
  try {
    await writeFile(markerPath, JSON.stringify(marker), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), marker, 'Completion marker changed.');
  }
  const nativeEvidence = {
    version: 1,
    kind: 'temari-nx-six-stage-receipt',
    ...marker,
    receipt: join('temari-nx-canonical', 'receipts', `${spec.runId}.receipt.json`),
  };
  try {
    await writeFile(nativeEvidencePath, JSON.stringify(nativeEvidence), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.deepEqual(JSON.parse(await readFile(nativeEvidencePath, 'utf8')), nativeEvidence, 'Native evidence marker changed.');
  }
  return marker;
}

async function main(args: string[]): Promise<void> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!['--bridge', '--spec', '--artifacts', '--workflow-id'].includes(flag) || !value || flags[flag]) throw new Error(`Invalid argument ${flag}.`);
    flags[flag] = value;
  }
  if (!flags['--bridge'] || !flags['--spec'] || !flags['--artifacts'] || !flags['--workflow-id']) throw new Error('Missing finalizer input.');
  console.log(JSON.stringify(await finalizeCanonicalArchonReceipt({
    bridgePath: flags['--bridge'], specPath: flags['--spec'],
    artifactsDirectory: flags['--artifacts'], nativeRunId: flags['--workflow-id'],
  })));
}

if (process.argv[1]?.endsWith('/canonical-finalize.ts'))
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
