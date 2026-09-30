import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRequestPlan, deriveCloseout } from '@temari/temari-core';
import { minimalPlan, type WorkflowStageId } from '@temari/contracts';

import {
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
  executeAndPersist,
  executeRequestPlanAndPersist,
  executeScheduledAndPersist,
} from './runtime.js';
import { FileWorkflowRunStore } from './run-store.js';
import { FileEvidenceStore } from './evidence-store.js';
import { FileWorkspaceManifestStore } from './workspace-manifest.js';

const LIGHTWEIGHT_EVIDENCE = {
  resultIsClearLocalAndReversible: true,
  changesSharedBoundary: false,
  isReportedDefect: false,
  hasUnexplainedSymptom: false,
  makesPerformanceClaim: false,
  isDesignChoice: false,
  isMigration: false,
  affectedCallersAreKnown: true,
  crossesArchitecturalBoundary: false,
  directCheckAvailable: true,
} as const;

test('persists and reloads a revision-bound receipt idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const canonicalRoot = await realpath(root);
    const receipt = await executeAndPersist({
      runId: 'run-1',
      revision: 'revision-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: (stage) => ({ status: 'PASS', summary: `${stage} complete` }),
    });

    const path = await store.save(receipt);
    assert.equal(path, join(canonicalRoot, 'run-1.receipt.json'));
    assert.deepEqual(await store.load('run-1'), receipt);
    assert.equal(
      (await readFile(path, 'utf8')).includes(receipt.revision),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes a coordinator-produced serial request through the persisted engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
    const requestPlan = createRequestPlan({
      workType: 'feature',
      lightweight: LIGHTWEIGHT_EVIDENCE,
    });
    const stages: WorkflowStageId[] = [];
    const receipt = await executeRequestPlanAndPersist({
      runId: 'request-plan-1',
      revision: 'revision-request-plan-1',
      requestPlan,
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: (stage) => {
        stages.push(stage);
        return {
          status: 'PASS',
          summary: `${stage} complete`,
          evidencePaths: [`evidence/${stage}.json`],
        };
      },
    });

    assert.equal(receipt.status, 'PASS');
    assert.deepEqual(stages, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.deepEqual(await store.load('request-plan-1'), receipt);

    const evidenceStore = await FileEvidenceStore.create(
      join(root, 'evidence'),
    );
    const evidence = await evidenceStore.put({
      runId: 'request-plan-1',
      revision: 'revision-request-plan-1',
      kind: 'verification',
      content: 'all six stages completed\n',
    });
    assert.equal(deriveCloseout(receipt, [evidence]).status, 'ready');
    assert.deepEqual(
      await evidenceStore.load(evidence),
      Buffer.from('all six stages completed\n'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a planning-only program before serial execution or persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
    const requestPlan = createRequestPlan({
      workType: 'migration',
      lightweight: LIGHTWEIGHT_EVIDENCE,
      programKind: 'orchestrate',
    });
    let handlerCalls = 0;
    await assert.rejects(
      executeRequestPlanAndPersist({
        runId: 'program-1',
        revision: 'revision-program-1',
        requestPlan,
        capabilities: serialCapabilities(),
        store,
        handler: () => {
          handlerCalls += 1;
          return { status: 'PASS', summary: 'must not execute' };
        },
      }),
      /planning-only/,
    );
    assert.equal(handlerCalls, 0);
    assert.equal(await store.load('program-1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stops a coordinator-produced QA request before serial execution lacks review capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
    const requestPlan = createRequestPlan({
      workType: 'qa',
      lightweight: LIGHTWEIGHT_EVIDENCE,
      qaResponsibility: 'ticket-coverage',
    });
    let handlerCalls = 0;
    const receipt = await executeRequestPlanAndPersist({
      runId: 'request-plan-2',
      revision: 'revision-request-plan-2',
      requestPlan,
      capabilities: serialCapabilities(),
      store,
      handler: () => {
        handlerCalls += 1;
        return { status: 'PASS', summary: 'must not execute' };
      },
    });

    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(handlerCalls, 0);
    assert.deepEqual(receipt.failure?.missingCapabilities, ['subagents']);
    assert.deepEqual(await store.load('request-plan-2'), receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists blocked capability gaps instead of losing the reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const receipt = await executeAndPersist({
      runId: 'run-2',
      revision: 'revision-2',
      plan: { ...minimalPlan('feature'), requiredCapabilities: ['forge'] },
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'must not run' }),
    });

    assert.equal(receipt.status, 'BLOCKED');
    assert.deepEqual(
      (await store.load('run-2'))?.failure?.missingCapabilities,
      ['forge'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a different receipt for an existing run ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const receipt = await executeAndPersist({
      runId: 'run-3',
      revision: 'revision-3',
      plan: minimalPlan('bug'),
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'complete' }),
    });

    await assert.rejects(
      store.save({ ...receipt, revision: 'different-revision' }),
      /collision or mutation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes a revision through the run lease and closes with a receipt status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-1',
      revision: 'revision-scheduled-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'complete' }),
    });

    assert.equal(result.claimed, true);
    assert.equal(result.receipt?.status, 'PASS');
    assert.equal(result.record.status, 'SUCCEEDED');
    assert.equal((await runStore.events('scheduled-1')).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renews the parent lease while a scheduled revision is still executing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    let firstStage = true;
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-renew-1',
      revision: 'revision-scheduled-renew-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      // Keep the renewal assertion, but leave enough scheduling headroom for
      // Windows filesystem work and CI startup contention.
      leaseMs: 1_000,
      leaseRenewal: { intervalMs: 20 },
      handler: async () => {
        if (firstStage) {
          firstStage = false;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return { status: 'PASS' as const, summary: 'complete' };
      },
    });

    assert.equal(result.claimed, true);
    assert.equal(result.record.status, 'SUCCEEDED');
    assert(
      (await runStore.events('scheduled-renew-1')).some(
        (event) => event.type === 'run-lease-renewed',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('honors a durable active-run cancellation request at completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    let requested = false;
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-cancel-1',
      revision: 'revision-scheduled-cancel-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      cancellation: { onRequested: 'cancel-before-completion' },
      handler: async () => {
        if (!requested) {
          requested = true;
          await runStore.cancel({
            runId: 'scheduled-cancel-1',
            actor: 'coordinator',
            idempotencyKey: 'cancel:scheduled-cancel-1',
          });
        }
        return { status: 'PASS' as const, summary: 'handler completed' };
      },
    });

    assert.equal(result.claimed, true);
    assert.equal(result.receipt?.status, 'PASS');
    assert.equal(result.record.status, 'CANCELLED');
    assert.deepEqual(
      (await runStore.events('scheduled-cancel-1')).map((event) => event.type),
      [
        'run-created',
        'run-claimed',
        'run-event',
        'run-cancellation-requested',
        'run-status-changed',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not start a duplicate while a lease is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    await runStore.create({
      runId: 'scheduled-2',
      revision: 'revision-scheduled-2',
      actor: 'worker-a',
      now: new Date('2026-09-22T12:00:00.000Z'),
    });
    await runStore.claim({
      runId: 'scheduled-2',
      owner: 'worker-a',
      leaseMs: 30_000,
      now: new Date('2026-09-22T12:00:01.000Z'),
    });
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-2',
      revision: 'revision-scheduled-2',
      plan: minimalPlan('bug'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'must not execute' }),
    });

    assert.equal(result.claimed, false);
    assert.equal(result.receipt, null);
    assert.equal(await receiptStore.load('scheduled-2'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stores immutable content-addressed evidence and verifies it on reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileEvidenceStore.create(root);
    const reference = await store.put({
      runId: 'evidence-1',
      revision: 'revision-evidence-1',
      kind: 'stdout',
      content: 'verification output\n',
    });
    const replay = await store.put({
      runId: 'evidence-1',
      revision: 'revision-evidence-1',
      kind: 'stdout',
      content: 'verification output\n',
    });

    assert.equal(reference.sha256, replay.sha256);
    assert.deepEqual(
      await store.load(reference),
      Buffer.from('verification output\n'),
    );
    assert.deepEqual(
      await store.loadPortable({
        schema: 1,
        runId: reference.runId,
        revision: reference.revision,
        kind: reference.kind,
        sha256: reference.sha256,
        bytes: reference.bytes,
      }),
      Buffer.from('verification output\n'),
    );
    await assert.rejects(
      store.load({ ...reference, sha256: '0'.repeat(64) }),
      /Evidence hash changed|Evidence path is outside|ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resumes from durable stage checkpoints after final receipt publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const checkpointStore = await FileWorkflowCheckpointStore.create(
      join(root, 'checkpoints'),
    );
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    let failPublication = true;
    let handlerCalls = 0;
    const request = {
      runId: 'checkpoint-runtime-1',
      revision: 'revision-checkpoint-runtime-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      checkpointStore,
      now: sequenceClock(),
      handler: (stage: WorkflowStageId) => {
        handlerCalls += 1;
        return { status: 'PASS' as const, summary: `${stage} complete` };
      },
    };

    await assert.rejects(
      executeAndPersist({
        ...request,
        store: {
          save: async () => {
            if (failPublication) {
              failPublication = false;
              throw new Error('receipt publication interrupted');
            }
            return 'unused';
          },
          load: async () => null,
        },
      }),
      /receipt publication interrupted/,
    );
    assert.equal((await checkpointStore.load(request.runId))?.stages.length, 6);
    assert.equal(handlerCalls, 6);

    const receipt = await executeAndPersist({
      ...request,
      store: receiptStore,
    });

    assert.equal(receipt.status, 'PASS');
    assert.equal(handlerCalls, 6, 'completed stages must not be replayed');
    assert.deepEqual(
      (await receiptStore.load(request.runId))?.stages,
      receipt.stages,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes serial stage manifests and verifies them before checkpoint resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const checkpointStore = await FileWorkflowCheckpointStore.create(
      join(root, 'checkpoints'),
    );
    const receiptStore = await FileWorkflowReceiptStore.create(
      join(root, 'receipts'),
    );
    const manifestStore = await FileWorkspaceManifestStore.create(
      join(root, 'manifests'),
    );
    const plan = minimalPlan('feature');
    const stageRoots = new Map<WorkflowStageId, string>();
    for (const stage of plan.stages) {
      const stageRoot = join(root, 'workspaces', stage);
      await mkdir(stageRoot, { recursive: true });
      stageRoots.set(stage, stageRoot);
    }
    let failPublication = true;
    let handlerCalls = 0;
    const request = {
      runId: 'serial-workspace-1',
      revision: 'revision-serial-workspace-1',
      plan,
      capabilities: serialCapabilities(),
      checkpointStore,
      workspaceManifestStore: manifestStore,
      workspaceForStage: (stage: WorkflowStageId) => ({
        workspaceId: `workspace-${stage}`,
        root: stageRoots.get(stage) as string,
      }),
      now: sequenceClock(),
      handler: async (stage: WorkflowStageId) => {
        handlerCalls += 1;
        await writeFile(
          join(stageRoots.get(stage) as string, 'result.txt'),
          `${stage}\n`,
        );
        return { status: 'PASS' as const, summary: `${stage} complete` };
      },
    };

    await assert.rejects(
      executeAndPersist({
        ...request,
        store: {
          save: async () => {
            if (failPublication) {
              failPublication = false;
              throw new Error('receipt publication interrupted');
            }
            return 'unused';
          },
          load: async () => null,
        },
      }),
      /receipt publication interrupted/,
    );
    assert.equal(handlerCalls, plan.stages.length);
    assert.equal(
      (await manifestStore.load(request.runId, 'investigate'))?.workspaceId,
      'workspace-investigate',
    );
    assert.equal(
      (await checkpointStore.load(request.runId))?.stages.at(-1)
        ?.workspaceManifestId,
      'deliver',
    );

    await writeFile(
      join(stageRoots.get('investigate') as string, 'result.txt'),
      'changed\n',
    );
    await assert.rejects(
      executeAndPersist({ ...request, store: receiptStore }),
      /Workspace manifest changed|Workspace file changed/,
    );
    assert.equal(handlerCalls, plan.stages.length);

    await writeFile(
      join(stageRoots.get('investigate') as string, 'result.txt'),
      'investigate\n',
    );
    const receipt = await executeAndPersist({
      ...request,
      store: receiptStore,
    });
    assert.equal(receipt.status, 'PASS');
    assert.equal(handlerCalls, plan.stages.length);
    assert.deepEqual(
      receipt.stages.map((stage) => stage.workspaceManifestId),
      plan.stages,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('captures, persists, reloads, and verifies a portable workspace manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    await mkdir(join(workspaceRoot, 'nested'), { recursive: true });
    await writeFile(join(workspaceRoot, 'README.md'), 'workspace\n');
    await writeFile(join(workspaceRoot, 'nested', 'result.txt'), 'result\n');
    const store = await FileWorkspaceManifestStore.create(
      join(root, 'manifests'),
    );
    const manifest = await store.capture({
      runId: 'manifest-1',
      revision: 'revision-manifest-1',
      subjectId: 'worker-1',
      workspaceId: 'workspace-a',
      workspaceRoot,
      now: new Date('2026-09-24T12:00:00.000Z'),
    });

    assert.deepEqual(
      manifest.entries.map((entry) => entry.path),
      ['README.md', 'nested/result.txt'],
    );
    const path = await store.save(manifest);
    assert.equal(
      path,
      join(
        await realpath(join(root, 'manifests')),
        'manifest-1.worker-1.workspace.json',
      ),
    );
    assert.deepEqual(await store.load('manifest-1', 'worker-1'), manifest);
    await store.verify(manifest, workspaceRoot);

    await writeFile(join(workspaceRoot, 'README.md'), 'changed\n');
    await assert.rejects(
      store.verify(manifest, workspaceRoot),
      /Workspace manifest changed|Workspace file changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a conflicting workspace manifest for the same run subject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'result.txt'), 'one\n');
    const store = await FileWorkspaceManifestStore.create(
      join(root, 'manifests'),
    );
    const manifest = await store.capture({
      runId: 'manifest-2',
      revision: 'revision-manifest-2',
      subjectId: 'worker-2',
      workspaceId: 'workspace-b',
      workspaceRoot,
    });
    await store.save(manifest);
    await assert.rejects(
      store.save({ ...manifest, workspaceId: 'different-workspace' }),
      /collision or mutation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function serialCapabilities() {
  return {
    host: 'generic',
    available: [],
    missing: [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ] as const,
    notes: {},
  };
}

function sequenceClock(): () => Date {
  let count = 0;
  const start = new Date('2026-09-22T12:00:00.000Z').getTime();
  return () => new Date(start + count++ * 1000);
}
