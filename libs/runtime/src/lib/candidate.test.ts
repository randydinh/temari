import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_STAGES,
  HOST_CAPABILITIES,
  minimalPlan,
  type CandidateIdentity,
  type WorkflowReceipt,
  type WorkflowStageId,
} from '@temari/contracts';
import type { WorkflowCheckpoint } from '@temari/workflow-engine';
import { observeCandidate, type CandidateRunOptions } from './candidate.js';
import {
  executeAndPersist,
  executeScheduledAndPersist,
  verifyCandidateCloseout,
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
  type ExecuteAndPersistRequest,
  type ExecuteRequestPlanAndPersistRequest,
  type ExecuteScheduledAndPersistRequest,
} from './runtime.js';
import { FileEvidenceStore } from './evidence-store.js';
import { FileWorkflowRunStore, type WorkflowRunStore } from './run-store.js';
import {
  captureWorkspaceManifest,
  FileWorkspaceManifestStore,
} from './workspace-manifest.js';
import { verifyPersistedStageEvidence } from './stage-evidence.js';

type RequiredService =
  | 'checkpointStore'
  | 'stageEvidence'
  | 'workspaceManifestStore'
  | 'workspaceForStage';
type InvalidAdmissions<Request> = {
  [Key in RequiredService]: Omit<
    Extract<Request, { candidate: CandidateRunOptions }>,
    Key
  > extends Request
    ? Key
    : never;
}[RequiredService];
type AssertNever<T extends never> = T;
export type CandidateAdmissionChecks = [
  AssertNever<InvalidAdmissions<ExecuteAndPersistRequest>>,
  AssertNever<InvalidAdmissions<ExecuteRequestPlanAndPersistRequest>>,
  AssertNever<InvalidAdmissions<ExecuteScheduledAndPersistRequest>>,
];

async function fixture(t: TestContext, noOp = false) {
  const root = await mkdtemp(join(tmpdir(), 'temari-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = { scopeId: 'app', root: join(root, 'candidate') };
  await mkdir(scope.root);
  const file = join(scope.root, 'output.txt');
  await writeFile(file, 'A');
  const storage = join(root, 'storage');
  const store = await FileWorkflowReceiptStore.create(
    join(storage, 'receipts'),
  );
  const checkpointStore = await FileWorkflowCheckpointStore.create(
    join(storage, 'checkpoints'),
  );
  const evidenceStore = await FileEvidenceStore.create(
    join(storage, 'evidence'),
  );
  const workspaceManifestStore = await FileWorkspaceManifestStore.create(
    join(storage, 'manifests'),
  );
  const bindings = new Map<
    WorkflowStageId,
    { workspaceId: string; root: string }
  >();
  for (const stage of DEFAULT_STAGES) {
    const binding = { workspaceId: stage, root: join(root, 'stages', stage) };
    await mkdir(binding.root, { recursive: true });
    bindings.set(stage, binding);
  }
  const initial = await observeCandidate(scope);
  const calls: WorkflowStageId[] = [];
  const request = {
    runId: 'candidate-run',
    revision: 'stable-revision',
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
    workspaceManifestStore,
    workspaceForStage: (stage: WorkflowStageId) => bindings.get(stage)!,
    candidate: { scope, expectedInitial: initial, knownWriteRoots: [storage] },
    handler: async (stage: WorkflowStageId) => {
      calls.push(stage);
      if (stage === 'build' && !noOp) await writeFile(file, 'B');
      await writeFile(join(bindings.get(stage)!.root, 'result.txt'), stage);
      return {
        status: 'PASS' as const,
        summary: stage,
        evidence: [
          { name: 'result', kind: 'verification' as const, content: stage },
        ],
      };
    },
  } satisfies ExecuteAndPersistRequest;
  const reader = (
    expectedCurrent: CandidateIdentity,
    receipt?: WorkflowReceipt,
  ) => ({
    runId: request.runId,
    revision: request.revision,
    store: receipt
      ? { save: async () => '', load: async () => receipt }
      : store,
    evidenceStore,
    workspaceManifestStore,
    workspaceForStage: request.workspaceForStage,
    scope,
    knownWriteRoots: [storage],
    expectedCurrent,
  });
  const interrupt = async (length: number) => {
    await assert.rejects(
      executeAndPersist({
        ...request,
        onStageCheckpoint: (checkpoint) => {
          if (checkpoint.stages.length === length)
            throw new Error('interrupted');
        },
      }),
      /interrupted/,
    );
    const checkpoint = await checkpointStore.load(request.runId);
    assert(checkpoint);
    assert.equal(checkpoint.stages.length, length);
    assert.equal(await store.load(request.runId), null);
    return checkpoint;
  };
  const attestation = async (
    receipt: WorkflowReceipt | WorkflowCheckpoint,
    index: number,
  ) =>
    JSON.parse(
      await readFile(
        join(
          storage,
          'evidence',
          `${receipt.stages[index].stageEvidence!.sha256}.artifact`,
        ),
        'utf8',
      ),
    );
  return {
    root,
    scope,
    file,
    storage,
    initial,
    bindings,
    calls,
    request,
    reader,
    interrupt,
    attestation,
    store,
    checkpointStore,
    evidenceStore,
    workspaceManifestStore,
  };
}

test('candidate identity uses copied globally sorted path/content/mode tuples and unchanged manifest order', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.scope.root, 'a'));
  await writeFile(join(f.scope.root, 'a', 'z'), 'nested');
  await writeFile(join(f.scope.root, 'a.txt'), 'sibling');
  const manifest = await captureWorkspaceManifest({
    runId: 'observe',
    revision: 'v',
    subjectId: 'stage',
    workspaceId: 'scope',
    workspaceRoot: f.scope.root,
  });
  const paths = manifest.entries.map((e) => e.path);
  assert.deepEqual(paths, ['a/z', 'a.txt', 'output.txt']);
  const tuples = [...manifest.entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => [e.path, e.mode, e.bytes, e.sha256]);
  const original = await observeCandidate(f.scope);
  assert.equal(
    original.sha256,
    createHash('sha256')
      .update(JSON.stringify(['local-regular-files-v1', tuples]))
      .digest('hex'),
  );
  assert.deepEqual(
    manifest.entries.map((e) => e.path),
    paths,
  );
  assert.deepEqual(
    await observeCandidate({ ...f.scope, scopeId: 'other-logical-name' }),
    original,
  );
  await writeFile(f.file, 'X');
  assert.notDeepEqual(await observeCandidate(f.scope), original);
  await writeFile(f.file, 'A');
  await rename(f.file, join(f.scope.root, 'renamed.txt'));
  assert.notDeepEqual(await observeCandidate(f.scope), original);
  await rename(join(f.scope.root, 'renamed.txt'), f.file);
  assert.deepEqual(await observeCandidate(f.scope), original);
});

test(
  'candidate identity includes nine regular-file permission bits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    await chmod(f.file, 0o600);
    const initial = await observeCandidate(f.scope);
    await chmod(f.file, 0o640);
    assert.notDeepEqual(await observeCandidate(f.scope), initial);
    await chmod(f.file, 0o600);
    assert.deepEqual(await observeCandidate(f.scope), initial);
  },
);

for (const noOp of [false, true])
  test(`candidate build ${noOp ? 'may preserve A' : 'changes A to B without rewriting history'}`, async (t) => {
    const f = await fixture(t, noOp);
    const receipt = await executeAndPersist(f.request);
    assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.evidenceProfile, 'candidate-stage-evidence-v1');
    assert.deepEqual(receipt.candidateBinding, {
      scopeId: 'app',
      initial: f.initial,
    });
    const current = await observeCandidate(f.scope);
    assert.equal(current.sha256 === f.initial.sha256, noOp);
    for (let index = 0; index < 6; index++) {
      const record = await f.attestation(receipt, index);
      assert.equal(record.schema, 2);
      assert.deepEqual(record.candidate.binding, receipt.candidateBinding);
      assert.deepEqual(
        record.candidate.before,
        index <= 2 ? f.initial : current,
      );
      assert.deepEqual(record.candidate.after, index < 2 ? f.initial : current);
    }
    assert.deepEqual(await verifyCandidateCloseout(f.reader(current)), {
      status: 'candidate-verified',
      scope: 'local-regular-file-candidate-only',
      runId: f.request.runId,
      revision: f.request.revision,
      initial: f.initial,
      current,
    });
    await assert.rejects(
      verifyPersistedStageEvidence({
        ...f.request,
        evidenceStore: f.evidenceStore,
      }),
      /profile/,
    );
    const count = f.calls.length;
    await assert.rejects(executeAndPersist(f.request), /Terminal/);
    await assert.rejects(
      executeAndPersist({ ...f.request, candidate: undefined }),
      /Terminal/,
    );
    assert.equal(f.calls.length, count);
  });

for (const prefix of [0, 3, 6])
  test(`candidate resumes exact ${prefix}-stage durable prefix`, async (t) => {
    const f = await fixture(t);
    if (prefix === 0) {
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          checkpointStore: {
            load: (id) => f.checkpointStore.load(id),
            save: async (checkpoint) => {
              await f.checkpointStore.save(checkpoint);
              throw new Error('interrupted');
            },
          },
        }),
        /interrupted/,
      );
    } else await f.interrupt(prefix);
    const checkpoint = await f.checkpointStore.load(f.request.runId);
    assert(checkpoint);
    assert.equal(f.calls.length, prefix);
    const receipt = await executeAndPersist({ ...f.request, checkpoint });
    assert.equal(receipt.status, 'PASS');
    assert.deepEqual(receipt.stages.slice(0, prefix), checkpoint.stages);
    assert.equal(receipt.startedAt, checkpoint.startedAt);
    assert.deepEqual(f.calls, DEFAULT_STAGES);
  });

test('changed unacknowledged build is rejected before handler or receipt on resume', async (t) => {
  const f = await fixture(t);
  await f.interrupt(2);
  await writeFile(f.file, 'B');
  await assert.rejects(executeAndPersist(f.request), /Candidate identity/);
  assert.equal(f.calls.length, 2);
  assert.equal(
    (await f.checkpointStore.load(f.request.runId))?.stages.length,
    2,
  );
  assert.equal(await f.store.load(f.request.runId), null);
});

test('orphan manifest refuses the next unacknowledged stage before engine effects', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      checkpointStore: {
        load: (id) => f.checkpointStore.load(id),
        save: async (cp) => {
          if (cp.stages.length) throw new Error('interrupted');
          return f.checkpointStore.save(cp);
        },
      },
    }),
    /interrupted/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.checkpointStore.load(f.request.runId))?.stages.length,
    0,
  );
  assert(await f.workspaceManifestStore.load(f.request.runId, 'investigate'));
  await assert.rejects(executeAndPersist(f.request), /orphan/);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.store.load(f.request.runId), null);
});

test('candidate reader rejects stale expectation, changed tree, malformed receipt and evidence; restoration succeeds', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const current = await observeCandidate(f.scope);
  await assert.rejects(
    verifyCandidateCloseout(f.reader(f.initial)),
    /expected current/,
  );
  await writeFile(f.file, 'X');
  await assert.rejects(
    verifyCandidateCloseout(f.reader(current)),
    /Candidate identity/,
  );
  await writeFile(f.file, 'B');
  for (const changed of [
    {
      ...receipt,
      failure: {
        kind: 'stage-handler-error' as const,
        message: 'bad',
        stage: null,
        missingCapabilities: [],
      },
    },
    { ...receipt, stages: receipt.stages.slice(0, 5) },
    { ...receipt, candidateBinding: { scopeId: 'wrong', initial: f.initial } },
    { ...receipt, candidateBinding: undefined },
    { ...receipt, evidenceProfile: 'stage-evidence-v1' as const },
    { ...receipt, revision: 'wrong' },
  ])
    await assert.rejects(verifyCandidateCloseout(f.reader(current, changed)));
  const record = await f.attestation(receipt, 0);
  const payloadPath = join(
    f.storage,
    'evidence',
    `${record.payloads[0].reference.sha256}.artifact`,
  );
  const original = await readFile(payloadPath);
  await writeFile(payloadPath, Buffer.alloc(original.length));
  await assert.rejects(verifyCandidateCloseout(f.reader(current)), /hash/);
  await unlink(payloadPath);
  await assert.rejects(verifyCandidateCloseout(f.reader(current)));
  await writeFile(payloadPath, original);
  const stageFile = join(f.bindings.get('review')!.root, 'result.txt');
  await writeFile(stageFile, 'changed');
  await assert.rejects(
    verifyCandidateCloseout(f.reader(current)),
    /manifest|limit/,
  );
  await writeFile(stageFile, 'review');
  await verifyCandidateCloseout(f.reader(current));
});

test('reader expectation is independent of a store mutating the caller object', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const current = await observeCandidate(f.scope);
  const expected = { ...f.initial };
  await assert.rejects(
    verifyCandidateCloseout({
      ...f.reader(expected),
      store: {
        save: async () => '',
        load: async () => {
          expected.sha256 = current.sha256;
          return receipt;
        },
      },
    }),
    /expected current/,
  );
});

test('candidate reader requires every verification service before contacting storage', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const request = {
    ...f.reader(f.initial),
    store: {
      save: async () => '',
      load: async () => {
        reads++;
        return null;
      },
    },
  };
  for (const service of [
    'store',
    'evidenceStore',
    'workspaceManifestStore',
    'workspaceForStage',
  ]) {
    await assert.rejects(
      Reflect.apply(verifyCandidateCloseout, undefined, [
        { ...request, [service]: undefined },
      ]),
      /requires/,
    );
  }
  assert.equal(reads, 0);
});

test('candidate evidence readback does not trust a store-mutated reference', async (t) => {
  const f = await fixture(t);
  await executeAndPersist(f.request);
  await assert.rejects(
    verifyCandidateCloseout({
      ...f.reader(await observeCandidate(f.scope)),
      evidenceStore: {
        put: (req) => f.evidenceStore.put(req),
        load: (ref) => f.evidenceStore.load(ref),
        loadPortable: async (ref) => {
          if (ref.kind !== 'verification')
            return f.evidenceStore.loadPortable(ref);
          const bytes = Buffer.from('forged');
          Object.assign(ref, {
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
          return bytes;
        },
      },
    }),
    /changed/,
  );
});

test('candidate reader strictly rejects successor wire corruption and broken observation chains', async (t) => {
  const f = await fixture(t);
  const receipt = await executeAndPersist(f.request);
  const current = await observeCandidate(f.scope);
  const original = await f.attestation(receipt, 4);
  const mutations: Record<string, (value: any) => void> = {
    oldSchema: (a) => {
      a.schema = 1;
      delete a.candidate;
    },
    unknownSchema: (a) => {
      a.schema = 3;
    },
    extraField: (a) => {
      a.candidate.extra = true;
    },
    badIdentity: (a) => {
      a.candidate.before.scope = 'other';
    },
    missingIdentity: (a) => {
      delete a.candidate.after;
    },
    changedBinding: (a) => {
      a.candidate.binding.initial = current;
    },
    brokenChain: (a) => {
      a.candidate.before = f.initial;
    },
    nonBuildMutation: (a) => {
      a.candidate.after = f.initial;
    },
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const record = structuredClone(original);
      mutate(record);
      const published = await f.evidenceStore.put({
        runId: f.request.runId,
        revision: f.request.revision,
        kind: 'other',
        content: JSON.stringify(record),
      });
      const changed = {
        ...receipt,
        stages: receipt.stages.map((stage, i) =>
          i === 4
            ? {
                ...stage,
                stageEvidence: {
                  schema: published.schema,
                  sha256: published.sha256,
                  bytes: published.bytes,
                },
              }
            : stage,
        ),
      };
      await assert.rejects(verifyCandidateCloseout(f.reader(current, changed)));
    });
  await verifyCandidateCloseout(f.reader(current));
});

for (const prefix of [0, 3, 6])
  test(`strict profile and binding dispatch on ${prefix}-stage checkpoints`, async (t) => {
    const f = await fixture(t);
    if (prefix) await f.interrupt(prefix);
    else
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          checkpointStore: {
            load: (id) => f.checkpointStore.load(id),
            save: async (cp) => {
              await f.checkpointStore.save(cp);
              throw new Error('interrupted');
            },
          },
        }),
        /interrupted/,
      );
    const cp = await f.checkpointStore.load(f.request.runId);
    assert(cp);
    const count = f.calls.length;
    await assert.rejects(
      executeAndPersist({ ...f.request, candidate: undefined }),
      /profile|binding/,
    );
    await assert.rejects(
      executeAndPersist({
        ...f.request,
        candidate: undefined,
        stageEvidence: undefined,
      }),
      /profile|binding/,
    );
    const changedBinding = {
      ...f.request.candidate,
      expectedInitial: { ...f.initial, sha256: '0'.repeat(64) },
    };
    await assert.rejects(
      executeAndPersist({ ...f.request, candidate: changedBinding }),
      /binding/,
    );
    for (const profile of [undefined, 'stage-evidence-v1'] as const) {
      const changed = {
        ...cp,
        evidenceProfile: profile,
        candidateBinding: undefined,
      };
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          checkpointStore: {
            save: (c) => f.checkpointStore.save(c),
            load: async () => changed,
          },
        }),
        /profile/,
      );
    }
    await assert.rejects(
      executeAndPersist({
        ...f.request,
        checkpoint: { ...cp, startedAt: new Date(0).toISOString() },
      }),
      /differs/,
    );
    await assert.rejects(
      executeAndPersist({
        ...f.request,
        checkpoint: cp,
        checkpointStore: {
          save: (c) => f.checkpointStore.save(c),
          load: async () => null,
        },
      }),
      /differs/,
    );
    assert.equal(f.calls.length, count);
    assert.equal(await f.store.load(f.request.runId), null);
  });

test('initial save failure, readback substitution and candidate mutation invoke zero handlers', async (t) => {
  for (const fault of ['save', 'substitution', 'candidate'])
    await t.test(fault, async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          checkpointStore: {
            load: (id) => f.checkpointStore.load(id),
            save: async (cp) => {
              if (fault === 'save') throw new Error('save failed');
              if (fault === 'substitution')
                Object.assign(cp.candidateBinding!.initial, {
                  sha256: '0'.repeat(64),
                });
              const path = await f.checkpointStore.save(cp);
              if (fault === 'candidate') await writeFile(f.file, 'X');
              return path;
            },
          },
        }),
      );
      assert.equal(f.calls.length, 0);
      assert.equal(await f.store.load(f.request.runId), null);
      assert.equal(
        (await f.checkpointStore.load(f.request.runId))?.stages.length ?? 0,
        0,
      );
    });
});

test('invalid plans write no checkpoint and capability BLOCKED precedes initial hook', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      plan: { ...f.request.plan, stages: ['build'] },
    }),
    /canonical/,
  );
  assert.equal(await f.checkpointStore.load(f.request.runId), null);
  const blocked = await executeAndPersist({
    ...f.request,
    plan: { ...f.request.plan, requiredCapabilities: ['subagents'] },
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.failure?.kind, 'capability-gap');
  assert.deepEqual(blocked.candidateBinding, {
    scopeId: 'app',
    initial: f.initial,
  });
  assert.equal(await f.checkpointStore.load(f.request.runId), null);
  assert.equal(f.calls.length, 0);
  await assert.rejects(executeAndPersist(f.request), /Terminal/);
});

test('only build may change the candidate and handler-authored bindings never become evidence', async (t) => {
  for (const fault of ['mutation', 'raw-reference'])
    await t.test(fault, async (t) => {
      const f = await fixture(t);
      const receipt = await executeAndPersist({
        ...f.request,
        handler: async (stage) => {
          const result = await f.request.handler(stage);
          if (fault === 'mutation') await writeFile(f.file, 'X');
          return {
            ...result,
            ...(fault === 'raw-reference'
              ? {
                  stageEvidence: {
                    schema: 1 as const,
                    sha256: '0'.repeat(64),
                    bytes: 1,
                  },
                }
              : {}),
          };
        },
      });
      assert.equal(receipt.status, 'BLOCKED');
      assert.equal(
        (await f.checkpointStore.load(f.request.runId))?.stages.length,
        0,
      );
      assert.equal(f.calls.length, 1);
    });
});

test('publication mutation after build observation refuses PASS checkpoint while preserving prior prefix', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      stageEvidence: {
        store: {
          put: async (request) => {
            const ref = await f.evidenceStore.put(request);
            const body = Buffer.from(request.content).toString();
            if (request.kind === 'other' && JSON.parse(body).stage === 'build')
              await writeFile(f.file, 'X');
            return ref;
          },
          load: (path) => f.evidenceStore.load(path),
          loadPortable: (ref) => f.evidenceStore.loadPortable(ref),
        },
      },
    }),
    /Candidate identity/,
  );
  assert.equal(
    (await f.checkpointStore.load(f.request.runId))?.stages.length,
    2,
  );
  assert.equal(await f.store.load(f.request.runId), null);
  assert.deepEqual(f.calls, DEFAULT_STAGES.slice(0, 3));
  await assert.rejects(executeAndPersist(f.request), /Candidate identity/);
  assert.equal(f.calls.length, 3);
});

test('stage save readback substitution is detected against independent expectation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      checkpointStore: {
        load: (id) => f.checkpointStore.load(id),
        save: async (cp) => {
          if (cp.stages.length)
            Object.assign(cp.stages[0], { summary: 'substituted' });
          return f.checkpointStore.save(cp);
        },
      },
    }),
    /readback/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.checkpointStore.load(f.request.runId))?.stages.length,
    1,
  );
  assert.equal(await f.store.load(f.request.runId), null);
});

test('malformed present candidate options and missing services fail before effects', async (t) => {
  const f = await fixture(t);
  for (const candidate of [false, 0, '', null, [], {}]) {
    await assert.rejects(
      Reflect.apply(executeAndPersist, undefined, [
        { ...f.request, candidate },
      ]),
    );
  }
  for (const service of [
    'checkpointStore',
    'stageEvidence',
    'workspaceManifestStore',
    'workspaceForStage',
  ]) {
    await assert.rejects(
      Reflect.apply(executeAndPersist, undefined, [
        { ...f.request, [service]: undefined },
      ]),
      /requires/,
    );
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await f.store.load(f.request.runId), null);
  assert.equal(await f.checkpointStore.load(f.request.runId), null);
});

test('terminal receipt mutation and substitution are detected against independent expectation', async (t) => {
  for (const fault of ['mutation', 'substitution'])
    await t.test(fault, async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        executeAndPersist({
          ...f.request,
          store: {
            load: (id) => f.store.load(id),
            save: async (receipt) => {
              const changed =
                fault === 'mutation' ? receipt : structuredClone(receipt);
              Object.assign(changed.candidateBinding!.initial, {
                sha256: '0'.repeat(64),
              });
              return f.store.save(changed);
            },
          },
        }),
        /receipt readback/,
      );
      assert.equal(f.calls.length, 6);
      assert.equal(
        (await f.checkpointStore.load(f.request.runId))?.stages.length,
        6,
      );
      await assert.rejects(
        verifyCandidateCloseout(f.reader(await observeCandidate(f.scope))),
        /binding/,
      );
    });
});

for (const length of [4, 6])
  test(`post-checkpoint mutation at stage ${length} never publishes PASS and retains acknowledged history`, async (t) => {
    const f = await fixture(t);
    const run = executeAndPersist({
      ...f.request,
      onStageCheckpoint: async (cp) => {
        if (cp.stages.length === length) await writeFile(f.file, 'X');
      },
    });
    if (length === 6) {
      await assert.rejects(run, /Candidate identity/);
      assert.equal(await f.store.load(f.request.runId), null);
    } else assert.equal((await run).status, 'BLOCKED');
    assert.equal(
      (await f.checkpointStore.load(f.request.runId))?.stages.length,
      length,
    );
    assert.equal(f.calls.length, length);
  });

test('execution snapshots caller configuration and callback checkpoints', async (t) => {
  const f = await fixture(t);
  const declared = new Map(f.bindings);
  const receipt = await executeAndPersist({
    ...f.request,
    workspaceForStage: (stage) => declared.get(stage)!,
    onStageCheckpoint: (cp) => {
      Object.assign(cp.candidateBinding!.initial, { sha256: '0'.repeat(64) });
      Object.assign(f.request.candidate.expectedInitial, {
        sha256: 'f'.repeat(64),
      });
      declared.set('deliver', { workspaceId: 'wrong', root: f.scope.root });
    },
  });
  assert.equal(receipt.status, 'PASS');
  assert.notEqual(receipt.candidateBinding!.initial.sha256, '0'.repeat(64));
  assert.notEqual(receipt.candidateBinding!.initial.sha256, 'f'.repeat(64));
});

test('candidate root policy rejects both containment directions, stage overlap and declared writes', async (t) => {
  const f = await fixture(t);
  const child = join(f.scope.root, 'nested');
  await mkdir(child);
  const stagesParent = join(f.root, 'stages');
  const variants = [
    {
      ...f.request,
      candidate: {
        ...f.request.candidate,
        scope: { ...f.scope, root: f.root },
      },
    },
    {
      ...f.request,
      candidate: {
        ...f.request.candidate,
        scope: { ...f.scope, root: f.bindings.get('build')!.root },
      },
    },
    {
      ...f.request,
      workspaceForStage: (stage: WorkflowStageId) =>
        stage === 'build'
          ? { workspaceId: stage, root: child }
          : f.request.workspaceForStage(stage),
    },
    {
      ...f.request,
      workspaceForStage: (stage: WorkflowStageId) =>
        stage === 'build'
          ? { workspaceId: stage, root: stagesParent }
          : f.request.workspaceForStage(stage),
    },
    { ...f.request, workspaceForStage: () => f.bindings.get('build')! },
    {
      ...f.request,
      candidate: { ...f.request.candidate, knownWriteRoots: [f.scope.root] },
    },
    {
      ...f.request,
      candidate: {
        ...f.request.candidate,
        knownWriteRoots: [f.bindings.get('build')!.root],
      },
    },
  ];
  for (const request of variants)
    await assert.rejects(executeAndPersist(request), /overlap/);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.checkpointStore.load(f.request.runId), null);
  assert.equal(await f.store.load(f.request.runId), null);
});

test('candidate root policy rejects static ancestor aliases and changed resolution during execution', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  await symlink(
    join(f.root, 'stages'),
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    executeAndPersist({
      ...f.request,
      candidate: {
        ...f.request.candidate,
        scope: { ...f.scope, root: join(alias, 'build') },
      },
    }),
    /overlap/,
  );
  const containerA = join(f.root, 'a');
  const containerB = join(f.root, 'b');
  for (const root of [containerA, containerB]) {
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', 'file'), 'A');
  }
  const movingAlias = join(f.root, 'moving-alias');
  await symlink(
    containerA,
    movingAlias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const scope = { scopeId: 'app', root: join(movingAlias, 'app') };
  const receipt = await executeAndPersist({
    ...f.request,
    candidate: {
      ...f.request.candidate,
      scope,
      expectedInitial: await observeCandidate(scope),
    },
    onStageCheckpoint: async (cp) => {
      if (cp.stages.length === 1) {
        await unlink(movingAlias);
        await symlink(
          containerB,
          movingAlias,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
    },
  });
  assert.equal(receipt.status, 'BLOCKED');
  assert.match(receipt.failure!.message, /resolution changed/);
  assert.equal(f.calls.length, 1);
});

function interceptRunStore(
  store: WorkflowRunStore,
  method: keyof WorkflowRunStore,
  before: () => void | Promise<void>,
): WorkflowRunStore {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key !== method) return value.bind(target);
      return async (...args: unknown[]) => {
        await before();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

for (const candidate of [false, true])
  test(`scheduled ${candidate ? 'candidate' : 'legacy'} control retains its selected profile`, async (t) => {
    const f = await fixture(t);
    const runStore = await FileWorkflowRunStore.create(join(f.storage, 'runs'));
    const result = await executeScheduledAndPersist({
      ...f.request,
      ...(candidate ? {} : { candidate: undefined, stageEvidence: undefined }),
      runStore,
      owner: 'scheduled-owner',
      leaseMs: 60_000,
    });
    assert.equal(result.claimed, true);
    assert.equal(result.record.status, 'SUCCEEDED');
    assert.equal(result.receipt?.status, 'PASS');
    assert.equal(
      result.receipt.evidenceProfile,
      candidate ? 'candidate-stage-evidence-v1' : undefined,
    );
    assert.deepEqual(f.calls, DEFAULT_STAGES);
    if (candidate)
      await verifyCandidateCloseout(f.reader(await observeCandidate(f.scope)));
  });

for (const method of ['create', 'claim', 'appendEvent'] as const)
  test(`scheduled ${method} cannot replace the initially selected candidate`, async (t) => {
    const f = await fixture(t);
    const runStore = await FileWorkflowRunStore.create(join(f.storage, 'runs'));
    await assert.rejects(
      executeScheduledAndPersist({
        ...f.request,
        owner: 'scheduled-owner',
        leaseMs: 60_000,
        runStore: interceptRunStore(runStore, method, async () => {
          await writeFile(f.file, 'X');
          Object.assign(
            f.request.candidate.expectedInitial,
            await observeCandidate(f.scope),
          );
        }),
      }),
      /Candidate identity/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(await f.store.load(f.request.runId), null);
    assert.equal(await f.checkpointStore.load(f.request.runId), null);
    assert.equal((await runStore.load(f.request.runId))?.status, 'FAILED');
  });

for (const boundary of ['create', 'now'] as const)
  test(`scheduled ${boundary} cannot downgrade profile or replace forwarding configuration`, async (t) => {
    const f = await fixture(t);
    const initial = structuredClone(f.initial);
    const runStore: WorkflowRunStore = await FileWorkflowRunStore.create(
      join(f.storage, 'runs'),
    );
    const request = {
      ...f.request,
      runStore,
      owner: 'scheduled-owner',
      leaseMs: 60_000,
      now: () => new Date(),
      leaseRenewal: { intervalMs: 10_000 },
      cancellation: { onRequested: 'cancel-before-completion' as const },
    };
    let mutations = 0;
    const mutate = () => {
      if (mutations++) return;
      Object.assign(request.candidate.expectedInitial, {
        sha256: '0'.repeat(64),
      });
      Object.assign(request.plan, { stages: ['build'] });
      Object.assign(request.capabilities, { available: ['subagents'] });
      Object.assign(request.leaseRenewal, { intervalMs: -1 });
      Reflect.deleteProperty(request, 'candidate');
      Reflect.deleteProperty(request, 'stageEvidence');
      Reflect.deleteProperty(request, 'checkpointStore');
      Reflect.deleteProperty(request, 'workspaceManifestStore');
      Object.assign(request, {
        runId: 'substituted',
        revision: 'substituted',
        owner: 'substituted',
        handler: () => {
          throw new Error('substituted handler');
        },
        workspaceForStage: () => ({ workspaceId: 'wrong', root: f.scope.root }),
      });
    };
    if (boundary === 'create')
      request.runStore = interceptRunStore(runStore, 'create', mutate);
    else
      request.now = () => {
        mutate();
        return new Date();
      };
    const result = await executeScheduledAndPersist(request);
    assert(mutations > 0);
    assert.equal(result.record.runId, f.request.runId);
    assert.equal(result.record.status, 'SUCCEEDED');
    assert.equal(result.receipt?.status, 'PASS');
    assert.equal(result.receipt.evidenceProfile, 'candidate-stage-evidence-v1');
    assert.equal(result.receipt.revision, f.request.revision);
    assert.deepEqual(result.receipt.candidateBinding?.initial, initial);
    assert.deepEqual(result.receipt.plan.stages, DEFAULT_STAGES);
    assert.deepEqual(f.calls, DEFAULT_STAGES);
    assert.equal(await runStore.load('substituted'), null);
  });

test('scheduled candidate service admission runs before callbacks and mechanical writes', async (t) => {
  const f = await fixture(t);
  const runStore = await FileWorkflowRunStore.create(join(f.storage, 'runs'));
  let callbacks = 0;
  await assert.rejects(
    Reflect.apply(executeScheduledAndPersist, undefined, [
      {
        ...f.request,
        runStore,
        owner: 'scheduled-owner',
        leaseMs: 60_000,
        checkpointStore: undefined,
        now: () => {
          callbacks++;
          return new Date();
        },
      },
    ]),
    /requires/,
  );
  assert.equal(callbacks, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await runStore.load(f.request.runId), null);
});

test('scheduled prelude rejects a changed root alias before handler dispatch', async (t) => {
  const f = await fixture(t);
  const runStore = await FileWorkflowRunStore.create(join(f.storage, 'runs'));
  const alias = join(f.root, 'scheduled-alias');
  const replacement = join(f.root, 'replacement');
  await mkdir(join(replacement, 'candidate'), { recursive: true });
  await writeFile(join(replacement, 'candidate', 'output.txt'), 'A');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(f.root, alias, linkType);
  const scope = { ...f.scope, root: join(alias, 'candidate') };
  assert.deepEqual(await observeCandidate(scope), f.initial);
  await assert.rejects(
    executeScheduledAndPersist({
      ...f.request,
      candidate: { ...f.request.candidate, scope },
      owner: 'scheduled-owner',
      leaseMs: 60_000,
      runStore: interceptRunStore(runStore, 'create', async () => {
        await unlink(alias);
        await symlink(replacement, alias, linkType);
      }),
    }),
    /resolution changed/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await f.store.load(f.request.runId), null);
  assert.equal(await f.checkpointStore.load(f.request.runId), null);
  assert.equal((await runStore.load(f.request.runId))?.status, 'FAILED');
});
