import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  MergeObservation,
  ReconciliationConfirmation,
  ReconciliationPlan,
  ReconciliationStatus,
} from '../libs/contracts/src/index.js';
import {
  FileMergeReconciliationStore,
  reconciliationAttemptBinding,
  reconciliationStoreDigest,
} from '../libs/runtime/src/index.js';
import { observeGitReconciliation } from '../libs/host-adapters/src/lib/git-reconciliation-observer.js';
import {
  MergeReconciliationDashboard,
  createObservedGitReconciliationBindingReader,
  observedGitReconciliationScope,
  type CurrentReconciliationBindingReader,
  projectRetainedReconciliationReview,
  reconciliationInteractionIdentity,
  ReconciliationBrowserRequestError,
  type ReconciliationInteractionWriter,
  type ReconciliationInteractionEvent,
} from './merge-reconciliation-dashboard.mjs';

const SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const now = '2026-10-01T12:00:00.000Z';

function evidence(id: string) {
  return [{ schema: 1 as const, id, sha256: SHA, bytes: 3, mediaType: 'application/json' }];
}
function scope(version: string) {
  return {
    schema: 1 as const,
    sourceRoot: { id: 'source-root', sha256: 'b'.repeat(64) },
    candidateRoot: { id: `candidate-root-${version}`, sha256: 'c'.repeat(64) },
    baseHead: { id: 'base-head', sha256: 'd'.repeat(64) },
    operationHead: { id: 'operation-head', sha256: 'e'.repeat(64) },
    affectedPaths: [{
      path: 'tools/merge-reconciliation-dashboard.mts', classification: 'unmerged' as const,
      pathSha256: '1'.repeat(64),
      indexBlobs: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      unmergedStages: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      worktreeKind: 'file' as const, worktreeSha256: '3'.repeat(64), diffSha256: '4'.repeat(64),
    }],
    resolutionIntent: 'preserve' as const,
    requiredChecks: [{ id: 'dashboard-test', definitionSha256: 'f'.repeat(64) }],
    expectedComparison: {
      candidateEvidence: evidence(`candidate-comparison-${version}`)[0]!,
      verificationEvidence: evidence(`verification-comparison-${version}`)[0]!,
    },
  };
}

function observation(version = 'v1'): MergeObservation {
  return {
    schema: 1,
    observationId: `observation-${version}`,
    taskId: 'task-1',
    taskVersion: version,
    runId: 'run-1',
    revision: 'revision-1',
    candidate: { schema: 'reconciliation-candidate-v1', id: 'candidate-1', sha256: SHA },
    scope: scope(version),
    observedAt: now,
    kind: 'mixed',
    evidence: evidence(`observation-evidence-${version}`),
  };
}

function plan(
  selected: MergeObservation,
  status: ReconciliationStatus = 'awaiting-confirmation',
  key = 'intent-1',
  digest = DIGEST,
): ReconciliationPlan {
  return {
    schema: 1,
    id: `plan-${selected.observationId}`,
    taskId: selected.taskId,
    taskVersion: selected.taskVersion,
    runId: selected.runId,
    revision: selected.revision,
    observationId: selected.observationId,
    candidate: selected.candidate,
    scope: selected.scope,
    classification: status === 'awaiting-confirmation' ? 'requires-confirmation' : 'automatic',
    status,
    request: {
      idempotencyKey: key,
      canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1',
      canonicalRequestSha256: digest,
    },
    summary: 'Retain exact reconciliation evidence.',
    actions: [{ id: 'preserve-1', kind: 'preserve', targetId: selected.taskId }],
    evidence: evidence(`plan-evidence-${selected.observationId}`),
  };
}

function confirmation(selected: ReconciliationPlan): ReconciliationConfirmation {
  return {
    schema: 1,
    confirmationId: 'confirm-1',
    planId: selected.id,
    observationId: selected.observationId,
    canonicalRequestSha256: selected.request.canonicalRequestSha256,
    confirmedAt: now,
    confirmedBy: 'operator-1',
    evidence: evidence('confirmation-evidence'),
  };
}

function echoBindingReader(): CurrentReconciliationBindingReader {
  return {
    async readCurrentBinding({ expected }) {
      return expected;
    },
  };
}

function trustedSnapshot(seed: MergeObservation) {
  return {
    taskId: seed.taskId,
    taskVersion: seed.taskVersion,
    runId: seed.runId,
    revision: seed.revision,
    observationId: seed.observationId,
    candidateId: seed.candidate.id,
    candidateSha256: seed.candidate.sha256,
    candidateRoot: seed.scope.candidateRoot,
    resolutionIntent: seed.scope.resolutionIntent,
    requiredChecks: seed.scope.requiredChecks,
    expectedComparison: seed.scope.expectedComparison,
  };
}

function temporaryGit(root: string, args: readonly string[]): string {
  return execFileSync('git', [
    '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Reconciliation test',
      GIT_AUTHOR_EMAIL: 'reconciliation-test@example.invalid',
      GIT_COMMITTER_NAME: 'Reconciliation test',
      GIT_COMMITTER_EMAIL: 'reconciliation-test@example.invalid',
    },
  });
}

async function repositoryFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'temari-reconciliation-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  temporaryGit(root, ['init', '--quiet', '--initial-branch=main', '--object-format=sha1']);
  await writeFile(join(root, 'tracked.txt'), 'committed source\n');
  temporaryGit(root, ['add', '--', 'tracked.txt']);
  temporaryGit(root, ['commit', '--quiet', '-m', 'initial source']);
  return root;
}

async function fixture(t: TestContext, reader: CurrentReconciliationBindingReader | null = echoBindingReader()) {
  const root = await mkdtemp(join(tmpdir(), 'temari-reconciliation-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileMergeReconciliationStore.create(join(root, 'attempts'));
  return { store, dashboard: new MergeReconciliationDashboard(store, reader ?? undefined) };
}

test('projects externally creatable states and rejects executor-only plan states', async (t) => {
  const f = await fixture(t);
  for (const [index, state] of (['observed', 'awaiting-confirmation'] as const).entries()) {
    const selected = observation(`v${index}`);
    const selectedPlan = plan(selected, state, `intent-${index}`);
    const view = await f.dashboard.submitIntent({ idempotencyKey: `intent-${index}`, observation: selected, plan: selectedPlan });
    assert.equal(view.state, state);
    assert.equal(view.terminal, false);
  }
  for (const state of ['integrating', 'verifying'] as const) {
    const selected = observation(state);
    await assert.rejects(
      f.dashboard.submitIntent({
        idempotencyKey: `executor-${state}`,
        observation: selected,
        plan: plan(selected, state, `executor-${state}`),
      }),
      /initial.*status/i,
    );
  }
  const selected = observation('blocked');
  const blockedPlan: ReconciliationPlan = {
    ...plan(selected, 'blocked', 'blocked-intent'),
    classification: 'manual-review',
    blockedReason: 'manual-intervention-required',
  };
  const blocked = await f.dashboard.submitIntent({ idempotencyKey: 'blocked-intent', observation: selected, plan: blockedPlan });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blockedReason, 'manual-intervention-required');
});

test('confirmation remains observed and non-ready without separate executor evidence', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.deepEqual({ state: awaiting.state, readiness: awaiting.candidate.readiness, terminal: awaiting.terminal }, {
    state: 'awaiting-confirmation', readiness: 'not-ready', terminal: false,
  });
  const confirmed = await f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) });
  assert.deepEqual({ state: confirmed.state, readiness: confirmed.candidate.readiness, terminal: confirmed.terminal }, {
    state: 'observed', readiness: 'not-ready', terminal: false,
  });
});

test('stale bindings remain visibly blocked with their retained invalidation reason', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const view = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  const stale = observation('v2');
  const staleReader: CurrentReconciliationBindingReader = {
    async readCurrentBinding() { return reconciliationAttemptBinding(stale); },
  };
  const blocked = await new MergeReconciliationDashboard(f.store, staleReader).invalidateIntent({ attemptId: view.attemptId });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.blockedReason ?? '', /task, run, revision, candidate, or observation binding changed/i);
  assert.equal((await f.dashboard.view(view.attemptId))?.blockedReason, blocked.blockedReason);
});

test('confirmation fails closed without a trusted current-binding reader', async (t) => {
  const f = await fixture(t, null);
  const selected = observation();
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.equal(awaiting.canConfirm, false);
  await assert.rejects(
    f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) }),
    /binding reader is not configured/i,
  );
});

test('reader-returned drift blocks confirmation without accepting request-supplied bindings', async (t) => {
  const selected = observation();
  const driftReader: CurrentReconciliationBindingReader = {
    async readCurrentBinding({ expected }) {
      return { ...expected, revision: 'trusted-reader-observed-drift' };
    },
  };
  const f = await fixture(t, driftReader);
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  const blocked = await f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) });
  assert.equal(blocked.state, 'blocked');
  assert.equal((await f.store.get(awaiting.attemptId))?.confirmation, null);
});

test('portable observed Git scope matches a stored attempt and reader drift blocks it', async (t) => {
  const seed = observation();
  const gitObjectId = 'a'.repeat(40);
  const git = {
    schema: 1 as const,
    source: { repositoryRoot: '/trusted/source-root', commonGitDirectory: '/trusted/.git', headObjectId: gitObjectId, headReference: 'main' },
    operation: 'merge' as const, porcelainV2: 'u UU N... 100644 100644 100644 100644 a b c file.ts\0', porcelainSha256: DIGEST,
    unmerged: [{ path: 'file.ts', stages: [{ stage: 1 as const, mode: '100644', objectId: gitObjectId }] }],
    untrackedPaths: [], paths: [{ path: 'file.ts', pathSha256: SHA, indexBlobs: [], worktreeKind: 'file' as const, worktreeSha256: SHA, diffSha256: DIGEST }],
  };
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(git, snapshot) };
  assert.equal(selected.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: gitObjectId }));
  assert.match(selected.scope.sourceRoot.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.equal(selected.scope.sourceRoot.id.includes('/'), false);
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: '/trusted/source-root',
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
    observe: async () => git,
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected);
  const created = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.equal(
    (await reader.readCurrentBinding({ attemptId: created.attemptId, expected: (await f.store.get(created.attemptId))!.binding })).scopeSha256,
    (await f.store.get(created.attemptId))!.binding.scopeSha256,
  );
  assert.equal(
    (await f.dashboard.confirmIntent({ attemptId: created.attemptId, confirmation: confirmation(selectedPlan) })).state,
    'observed',
  );
  const sameStatusContentDrift = {
    ...git,
    paths: [{
      ...git.paths[0]!,
      worktreeSha256: '9'.repeat(64),
      diffSha256: '8'.repeat(64),
    }],
  };
  assert.equal(sameStatusContentDrift.source.headObjectId, git.source.headObjectId);
  assert.equal(sameStatusContentDrift.porcelainV2, git.porcelainV2);
  assert.deepEqual(
    sameStatusContentDrift.paths.map((entry) => entry.path),
    git.paths.map((entry) => entry.path),
  );
  const driftReader = createObservedGitReconciliationBindingReader({
    repositoryRoot: '/trusted/source-root',
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
    observe: async () => sameStatusContentDrift,
  });
  assert.equal(
    (await new MergeReconciliationDashboard(f.store, driftReader).confirmIntent({ attemptId: created.attemptId, confirmation: confirmation(selectedPlan) })).state,
    'blocked',
  );
});

test('real SHA-1 Git HEAD is canonically digested and confirmation records intent only', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const before = {
    head: temporaryGit(root, ['rev-parse', 'HEAD']).trim(),
    status: temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    content: await readFile(join(root, 'tracked.txt'), 'utf8'),
  };
  assert.match(before.head, /^[0-9a-f]{40}$/);
  const git = await observeGitReconciliation(root);
  const seed = observation('real-head');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(git, snapshot) };
  assert.equal(git.source.headObjectId, before.head);
  assert.equal(selected.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: before.head }));
  assert.notEqual(selected.scope.baseHead.sha256, before.head);
  assert.deepEqual(selected.scope.affectedPaths.map((path) => path.path), ['tracked.txt']);
  assert.match(selected.scope.affectedPaths[0]!.indexBlobs[0]!.objectId, /^[0-9a-f]{40}$/);
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'real-head-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'real-head-intent', observation: selected, plan: selectedPlan,
  });
  const stored = (await f.store.get(created.attemptId))!;
  assert.deepEqual(await reader.readCurrentBinding({ attemptId: created.attemptId, expected: stored.binding }), stored.binding);
  const confirmed = await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  });
  assert.deepEqual({ state: confirmed.state, readiness: confirmed.candidate.readiness, terminal: confirmed.terminal }, {
    state: 'observed', readiness: 'not-ready', terminal: false,
  });
  assert.deepEqual((await f.store.get(created.attemptId))!.confirmation, confirmation(selectedPlan));
  assert.deepEqual({
    head: temporaryGit(root, ['rev-parse', 'HEAD']).trim(),
    status: temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    content: await readFile(join(root, 'tracked.txt'), 'utf8'),
  }, before);
});

test('a changed real Git HEAD blocks confirmation even when affected content and status are unchanged', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const initial = await observeGitReconciliation(root);
  const seed = observation('head-drift');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(initial, snapshot) };
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'head-drift-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'head-drift-intent', observation: selected, plan: selectedPlan,
  });
  temporaryGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'new source head']);
  const changed = await observeGitReconciliation(root);
  assert.match(changed.source.headObjectId!, /^[0-9a-f]{40}$/);
  assert.notEqual(changed.source.headObjectId, initial.source.headObjectId);
  assert.equal(changed.porcelainV2, initial.porcelainV2);
  assert.deepEqual(changed.paths, initial.paths);
  const blocked = await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  });
  assert.equal(blocked.state, 'blocked');
  const retained = (await f.store.get(created.attemptId))!;
  assert.equal(retained.confirmation, null);
  assert.deepEqual(retained.observation.scope, selected.scope);
  assert.equal(retained.observation.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: initial.source.headObjectId }));
});

test('a clean real repository refuses scope preparation without inventing an affected path', async (t) => {
  const root = await repositoryFixture(t);
  const clean = await observeGitReconciliation(root);
  assert.match(clean.source.headObjectId!, /^[0-9a-f]{40}$/);
  assert.deepEqual(clean.paths, []);
  const seed = observation('clean');
  assert.throws(
    () => observedGitReconciliationScope(clean, trustedSnapshot(seed)),
    /^Error: No affected Git paths; no reconciliation attempt prepared\.$/,
  );
  const f = await fixture(t);
  // Even a caller bypassing preparation cannot admit an empty portable scope.
  const invalid = { ...seed, scope: { ...seed.scope, affectedPaths: [] } };
  await assert.rejects(f.dashboard.submitIntent({
    idempotencyKey: 'clean-intent', observation: invalid,
    plan: plan(invalid, 'awaiting-confirmation', 'clean-intent'),
  }), /affectedPaths must declare at least one affected path/);
  assert.deepEqual(await f.store.list(), []);
  assert.equal(temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']), '');
});

test('a retained dirty attempt is invalidated when its real live source becomes clean', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const initial = await observeGitReconciliation(root);
  const seed = observation('clean-drift');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(initial, snapshot) };
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'clean-drift-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'clean-drift-intent', observation: selected, plan: selectedPlan,
  });
  await writeFile(join(root, 'tracked.txt'), 'committed source\n');
  const clean = await observeGitReconciliation(root);
  assert.deepEqual(clean.paths, []);
  assert.equal(clean.source.headObjectId, initial.source.headObjectId);
  assert.throws(() => observedGitReconciliationScope(clean, snapshot), /no reconciliation attempt prepared/);
  const blocked = await f.dashboard.invalidateIntent({ attemptId: created.attemptId });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.canConfirm, false);
  const retained = (await f.store.get(created.attemptId))!;
  assert.deepEqual(retained.observation.scope, selected.scope);
  assert.equal(retained.confirmation, null);
  assert.equal((await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  })).state, 'blocked');
  assert.equal((await f.store.get(created.attemptId))!.confirmation, null);
});

test('delegated idempotency replay is stable and changed request identity conflicts', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const original = plan(selected);
  const request = { idempotencyKey: 'intent-1', observation: selected, plan: original };
  const first = await f.dashboard.submitIntent(request);
  assert.deepEqual(await f.dashboard.submitIntent(request), first);
  await assert.rejects(
    f.dashboard.submitIntent({
      idempotencyKey: 'intent-1',
      observation: selected,
      plan: plan(selected, 'awaiting-confirmation', 'intent-1', 'c'.repeat(64)),
    }),
    /changed request digest/,
  );
});

async function interactionWriter(root:string) {
  await mkdir(root,{recursive:true});let writes=0,reads=0;
  const filename=(id:string)=>join(root,id+'.json');
  const writer:ReconciliationInteractionWriter={
    async publish(event) {
      writes++;const identity=reconciliationInteractionIdentity(event.attemptId,event.requestId),bytes=Buffer.from(JSON.stringify(event)+'\n');
      const file=await open(filename(identity.eventId),'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    },
    async read({attemptId,requestId}) {return writer.readRecorded({attemptId,evidenceId:reconciliationInteractionIdentity(attemptId,requestId).eventId});},
    async readRecorded({evidenceId}) {
      reads++;let bytes:Buffer;try{bytes=await readFile(filename(evidenceId));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
      return {bytes,evidence:{schema:1,id:evidenceId,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mediaType:'application/json'}};
    },
  };
  return {writer,filename,get writes(){return writes;},get reads(){return reads;}};
}
async function browserFixture(t:TestContext,reader:CurrentReconciliationBindingReader=echoBindingReader(),selectedPlan?:ReconciliationPlan) {
  const f=await fixture(t,reader),selected=observation(),p=selectedPlan??plan(selected);
  const attempt=await f.store.createAttempt({idempotencyKey:p.request.idempotencyKey,observation:selected,plan:p});
  const projected=projectRetainedReconciliationReview(attempt);assert(projected.complete&&projected.sha256);
  const adapter=await interactionWriter(join(f.store.root,'..','interactions'));let tick=0;
  const options={browserReview:{selectedAttempts:[{attemptId:attempt.id,reviewSha256:projected.sha256}]},interactionWriter:adapter.writer,now:()=>new Date(Date.parse(now)+(tick++))};
  const dashboard=new MergeReconciliationDashboard(f.store,reader,options);
  return {...f,attempt,dashboard,adapter,options,request:{requestId:'local-request:1',reviewSha256:projected.sha256}};
}

test('browser retained list reads one bounded snapshot and exposes free text only for an exact host pin',async(t)=>{
  const f=await browserFixture(t);
  const snapshot=Array.from({length:53},(_,i)=>({...f.attempt,id:'attempt:row-'+String(i).padStart(2,'0'),plan:{...f.attempt.plan,summary:i===52?'s'.repeat(600):f.attempt.plan.summary},updatedAt:new Date(Date.parse(now)+i).toISOString()}));
  let lists=0;
  const store={...f.store,list:async()=>{assert.equal(++lists,1);return snapshot;},get:async()=>{throw new Error('List must not reread an attempt.');},createAttempt:f.store.createAttempt.bind(f.store),invalidateStaleBinding:f.store.invalidateStaleBinding.bind(f.store),confirm:f.store.confirm.bind(f.store)};
  const selected=snapshot[52]!,pin=projectRetainedReconciliationReview(selected).sha256!;
  const list=await new MergeReconciliationDashboard(store,echoBindingReader(),{browserReview:{selectedAttempts:[{attemptId:selected.id,reviewSha256:pin}]}}).list();
  assert.equal(lists,1);assert.deepEqual(list.page,{total:53,limit:50,omitted:3});assert.equal(list.attempts.length,50);assert.equal(list.attempts[0]!.attemptId,selected.id);
  assert.equal(list.attempts[0]!.summary,'s'.repeat(512));assert.equal(list.attempts[0]!.summaryTruncated,true);assert(list.attempts.slice(1).every((row)=>row.summary===null&&!row.hostSelectedForReview));
  assert(list.attempts.every((row)=>row.candidate.readiness==='not-ready'&&row.terminal===false));
  const unselected=await new MergeReconciliationDashboard(f.store,echoBindingReader()).review(f.attempt.id);
  assert.equal(unselected!.review.payload,null);assert.equal(unselected!.review.sha256,null);assert.equal(unselected!.admission.reasonCode,'host-selection-required');
  assert.equal(unselected!.capabilities.canRecordConfirmationIntent,false);assert.equal(unselected!.currentBinding.state,'not-checked');
});

test('complete review digest binds declared metadata and oversized/unknown projections cannot become approvable',async(t)=>{
  const f=await browserFixture(t),original=projectRetainedReconciliationReview(f.attempt);assert(original.complete&&original.payload);
  assert.equal(original.sha256,reconciliationStoreDigest(original.payload));
  for(const change of ['summary','observation-time','scope-path','check-definition','comparison-evidence','action','request'] as const) {
    const candidate=structuredClone(f.attempt) as any;
    if(change==='summary')candidate.plan.summary+=' Ordinary https://documentation.example.invalid/link `quoted` plan data.';
    if(change==='observation-time')candidate.observation.observedAt='2026-10-01T12:00:01.000Z';
    if(change==='scope-path')candidate.observation.scope.affectedPaths[0].diffSha256='7'.repeat(64);
    if(change==='check-definition')candidate.observation.scope.requiredChecks[0].definitionSha256='7'.repeat(64);
    if(change==='comparison-evidence')candidate.observation.scope.expectedComparison.verificationEvidence.sha256='7'.repeat(64);
    if(change==='action')candidate.plan.actions[0].targetId='different-target';
    if(change==='request'){candidate.canonicalRequestDigest='7'.repeat(64);candidate.plan.request.canonicalRequestSha256=candidate.canonicalRequestDigest;}
    candidate.plan.scope=structuredClone(candidate.observation.scope);candidate.binding=reconciliationAttemptBinding(candidate.observation);
    const projected=projectRetainedReconciliationReview(candidate);assert.equal(projected.complete,true,change);assert.notEqual(projected.sha256,original.sha256,change);
  }
  const oversized=structuredClone(f.attempt) as any;oversized.plan.summary='x'.repeat(64*1024);
  assert.deepEqual(projectRetainedReconciliationReview(oversized),{complete:false,sha256:null,payload:null,reasonCode:'review-too-large'});
  const manyPaths=structuredClone(f.attempt) as any;manyPaths.observation.scope.affectedPaths=Array.from({length:129},(_,i)=>({...manyPaths.observation.scope.affectedPaths[0],path:'path-'+String(i).padStart(3,'0')}));manyPaths.plan.scope=manyPaths.observation.scope;manyPaths.binding=reconciliationAttemptBinding(manyPaths.observation);
  assert.equal(projectRetainedReconciliationReview(manyPaths).reasonCode,'review-too-large');
  const raw=structuredClone(f.attempt) as any;raw.observation.scope.sourceRoot.path='/private/should-not-appear';raw.plan.scope=raw.observation.scope;raw.binding=reconciliationAttemptBinding(raw.observation);
  const incomplete=projectRetainedReconciliationReview(raw);assert.equal(incomplete.complete,false);assert.equal(incomplete.payload,null);
});

test('browser confirmation requires exact host/body pins, a gated plan and actually configured readers/writers',async(t)=>{
  const f=await browserFixture(t);
  const unselected=new MergeReconciliationDashboard(f.store,echoBindingReader(),{interactionWriter:f.adapter.writer});
  assert.equal((await unselected.confirmReviewed(f.attempt.id,f.request)).reasonCode,'host-selection-required');
  const wrongSelection=new MergeReconciliationDashboard(f.store,echoBindingReader(),{...f.options,browserReview:{selectedAttempts:[{attemptId:f.attempt.id,reviewSha256:'9'.repeat(64)}]}});
  assert.equal((await wrongSelection.confirmReviewed(f.attempt.id,f.request)).reasonCode,'host-selection-mismatch');
  assert.equal((await f.dashboard.confirmReviewed(f.attempt.id,{...f.request,reviewSha256:'9'.repeat(64)})).reasonCode,'review-digest-mismatch');
  await assert.rejects(f.dashboard.confirmReviewed(f.attempt.id,{...f.request,confirmedBy:'browser-caller'} as any),(error)=>error instanceof ReconciliationBrowserRequestError&&error.status===400);
  const noReader=new MergeReconciliationDashboard(f.store,undefined,f.options);
  assert.equal((await noReader.confirmReviewed(f.attempt.id,f.request)).reasonCode,'current-binding-reader-unavailable');
  const unavailable=new MergeReconciliationDashboard(f.store,{async readCurrentBinding(){throw new Error('Private unavailable source /secret/root');}},f.options);
  const refused=await unavailable.confirmReviewed(f.attempt.id,f.request);assert.equal(refused.outcome,'refused');assert.equal(refused.review.currentBinding.state,'unavailable');assert.doesNotMatch(JSON.stringify(refused),/secret\/root/);
  const noWriter=new MergeReconciliationDashboard(f.store,echoBindingReader(),{browserReview:f.options.browserReview});assert.equal((await noWriter.confirmReviewed(f.attempt.id,f.request)).reasonCode,'interaction-writer-unavailable');
  assert.equal(f.adapter.writes,0);assert.equal((await f.store.get(f.attempt.id))!.confirmation,null);
  const automatic=await browserFixture(t,echoBindingReader(),plan(observation(),'observed','automatic'));
  assert.equal((await automatic.dashboard.confirmReviewed(automatic.attempt.id,automatic.request)).reasonCode,'plan-not-confirmation-gated');
  const manual=await browserFixture(t,echoBindingReader(),{...plan(observation(),'blocked','manual'),classification:'manual-review',blockedReason:'manual-intervention-required'});
  assert.equal((await manual.dashboard.confirmReviewed(manual.attempt.id,manual.request)).outcome,'blocked');assert.equal(manual.adapter.writes,0);
});

test('actual immutable interaction bytes bind the confirmation; exact concurrent retry preserves one event and time',async(t)=>{
  let checks=0;const reader:CurrentReconciliationBindingReader={async readCurrentBinding({expected}){checks++;return expected;}};
  const f=await browserFixture(t,reader);
  const outcomes=await Promise.all([f.dashboard.confirmReviewed(f.attempt.id,f.request),f.dashboard.confirmReviewed(f.attempt.id,f.request)]);
  assert.deepEqual(outcomes.map((result)=>result.outcome),['recorded','replayed']);assert.equal(f.adapter.writes,1);assert.equal(checks,4);
  const identity=reconciliationInteractionIdentity(f.attempt.id,f.request.requestId),bytes=await readFile(f.adapter.filename(identity.eventId));
  const event:ReconciliationInteractionEvent=JSON.parse(bytes.toString()),retained=(await f.store.get(f.attempt.id))!;
  assert.equal(retained.confirmation!.confirmedAt,event.receivedAt);assert.equal(retained.confirmation!.confirmedBy,'local-dashboard-interaction');assert.equal(retained.confirmation!.evidence[0]!.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(retained.confirmation!.evidence[0]!.bytes,bytes.length);
  const review=await f.dashboard.review(f.attempt.id);assert.equal(review!.confirmation!.requestId,f.request.requestId);assert.equal(review!.confirmation!.actorKind,'local-dashboard-interaction');assert.equal(review!.currentBinding.state,'not-checked');assert.equal(review!.attempt.confirmationRecorded,true);assert.equal(review!.attempt.candidate.readiness,'not-ready');assert.equal(review!.capabilities.canRecordConfirmationIntent,false);assert.deepEqual(review!.effects,{mode:'recorded-intent-only',sourceOperations:'none',taskAcceptance:'none',archiveOperations:'none',terminal:false});
  assert.equal((await f.dashboard.confirmReviewed(f.attempt.id,{...f.request,requestId:'replacement-key'})).reasonCode,'confirmation-already-recorded');assert.equal(f.adapter.writes,1);assert.deepEqual(await readFile(f.adapter.filename(identity.eventId)),bytes);
});

test('interrupted event publication retains a pending interaction; only explicit same-body retry may finish it',async(t)=>{
  const f=await browserFixture(t),original=f.adapter.writer.publish.bind(f.adapter.writer);let lose=true;
  f.adapter.writer.publish=async(event)=>{await original(event);if(lose){lose=false;throw new Error('Fixture lost acknowledgment after actual write');}};
  const interrupted=await f.dashboard.confirmReviewed(f.attempt.id,f.request);assert.equal(interrupted.outcome,'refused');assert.equal((await f.store.get(f.attempt.id))!.confirmation,null);
  const identity=reconciliationInteractionIdentity(f.attempt.id,f.request.requestId),before=await readFile(f.adapter.filename(identity.eventId));
  const reopened=new MergeReconciliationDashboard(await FileMergeReconciliationStore.openExisting(f.store.root),echoBindingReader(),f.options);
  const pending=await reopened.review(f.attempt.id);assert.equal(pending!.attempt.confirmationRecorded,false);assert.equal(f.adapter.writes,1);
  const recorded=await reopened.confirmReviewed(f.attempt.id,f.request);assert.equal(recorded.outcome,'recorded');assert.deepEqual(await readFile(f.adapter.filename(identity.eventId)),before);assert.equal(f.adapter.writes,1);assert.equal(recorded.review.confirmation!.confirmedAt,JSON.parse(before.toString()).receivedAt);
});

test('binding drift after immutable event readback blocks confirmation permanently without erasing the event',async(t)=>{
  let count=0;const reader:CurrentReconciliationBindingReader={async readCurrentBinding({expected}){return ++count===1?expected:{...expected,revision:'changed-after-event'};}};
  const f=await browserFixture(t,reader),blocked=await f.dashboard.confirmReviewed(f.attempt.id,f.request);
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.review.currentBinding.state,'drift');assert.deepEqual(blocked.review.currentBinding.changedFields,['revision']);assert.equal(blocked.review.attempt.retainedStatus,'BLOCKED');assert.equal(blocked.review.confirmation,null);assert.equal(f.adapter.writes,1);
  const identity=reconciliationInteractionIdentity(f.attempt.id,f.request.requestId),bytes=await readFile(f.adapter.filename(identity.eventId));
  const matched=new MergeReconciliationDashboard(f.store,echoBindingReader(),f.options);
  assert.equal((await matched.checkCurrentBinding(f.attempt.id)).currentBinding.state,'matched');assert.equal((await matched.confirmReviewed(f.attempt.id,f.request)).outcome,'blocked');assert.equal((await f.store.get(f.attempt.id))!.confirmation,null);assert.deepEqual(await readFile(f.adapter.filename(identity.eventId)),bytes);
});

test('invalid or missing immutable readback never substitutes fabricated evidence or records confirmation',async(t)=>{
  const f=await browserFixture(t),original=f.adapter.writer.read.bind(f.adapter.writer);
  f.adapter.writer.read=async(input)=>{const retained=await original(input);return retained?{...retained,bytes:Buffer.from('{}')}:null;};
  const refused=await f.dashboard.confirmReviewed(f.attempt.id,f.request);assert.equal(refused.outcome,'refused');assert.equal(refused.reasonCode,'interaction-evidence-unavailable');assert.equal((await f.store.get(f.attempt.id))!.confirmation,null);
  f.adapter.writer.read=async()=>null;
  const missing=await new MergeReconciliationDashboard(f.store,echoBindingReader(),{...f.options,interactionWriter:{...f.adapter.writer,publish:async()=>undefined}}).confirmReviewed(f.attempt.id,{...f.request,requestId:'missing-readback'});
  assert.equal(missing.outcome,'refused');assert.equal((await f.store.get(f.attempt.id))!.confirmation,null);
});

test('confirmed history survives later invalidation and legacy external confirmation has no invented request identity',async(t)=>{
  const f=await browserFixture(t);assert.equal((await f.dashboard.confirmReviewed(f.attempt.id,f.request)).outcome,'recorded');
  const before=(await f.store.get(f.attempt.id))!.confirmation;
  const changed=new MergeReconciliationDashboard(f.store,{async readCurrentBinding({expected}){return {...expected,taskVersion:'new-version'};}},f.options);
  const blocked=await changed.checkCurrentBinding(f.attempt.id);assert.equal(blocked.attempt.retainedStatus,'BLOCKED');assert.equal(blocked.attempt.confirmationRecorded,true);assert.equal(blocked.confirmation!.requestId,f.request.requestId);assert.deepEqual((await f.store.get(f.attempt.id))!.confirmation,before);
  const external=await browserFixture(t);await external.dashboard.confirmIntent({attemptId:external.attempt.id,confirmation:confirmation(external.attempt.plan)});
  const review=await external.dashboard.review(external.attempt.id);assert.equal(review!.confirmation!.requestId,null);assert.equal(review!.confirmation!.actorKind,'retained-external-record');assert.equal(external.adapter.writes,0);
});

test('legacy reserved actor text cannot claim local dashboard provenance without an actual retained event',async(t)=>{
  const f=await browserFixture(t);
  const reserved={...confirmation(f.attempt.plan),confirmedBy:'local-dashboard-interaction'};
  await f.dashboard.confirmIntent({attemptId:f.attempt.id,confirmation:reserved});
  const review=(await f.dashboard.review(f.attempt.id))!;
  assert.equal(review.attempt.confirmationRecorded,true);assert.equal(review.confirmation!.requestId,null);
  assert.equal(review.confirmation!.actorKind,'retained-external-record');assert.equal(f.adapter.writes,0);
  assert.deepEqual((await f.store.get(f.attempt.id))!.confirmation,reserved);
});

test('missing or corrupt retained event removes local provenance without erasing historic confirmation',async(t)=>{
  const f=await browserFixture(t),recorded=await f.dashboard.confirmReviewed(f.attempt.id,f.request);
  assert.equal(recorded.outcome,'recorded');assert.equal(recorded.review.confirmation!.actorKind,'local-dashboard-interaction');
  const original=(await f.store.get(f.attempt.id))!.confirmation;
  const identity=reconciliationInteractionIdentity(f.attempt.id,f.request.requestId),path=f.adapter.filename(identity.eventId),bytes=await readFile(path);
  await unlink(path);
  const missing=(await f.dashboard.review(f.attempt.id))!;
  assert.equal(missing.confirmation!.requestId,null);assert.equal(missing.confirmation!.actorKind,'retained-external-record');assert.equal(missing.attempt.confirmationRecorded,true);
  await writeFile(path,'{}\n');
  const corrupt=(await f.dashboard.review(f.attempt.id))!;
  assert.equal(corrupt.confirmation!.requestId,null);assert.equal(corrupt.confirmation!.actorKind,'retained-external-record');assert.equal(corrupt.attempt.confirmationRecorded,true);
  assert.deepEqual((await f.store.get(f.attempt.id))!.confirmation,original);assert.equal(f.adapter.writes,1);
  await writeFile(path,bytes);
  const restored=(await f.dashboard.review(f.attempt.id))!;
  assert.equal(restored.confirmation!.requestId,f.request.requestId);assert.equal(restored.confirmation!.actorKind,'local-dashboard-interaction');assert.equal(f.adapter.writes,1);
});
