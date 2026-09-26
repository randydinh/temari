import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_STAGES,
  HOST_CAPABILITIES,
  minimalPlan,
  type WorkflowReceipt,
} from '@temari/contracts';
import {
  runPlanWithReceipt,
  type WorkflowCheckpoint,
} from '@temari/workflow-engine';
import {
  executeAndPersist,
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
} from './runtime.js';
import { FileEvidenceStore } from './evidence-store.js';
import { verifyPersistedStageEvidence } from './stage-evidence.js';

const outputs = [
  'investigated input',
  'planned work',
  'built output',
  'reviewed result',
  'verified checks',
  'delivered evidence',
];

async function fixture(t: TestContext, sameBytes = false) {
  const root = await mkdtemp(join(tmpdir(), 'temari-stage-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
  const evidenceStore = await FileEvidenceStore.create(join(root, 'evidence'));
  const checkpointStore = await FileWorkflowCheckpointStore.create(
    join(root, 'checkpoints'),
  );
  const request = {
    runId: 'stage-evidence-run',
    revision: 'stable-run-revision',
    plan: minimalPlan('feature'),
    capabilities: {
      host: 'fixture',
      available: [],
      missing: HOST_CAPABILITIES,
      notes: {},
    },
    store,
    checkpointStore,
    stageEvidence: { store: evidenceStore },
    handler: (stage: (typeof DEFAULT_STAGES)[number]) => ({
      status: 'PASS' as const,
      summary: `${stage} summary`,
      evidence: [
        {
          name: 'result',
          kind: 'verification' as const,
          content: sameBytes
            ? 'same bytes'
            : outputs[DEFAULT_STAGES.indexOf(stage)],
        },
      ],
    }),
  };
  const verify = async (receipt?: WorkflowReceipt) =>
    verifyPersistedStageEvidence({
      runId: request.runId,
      revision: request.revision,
      store: receipt
        ? { save: async () => '', load: async () => receipt }
        : await FileWorkflowReceiptStore.create(join(root, 'receipts')),
      evidenceStore: await FileEvidenceStore.create(join(root, 'evidence')),
    });
  return { root, store, evidenceStore, checkpointStore, request, verify };
}

test('publishes all six distinct stage payloads and verifies via new store instances', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  assert.equal(receipt.evidenceProfile, 'stage-evidence-v1');
  const verified = await f.verify();
  assert.equal(verified.status, 'evidence-verified');
  assert.equal(verified.scope, 'persisted-stage-evidence-only');
  assert.equal('ready' in verified, false);
  assert.deepEqual(
    verified.stages.map((s) => s.stage),
    DEFAULT_STAGES,
  );
  assert.deepEqual(
    verified.stages.map((s) => Buffer.from(s.payloads[0].content).toString()),
    outputs,
  );
  assert.equal(
    new Set(receipt.stages.map((s) => s.stageEvidence?.sha256)).size,
    6,
  );
});

test('identical payload bytes across stages remain legitimate with distinct attestations', async (t) => {
  const f = await fixture(t, true);
  const receipt = await executeAndPersist(f.request);
  const verified = await f.verify();
  assert(
    verified.stages.every(
      (s) => Buffer.from(s.payloads[0].content).toString() === 'same bytes',
    ),
  );
  assert.equal(
    new Set(receipt.stages.map((s) => s.stageEvidence?.sha256)).size,
    6,
  );
});

test('rejects malformed persisted coverage, identities, profile and contextual bindings', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const mutations: Record<string, (r: any) => void> = {
    missingStage: (r) => r.stages.pop(),
    duplicateStage: (r) => (r.stages[1] = r.stages[0]),
    unsupportedProfile: (r) => (r.evidenceProfile = 'stage-evidence-v2'),
    absentProfile: (r) => delete r.evidenceProfile,
    unsupportedSchema: (r) => (r.schema = 2),
    wrongRun: (r) => (r.runId = 'other'),
    wrongRevision: (r) => (r.revision = 'other'),
    missingBinding: (r) => delete r.stages[0].stageEvidence,
    unsupportedBinding: (r) => (r.stages[0].stageEvidence.schema = 2),
    swappedBinding: (r) =>
      (r.stages[0].stageEvidence = r.stages[1].stageEvidence),
    badDigest: (r) => (r.stages[0].stageEvidence.sha256 = '../x'),
    badSize: (r) => (r.stages[0].stageEvidence.bytes = -1),
    nonPass: (r) => (r.stages[0].status = 'ISSUES'),
    changedSummary: (r) => (r.stages[0].summary = 'changed'),
    changedManifest: (r) => (r.stages[0].workspaceManifestId = 'other'),
    badTimestamp: (r) => (r.stages[0].startedAt = null),
    badPaths: (r) => (r.stages[0].evidencePaths = null),
    badPlan: (r) => r.plan.stages.reverse(),
    failure: (r) => (r.failure = {}),
    nullStage: (r) => (r.stages[0] = null),
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const changed = structuredClone(receipt);
      mutate(changed);
      await assert.rejects(f.verify(changed));
    });
  await f.verify();
});

test('strictly decodes contextual attestations and each payload reference', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const original = JSON.parse(
    await readFile(
      join(
        f.root,
        'evidence',
        `${receipt.stages[0].stageEvidence!.sha256}.artifact`,
      ),
      'utf8',
    ),
  );
  const mutations: Record<string, (a: any) => void> = {
    version: (a) => (a.schema = 2),
    wrongRun: (a) => (a.runId = 'other'),
    wrongRevision: (a) => (a.revision = 'other'),
    wrongStage: (a) => (a.stage = 'build'),
    wrongStatus: (a) => (a.status = 'ISSUES'),
    missingPayload: (a) => (a.payloads = []),
    duplicateName: (a) => a.payloads.push(a.payloads[0]),
    extraField: (a) => (a.extra = true),
    payloadExtra: (a) => (a.payloads[0].reference.path = '/outside'),
    payloadVersion: (a) => (a.payloads[0].reference.schema = 2),
    payloadRun: (a) => (a.payloads[0].reference.runId = 'other'),
    payloadRevision: (a) => (a.payloads[0].reference.revision = 'other'),
    payloadKind: (a) => (a.payloads[0].reference.kind = 'invalid'),
    payloadName: (a) => (a.payloads[0].name = ''),
    payloadSize: (a) => (a.payloads[0].reference.bytes = 1.2),
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const attestation = structuredClone(original);
      mutate(attestation);
      const ref = await f.evidenceStore.put({
        runId: f.request.runId,
        revision: f.request.revision,
        kind: 'other',
        content: JSON.stringify(attestation),
      });
      const changed: any = structuredClone(receipt);
      changed.stages[0].stageEvidence = {
        schema: ref.schema,
        sha256: ref.sha256,
        bytes: ref.bytes,
      };
      await assert.rejects(f.verify(changed));
    });
});

test('missing and same-length modified attestation or payload fails, restoration succeeds', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const attestationPath = join(
    f.root,
    'evidence',
    `${receipt.stages[0].stageEvidence!.sha256}.artifact`,
  );
  const attestation = JSON.parse(await readFile(attestationPath, 'utf8'));
  const payloadPath = join(
    f.root,
    'evidence',
    `${attestation.payloads[0].reference.sha256}.artifact`,
  );
  for (const path of [attestationPath, payloadPath]) {
    const bytes = await readFile(path);
    await unlink(path);
    await assert.rejects(f.verify());
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    await writeFile(path, changed);
    await assert.rejects(f.verify(), /hash/);
    await writeFile(path, bytes);
    await f.verify();
  }
});

test('runtime rejects duplicate payload names and handler-supplied bindings before acknowledgment', async (t) => {
  for (const variant of ['duplicate', 'raw', 'missing'] as const)
    await t.test(variant, async (t) => {
      const f = await fixture(t);
      const receipt = await executeAndPersist({
        ...f.request,
        handler: (stage) => {
          const result = f.request.handler(stage);
          if (variant === 'duplicate')
            return {
              ...result,
              evidence: [result.evidence[0], result.evidence[0]],
            };
          if (variant === 'raw')
            return {
              ...result,
              stageEvidence: { schema: 1, sha256: 'a'.repeat(64), bytes: 1 },
            };
          return { ...result, evidence: undefined };
        },
      });
      assert.equal(receipt.status, 'BLOCKED');
      assert.equal(await f.checkpointStore.load(f.request.runId), null);
      await assert.rejects(f.verify());
    });
});

test('partial and complete resume reverify evidence before handlers or final publication', async (t) => {
  for (const count of [3, 6])
    await t.test(`${count} acknowledged stages`, async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          onStageCheckpoint: (checkpoint) => {
            if (checkpoint.stages.length === count)
              throw new Error('interrupted');
          },
        }),
        /interrupted/,
      );
      const checkpoint = (await f.checkpointStore.load(f.request.runId))!;
      assert.equal(await f.store.load(f.request.runId), null);
      let effects = 0;
      const resume = {
        ...f.request,
        handler: (stage: (typeof DEFAULT_STAGES)[number]) => {
          effects++;
          return f.request.handler(stage);
        },
      };
      const path = join(
        f.root,
        'evidence',
        `${checkpoint.stages[0].stageEvidence!.sha256}.artifact`,
      );
      const original = await readFile(path);
      await unlink(path);
      await assert.rejects(executeAndPersist(resume));
      const changed = Buffer.from(original);
      changed[0] ^= 1;
      await writeFile(path, changed);
      await assert.rejects(executeAndPersist(resume), /hash/);
      assert.equal(effects, 0);
      assert.equal(await f.store.load(f.request.runId), null);
      await writeFile(path, original);
      for (const mutation of ['omit', 'unknown', 'mixed'] as const) {
        const altered: any = structuredClone(checkpoint);
        if (mutation === 'omit') delete altered.evidenceProfile;
        if (mutation === 'unknown')
          altered.evidenceProfile = 'stage-evidence-v2';
        if (mutation === 'mixed') delete altered.stages[0].stageEvidence;
        await assert.rejects(
          executeAndPersist({
            ...resume,
            checkpointStore: undefined,
            checkpoint: altered,
          }),
        );
      }
      await assert.rejects(
        executeAndPersist({ ...resume, stageEvidence: undefined }),
        /profile/,
      );
      assert.equal(effects, 0);
      assert.equal(await f.store.load(f.request.runId), null);
      const receipt = await executeAndPersist(resume);
      assert.equal(effects, 6 - count);
      assert.deepEqual(receipt.stages.slice(0, count), checkpoint.stages);
      await f.verify();
    });
});

test('engine rejects profile upgrades, downgrades, unknown versions and mixed completed prefixes', async (t) => {
  const f = await fixture(t);
  await executeAndPersist(f.request);
  const bound = (await f.checkpointStore.load(f.request.runId))!;
  const legacy: any = structuredClone(bound);
  delete legacy.evidenceProfile;
  for (const stage of legacy.stages) delete stage.stageEvidence;
  let effects = 0;
  const run = (checkpoint: WorkflowCheckpoint, evidenceProfile?: any) =>
    runPlanWithReceipt({
      ...f.request,
      checkpoint,
      evidenceProfile,
      handler: () => {
        effects++;
        return { status: 'PASS', summary: '' };
      },
    });
  await assert.rejects(run(bound), /profile/);
  await assert.rejects(run(legacy, 'stage-evidence-v1'), /profile/);
  await assert.rejects(run(bound, 'unknown'), /profile/);
  const mixed: any = structuredClone(bound);
  delete mixed.stages[0].stageEvidence;
  await assert.rejects(run(mixed, 'stage-evidence-v1'), /reference/);
  const hidden: any = structuredClone(bound);
  delete hidden.evidenceProfile;
  await assert.rejects(run(hidden), /profile/);
  assert.equal(effects, 0);
  const result = await run(legacy);
  assert.equal('evidenceProfile' in result, false);
  assert(result.stages.every((s) => !('stageEvidence' in s)));
});

test('payload count and aggregate size are bounded before publication or payload loading', async (t) => {
  const f = await fixture(t);
  let puts = 0;
  const store = {
    put: async (...args: Parameters<typeof f.evidenceStore.put>) => {
      puts++;
      return f.evidenceStore.put(...args);
    },
    load: f.evidenceStore.load.bind(f.evidenceStore),
    loadPortable: f.evidenceStore.loadPortable.bind(f.evidenceStore),
  };
  for (const evidence of [
    Array.from({ length: 33 }, (_, i) => ({
      name: `${i}`,
      kind: 'other' as const,
      content: '',
    })),
    [
      {
        name: 'large',
        kind: 'other' as const,
        content: new Uint8Array(16 * 1024 * 1024),
      },
      { name: 'overflow', kind: 'other' as const, content: 'x' },
    ],
  ]) {
    const result = await executeAndPersist({
      ...f.request,
      runId: `limit-${evidence.length}`,
      stageEvidence: { store },
      handler: () => ({ status: 'PASS', summary: '', evidence }),
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(puts, 0);
  }
  const receipt = await executeAndPersist(f.request);
  const original = JSON.parse(
    await readFile(
      join(
        f.root,
        'evidence',
        `${receipt.stages[0].stageEvidence!.sha256}.artifact`,
      ),
      'utf8',
    ),
  );
  for (const variant of ['count', 'bytes']) {
    const attestation = structuredClone(original);
    attestation.payloads = Array.from(
      { length: variant === 'count' ? 33 : 2 },
      (_, index) => ({
        name: `${index}`,
        reference: {
          ...original.payloads[0].reference,
          bytes: 16 * 1024 * 1024,
        },
      }),
    );
    const stored = await f.evidenceStore.put({
      runId: f.request.runId,
      revision: f.request.revision,
      kind: 'other',
      content: JSON.stringify(attestation),
    });
    const changed: any = structuredClone(receipt);
    changed.stages[0].stageEvidence = {
      schema: 1,
      sha256: stored.sha256,
      bytes: stored.bytes,
    };
    let loads = 0;
    await assert.rejects(
      verifyPersistedStageEvidence({
        runId: f.request.runId,
        revision: f.request.revision,
        store: { save: async () => '', load: async () => changed },
        evidenceStore: {
          ...store,
          loadPortable: async (ref) => {
            loads++;
            return f.evidenceStore.loadPortable(ref);
          },
        },
      }),
      /32 payloads|total exceeds/,
    );
    assert.equal(loads, 1);
  }
});

test('final publication rechecks earlier acknowledged evidence after later handlers', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      handler: async (stage) => {
        if (stage === 'deliver') {
          const checkpoint = (await f.checkpointStore.load(f.request.runId))!;
          await unlink(
            join(
              f.root,
              'evidence',
              `${checkpoint.stages[0].stageEvidence!.sha256}.artifact`,
            ),
          );
        }
        return f.request.handler(stage);
      },
    }),
  );
  assert.equal(await f.store.load(f.request.runId), null);
});

test('publication refuses store-substituted payloads, kinds, and attestations before acknowledgment', async (t) => {
  for (const variant of [
    'payload',
    'kind',
    'attestation',
    'mutated-input',
  ] as const) {
    await t.test(variant, async (t) => {
      const f = await fixture(t);
      const evidenceStore = {
        put: async (request: Parameters<typeof f.evidenceStore.put>[0]) => {
          if (request.kind === 'verification') {
            if (variant === 'payload') {
              return f.evidenceStore.put({
                ...request,
                content: 'substituted',
              });
            }
            if (variant === 'kind') {
              return f.evidenceStore.put({ ...request, kind: 'stdout' });
            }
            if (
              variant === 'mutated-input' &&
              request.content instanceof Uint8Array
            ) {
              request.content[0] ^= 1;
            }
          }
          if (variant === 'attestation' && request.kind === 'other') {
            const record = JSON.parse(
              typeof request.content === 'string'
                ? request.content
                : Buffer.from(request.content).toString('utf8'),
            );
            const altered = await f.evidenceStore.put({
              runId: request.runId,
              revision: request.revision,
              kind: 'verification',
              content: 'substituted',
            });
            const { path: _path, ...reference } = altered;
            record.payloads[0].reference = reference;
            return f.evidenceStore.put({
              ...request,
              content: JSON.stringify(record),
            });
          }
          return f.evidenceStore.put(request);
        },
        load: f.evidenceStore.load.bind(f.evidenceStore),
        loadPortable: f.evidenceStore.loadPortable.bind(f.evidenceStore),
      };
      const receipt = await executeAndPersist({
        ...f.request,
        stageEvidence: { store: evidenceStore },
      });
      assert.equal(receipt.status, 'BLOCKED');
      assert.equal(receipt.stages.length, 1);
      assert.match(
        receipt.failure!.message,
        /Evidence publication .* mismatch/,
      );
      assert.equal(await f.checkpointStore.load(f.request.runId), null);
      await assert.rejects(f.verify());
    });
  }
});

test('invalid verifier identity is rejected before contacting the receipt store', async (t) => {
  const f = await fixture(t);
  let loads = 0;
  for (const identity of [
    { runId: '../invalid', revision: 'r1' },
    { runId: 'valid', revision: '' },
  ]) {
    await assert.rejects(
      verifyPersistedStageEvidence({
        ...identity,
        store: {
          save: async () => '',
          load: async () => {
            loads++;
            return null;
          },
        },
        evidenceStore: f.evidenceStore,
      }),
    );
  }
  assert.equal(loads, 0);
});
