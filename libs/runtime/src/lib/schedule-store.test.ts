import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { FileScheduleStore, parseScheduleCadence, scheduleDigest, scheduleOccurrenceIdentity } from './schedule-store.js';

const at = '2026-10-01T10:00:00.000Z';
const target = { id: 'verify', title: 'Verify dashboard', goal: 'Run the configured checks.', pin: 'a'.repeat(64) };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-schedule-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const directory = join(root, 'schedules');
  const store = await FileScheduleStore.create(directory, workspace);
  const create = () => store.createSchedule({ requestId: 'first', target, cadence: { kind: 'interval', anchor: at, everyMs: 60_000 } }, new Date(at));
  return { root, directory, workspace, store, create };
}

test('durable schedule creation and optimistic status commands are idempotent across reopening', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const duplicate = await f.create();
  assert.deepEqual(duplicate, created);
  const pause = { requestId: 'pause-first', expectedVersion: 1, action: 'pause' as const };
  const paused = await f.store.update(created.id, pause, new Date(at));
  assert.equal(paused.status, 'PAUSED');
  const reopened = await FileScheduleStore.create(f.directory, f.workspace);
  assert.deepEqual(await reopened.update(created.id, pause), paused);
  await assert.rejects(reopened.update(created.id, { ...pause, action: 'cancel' }), /idempotency conflict/);
  await assert.rejects(reopened.update(created.id, { requestId: 'old-version', expectedVersion: 1, action: 'resume' }), /version conflict/);
  const resumed = await reopened.update(created.id, { requestId: 'resume', expectedVersion: 2, action: 'resume' });
  const cancelled = await reopened.update(created.id, { requestId: 'cancel', expectedVersion: resumed.version, action: 'cancel' });
  assert.equal(cancelled.status, 'CANCELLED');
  await assert.rejects(reopened.update(created.id, { requestId: 'later', expectedVersion: cancelled.version, action: 'resume' }), /cannot be resumed/);
  await assert.rejects(f.store.createSchedule({ requestId: 'first', target: { ...target, pin: 'b'.repeat(64) }, cadence: created.cadence }), /idempotency conflict/);
});

test('concurrent transactions preserve every independently created schedule', async (t) => {
  const f = await fixture(t);
  const stores = await Promise.all([FileScheduleStore.create(f.directory, f.workspace), FileScheduleStore.create(f.directory, f.workspace)]);
  await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].createSchedule({ requestId: `create-${index}`, target, cadence: { kind: 'once', at } })));
  const records = await f.store.list();
  assert.equal(records.length, 12);
  assert.equal(new Set(records.map((item) => item.id)).size, 12);
});

test('occurrence intent, exact dispatch version and cursor are durable and immutable', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  const occurrence = await f.store.claimOccurrence(record.id, at, 0, 'INTENT', null, new Date(at));
  assert(occurrence);
  assert.deepEqual(await f.store.claimOccurrence(record.id, at, 0, 'INTENT', null), occurrence);
  assert.deepEqual({ id: occurrence.id, requestId: occurrence.requestId, taskId: occurrence.taskId, startRequestId: occurrence.startRequestId }, scheduleOccurrenceIdentity(record.id, at));
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'PREPARED', issue: null });
  const starting = await f.store.updateOccurrence(record.id, occurrence.id, { state: 'STARTING', expectedVersion: 2, issue: null });
  const reopened = await FileScheduleStore.create(f.directory, f.workspace);
  assert.deepEqual((await reopened.get(record.id))?.occurrences[0], starting);
  await assert.rejects(reopened.updateOccurrence(record.id, occurrence.id, { state: 'ACTIVE', expectedVersion: 3, issue: null }), /immutable/);
  await assert.rejects(reopened.updateOccurrence(record.id, occurrence.id, { state: 'INTENT', issue: null }), /Invalid.*transition/);
  assert.equal(await reopened.claimOccurrence(record.id, '2026-10-01T09:59:00.000Z', 0, 'INTENT', null), null);
  await assert.rejects(reopened.claimOccurrence(record.id, '2026-10-01T10:00:30.000Z', 0, 'INTENT', null), /not aligned/);
});

test('identical occurrence observations preserve bytes, timestamps and optimistic version while actual changes remain durable', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  const occurrence = await f.store.claimOccurrence(record.id, at, 0, 'INTENT', null, new Date(at));
  assert(occurrence);
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'PREPARED', issue: null }, new Date(at));
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'STARTING', expectedVersion: 2, issue: null }, new Date(at));
  const active = await f.store.updateOccurrence(record.id, occurrence.id, { state: 'ACTIVE', issue: null }, new Date(at));
  const before = await f.store.get(record.id);
  const bytes = await readFile(join(f.directory, 'schedules.json'));
  for (let tick = 1; tick <= 12; tick++) {
    assert.deepEqual(await f.store.updateOccurrence(record.id, occurrence.id, { state: 'ACTIVE', issue: null }, new Date(Date.parse(at) + tick * 1000)), active);
  }
  assert.deepEqual(await f.store.get(record.id), before);
  assert.deepEqual(await readFile(join(f.directory, 'schedules.json')), bytes);
  const uncertain = await f.store.updateOccurrence(record.id, occurrence.id, { state: 'UNCERTAIN', issue: 'Cancellation remains pending.' }, new Date(Date.parse(at) + 13_000));
  const changed = (await f.store.get(record.id))!;
  assert.equal(changed.version, before!.version + 1);
  assert.equal(changed.occurrences[0].issue, 'Cancellation remains pending.');
  for (let tick = 14; tick <= 20; tick++) {
    assert.deepEqual(await f.store.updateOccurrence(record.id, occurrence.id, { state: 'UNCERTAIN', issue: uncertain.issue, expectedVersion: 2 }, new Date(Date.parse(at) + tick * 1000)), uncertain);
  }
  assert.deepEqual(await f.store.get(record.id), changed);
  const completedAt = new Date(Date.parse(at) + 21_000);
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'TERMINAL', issue: null }, completedAt);
  const reopened = await FileScheduleStore.create(f.directory, f.workspace);
  const completed = (await reopened.get(record.id))!;
  assert.equal(completed.version, changed.version + 1);
  assert.equal(completed.occurrences[0].state, 'TERMINAL');
  assert.equal(completed.occurrences[0].updatedAt, completedAt.toISOString());
});

test('future controls accept only occurrence telemetry drift and preserve exact replay while rejecting settings races', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  const occurrence = await f.store.claimOccurrence(record.id, at, 0, 'INTENT', null, new Date(at));
  assert(occurrence);
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'PREPARED', issue: null });
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'STARTING', expectedVersion: 2, issue: null });
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'ACTIVE', issue: null });
  const browser = (await f.store.get(record.id))!;
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'TERMINAL', issue: null });
  const terminal = (await f.store.get(record.id))!;
  assert.equal(terminal.version, browser.version + 1);
  const command = { requestId: 'pause-after-completion', expectedVersion: browser.version, action: 'pause' as const };
  const paused = await f.store.update(record.id, command);
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.version, terminal.version + 1);
  assert.equal(paused.occurrences[0].state, 'TERMINAL');
  assert.deepEqual(await f.store.update(record.id, command), paused);
  await assert.rejects(f.store.update(record.id, { requestId: 'future-version', expectedVersion: paused.version + 1, action: 'resume' }), /version conflict/);
  await assert.rejects(f.store.update(record.id, { requestId: 'stale-resume', expectedVersion: browser.version, action: 'resume' }), /version conflict/);
  const resumed = await f.store.update(record.id, { requestId: 'current-resume', expectedVersion: paused.version, action: 'resume' });
  assert.equal(resumed.status, 'ACTIVE');
  // Returning to the same ACTIVE status does not erase the intervening human
  // pause/resume decisions, so another stale tab cannot overwrite them.
  await assert.rejects(f.store.update(record.id, { requestId: 'stale-pause', expectedVersion: browser.version, action: 'pause' }), /version conflict/);
  assert.deepEqual(await f.store.update(record.id, command), resumed);
  await assert.rejects(f.store.update(record.id, { ...command, expectedVersion: terminal.version }), /idempotency conflict/);
});

test('one tick owns external effects; concurrent callers do not wait and launch twice', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = f.store.withTickLock(async () => { entered(); await gate; return 1; });
  await entry;
  const second = await (await FileScheduleStore.create(f.directory, f.workspace)).withTickLock(async () => 2);
  assert.deepEqual(second, { busy: true });
  release();
  assert.deepEqual(await first, { busy: false, result: 1 });
  assert.deepEqual(await f.store.withTickLock(async () => 3), { busy: false, result: 3 });
});

test('restart recovers a proven dead local tick owner without stealing a foreign/live owner', async (t) => {
  const f = await fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const owner = { schema: 1, host: hostname(), pid: Number(stdout.trim()), token: randomUUID() };
  await writeFile(join(f.directory, '.tick.lock'), JSON.stringify(owner));
  assert.deepEqual(await f.store.withTickLock(async () => 'recovered'), { busy: false, result: 'recovered' });
  await writeFile(join(f.directory, '.tick.lock'), JSON.stringify({ ...owner, pid: process.pid }));
  assert.deepEqual(await f.store.withTickLock(async () => 'wrong'), { busy: true });
  await writeFile(join(f.directory, '.tick.lock'), JSON.stringify({ ...owner, host: 'another-machine' }));
  assert.deepEqual(await f.store.withTickLock(async () => 'wrong'), { busy: true });
});

test('missing, corrupt and workspace-mismatched retained ledgers fail visibly', async (t) => {
  const f = await fixture(t);
  await f.create();
  const path = join(f.directory, 'schedules.json');
  const bytes = await readFile(path);
  await writeFile(path, '{');
  await assert.rejects(f.store.list(), /JSON|Unexpected/);
  await writeFile(path, bytes);
  const changed = JSON.parse(bytes.toString());
  changed.ledger.schedules[0].target.title = 'Changed';
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(f.store.list(), /checksum mismatch/);
  changed.sha256 = scheduleDigest(changed.ledger);
  changed.ledger.schedules[0].version = 3;
  changed.sha256 = scheduleDigest(changed.ledger);
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(f.store.list());
  await unlink(path);
  await assert.rejects(FileScheduleStore.create(f.directory, f.workspace), /ledger is missing/);
  await writeFile(path, bytes);
  const otherWorkspace = join(f.root, 'other');
  await mkdir(otherWorkspace);
  await assert.rejects(FileScheduleStore.create(f.directory, otherWorkspace), /workspace is invalid/);
  await unlink(join(f.directory, '.schedule-store.json'));
  await assert.rejects(FileScheduleStore.create(f.directory, f.workspace), /marker is missing/);
});

test('symlink ledger and untyped extra schedule fields are rejected', async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, 'schedules.json');
  await renameForTest(path, join(f.root, 'outside.json'));
  await symlink(join(f.root, 'outside.json'), path);
  await assert.rejects(f.store.list(), /ELOOP/);
  assert.throws(() => parseScheduleCadence({ kind: 'once', at, command: 'anything' }), /Unexpected/);
  assert.throws(() => parseScheduleCadence({ kind: 'interval', anchor: at, everyMs: 1000 }), /one minute/);
  assert.throws(() => parseScheduleCadence({ kind: 'once', at: '2026-10-01T03:00:00-07:00' }), /UTC ISO/);
});

async function renameForTest(from: string, to: string) { const { rename } = await import('node:fs/promises'); await rename(from, to); }
