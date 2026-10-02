import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  FileSourceHeadStore,
  sourceHeadDigest,
  type SourceHeadPin,
  type SourceHeadCompletionProof,
} from './source-head-store.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function saved(path: string, value: unknown): Promise<string> {
  const bytes = canonical(value);
  await writeFile(path, bytes);
  return sha(bytes);
}
async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-source-head-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const taskDirectory = join(base, 'task');
  await mkdir(taskDirectory);
  const root = join(base, 'heads');
  const store = await FileSourceHeadStore.create(root);
  const registration = 'admitted-local-source';
  async function publication(version: number): Promise<SourceHeadPin> {
    const sourceId = 'source-a',
      sourceLocator = `file://${base}/sources`;
    const taskId = 'task-a',
      generation = version.toString(16).padStart(32, '0'),
      manifestSha256 = version.toString(16).padStart(64, '0');
    const captureRequestKey = `capture-${version}`;
    const publicationPath = join(taskDirectory, `publication-${version}.json`);
    const publicationSha256 = await saved(publicationPath, {
      schema: 1,
      kind: 'temari-archive-publication',
      task: { id: taskId, directory: taskDirectory },
      source: { id: sourceId, locator: sourceLocator },
      generation,
      manifestSha256,
      registration,
      captureRequestKey,
      preservation: 'complete-admitted',
    });
    return {
      sourceId,
      sourceLocator,
      taskId,
      taskDirectory,
      publicationPath,
      publicationSha256,
      generation,
      manifestSha256,
      registrationSha256: sourceHeadDigest(registration),
      captureRequestKey,
    };
  }
  return {
    base,
    root,
    store,
    taskDirectory,
    before: await publication(1),
    after: await publication(2),
    third: await publication(3),
    publication,
  };
}
async function proofFor(
  f: Awaited<ReturnType<typeof fixture>>,
  reservationId: string,
  before: SourceHeadPin = f.before,
  after: SourceHeadPin = f.after,
  suffix = '',
) {
  const freshnessStagePath = join(
    f.taskDirectory,
    `freshness-stage${suffix}.json`,
  );
  const refreshStagePath = join(f.taskDirectory, `refresh-stage${suffix}.json`);
  const handoffReceiptPath = join(f.taskDirectory, `handoff${suffix}.json`);
  const freshnessStageSha256 = await saved(freshnessStagePath, {
    schema: 1,
    kind: 'temari-archive-freshness-job-stage',
    decision: 'recapture-needed',
  });
  const handoffReceiptSha256 = await saved(handoffReceiptPath, {
    schema: 1,
    kind: 'temari-archive-source-recapture',
    status: 'handoff',
    before: {
      publicationPath: before.publicationPath,
      publicationSha256: before.publicationSha256,
      generation: before.generation,
      manifestSha256: before.manifestSha256,
    },
    after: {
      publicationPath: after.publicationPath,
      publicationSha256: after.publicationSha256,
      generation: after.generation,
      manifestSha256: after.manifestSha256,
    },
  });
  const refreshStageSha256 = await saved(refreshStagePath, {
    schema: 1,
    kind: 'temari-archive-refresh-handoff-stage',
    graphMutation: 'none',
    handoffReceiptPath,
    handoffReceiptSha256,
    afterPublicationPath: after.publicationPath,
    afterPublicationSha256: after.publicationSha256,
  });
  const completion: SourceHeadCompletionProof = {
    schema: 1,
    kind: 'temari-source-cycle-completion',
    reservationId,
    before,
    after,
    freshnessStagePath,
    freshnessStageSha256,
    refreshStagePath,
    refreshStageSha256,
    handoffReceiptPath,
    handoffReceiptSha256,
  };
  const proofPath = join(f.taskDirectory, `completion${suffix}.json`);
  const proofSha256 = await saved(proofPath, completion);
  return {
    reservationId,
    before,
    after,
    proofPath,
    proofSha256,
  };
}

test('source-head CAS replays exact reservation and advance, then rejects stale prior', async (t) => {
  const f = await fixture(t);
  const initial = await f.store.initialize(f.before);
  assert.equal(initial.status, 'READY');
  await assert.rejects(
    f.store.hold(f.before, 'f'.repeat(64), 'unknown-outcome'),
    /Hold requires a reservation/,
  );
  const cycleKey = 'a'.repeat(64);
  const reservation = await f.store.reserve(f.before, cycleKey);
  assert.equal(reservation.status, 'RESERVED');
  assert.deepEqual(
    await (
      await FileSourceHeadStore.create(f.root)
    ).reserve(f.before, cycleKey),
    reservation,
  );
  await assert.rejects(f.store.reserve(f.before, 'b'.repeat(64)), /conflict/);
  const proof = await proofFor(f, reservation.reservation.id);
  const advanced = await f.store.advance(proof);
  assert.equal(advanced.status, 'READY');
  assert.deepEqual(advanced.head, f.after);
  assert.deepEqual(
    await (await FileSourceHeadStore.create(f.root)).advance(proof),
    advanced,
  );
  await assert.rejects(f.store.reserve(f.before, cycleKey), /conflict/);
  assert.equal(
    (await f.store.reserve(f.after, 'c'.repeat(64))).status,
    'RESERVED',
  );
});

test('source-head refuses changed completion evidence before advance', async (t) => {
  const f = await fixture(t);
  await f.store.initialize(f.before);
  const state = await f.store.reserve(f.before, 'a'.repeat(64));
  assert.equal(state.status, 'RESERVED');
  const request = await proofFor(f, state.reservation.id);
  const refreshPath = join(f.taskDirectory, 'refresh-stage.json');
  const original = await readFile(refreshPath);
  await writeFile(refreshPath, canonical({ changed: true }));
  await assert.rejects(f.store.advance(request));
  assert.equal((await f.store.load(f.before.sourceId))?.status, 'RESERVED');
  await writeFile(refreshPath, original);
  assert.equal((await f.store.advance(request)).status, 'READY');
});

test('source-head last allowed advance remains readable and next reserve writes nothing', async (t) => {
  const f = await fixture(t);
  await f.store.initialize(f.before);
  let before = f.before;
  for (let version = 2; version <= 65; version++) {
    const after = await f.publication(version);
    const reserved = await f.store.reserve(
      before,
      version.toString(16).padStart(64, '0'),
    );
    assert.equal(reserved.status, 'RESERVED');
    const completed = await proofFor(
      f,
      reserved.reservation.id,
      before,
      after,
      `-${version}`,
    );
    const advanced = await f.store.advance(completed);
    assert.equal(advanced.status, 'READY');
    assert.deepEqual(advanced.head, after);
    before = after;
  }
  assert.equal((await f.store.load(f.before.sourceId))?.status, 'READY');
  const ledgerDirectory = join(f.root, sourceHeadDigest(f.before.sourceId));
  const entriesBefore = await readdir(ledgerDirectory);
  await assert.rejects(
    f.store.reserve(before, 'f'.repeat(64)),
    /capacity exhausted/,
  );
  assert.deepEqual(await readdir(ledgerDirectory), entriesBefore);
});

test('concurrent distinct reservations choose one cycle and hold versus advance chooses one terminal slot', async (t) => {
  const f = await fixture(t);
  await f.store.initialize(f.before);
  const pair = await Promise.allSettled([
    f.store.reserve(f.before, 'a'.repeat(64)),
    (await FileSourceHeadStore.create(f.root)).reserve(
      f.before,
      'b'.repeat(64),
    ),
  ]);
  assert.equal(
    pair.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const current = await f.store.load(f.before.sourceId);
  assert(current?.status === 'RESERVED');
  const proof = await proofFor(f, current.reservation.id);
  const terminal = await Promise.allSettled([
    f.store.advance(proof),
    (await FileSourceHeadStore.create(f.root)).hold(
      f.before,
      'd'.repeat(64),
      'conflict',
    ),
  ]);
  assert.equal(
    terminal.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const settled = await f.store.load(f.before.sourceId);
  assert(settled?.status === 'READY' || settled?.status === 'HELD');
  if (settled.status === 'READY') assert.deepEqual(settled.head, f.after);
  else {
    assert.deepEqual(settled.head, f.before);
    await assert.rejects(f.store.advance(proof), /conflict|held/i);
    assert.deepEqual(
      await f.store.hold(f.before, 'd'.repeat(64), 'conflict'),
      settled,
    );
  }
});

test('missing, tampered and orphan source-head artifacts fail closed', async (t) => {
  const f = await fixture(t);
  await f.store.initialize(f.before);
  const directory = join(f.root, sourceHeadDigest(f.before.sourceId));
  await writeFile(join(directory, 'reservation-orphan.json'), '{}');
  await assert.rejects(f.store.load(f.before.sourceId), /Orphan/);
  await unlink(join(directory, 'reservation-orphan.json'));
  const original = await readFile(f.before.publicationPath);
  await writeFile(f.before.publicationPath, canonical({ changed: true }));
  await assert.rejects(f.store.reserve(f.before, 'e'.repeat(64)), /changed/);
  await writeFile(f.before.publicationPath, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(
    f.store.load(f.before.sourceId),
    /Invalid source-head artifact|exceeds bound/,
  );
  await writeFile(f.before.publicationPath, original);
  await unlink(join(directory, 'source.json'));
  await assert.rejects(
    FileSourceHeadStore.create(f.root).then((store) =>
      store.load(f.before.sourceId),
    ),
  );
});
