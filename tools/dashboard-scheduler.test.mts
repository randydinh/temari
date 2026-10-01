import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FileScheduleStore, type ScheduleRecord, type ScheduleTarget } from '../libs/runtime/src/lib/schedule-store.js';
import { createDashboardScheduler, latestScheduleDue, nextScheduleDue, parseDashboardScheduleCreate, type DashboardScheduleDispatcher, type ScheduledTaskInspection } from './dashboard-scheduler.mjs';

const anchor = '2026-10-01T10:00:00.000Z';
const minute = (offset: number) => new Date(Date.parse(anchor) + offset * 60_000);
const target: ScheduleTarget = { id: 'verify', title: 'Verify dashboard', goal: 'Run the fixed reviewed checks.', pin: 'a'.repeat(64) };
type MockTask = ScheduledTaskInspection & { starts: string[] };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-dashboard-scheduler-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = await FileScheduleStore.create(join(root, 'schedules'), workspace);
  const tasks = new Map<string, MockTask>();
  let targets: ScheduleTarget[] = [target];
  let now = minute(0);
  let createCalls = 0;
  let startCalls = 0;
  const dispatcher: DashboardScheduleDispatcher = {
    async describeTargets() { return targets; },
    async create(input) {
      createCalls++;
      assert.equal(input.recipeId, 'verify');
      const taskId = `task-${input.requestId}`;
      let task = tasks.get(taskId);
      if (!task) {
        task = { taskId, version: 2, state: 'prepared', startAllowed: true, intent: 'absent', starts: [] };
        tasks.set(taskId, task);
      }
      return task;
    },
    async inspect(taskId, requestId) {
      const task = tasks.get(taskId);
      assert(task, 'Mock task is missing.');
      if (requestId && task.starts.length) assert(task.starts.includes(requestId), 'Inspect must use the exact retained start.');
      return { ...task };
    },
    async start(taskId, input) {
      startCalls++;
      const task = tasks.get(taskId)!;
      assert.equal(task.version, input.expectedVersion);
      assert.equal(task.starts.length, 0, 'Duplicate native launch.');
      tasks.set(taskId, { ...task, starts: [input.requestId], version: 3, state: 'active', startAllowed: false, intent: 'confirmed' });
    },
  };
  const scheduler = createDashboardScheduler({ store, dispatcher, now: () => now });
  const create = (requestId = 'scheduled-check', once = false) => scheduler.create({ requestId, targetId: 'verify', cadence: once ? { kind: 'once', at: anchor } : { kind: 'interval', anchor, everyMs: 60_000 } });
  const get = async (id: string) => (await store.get(id))!;
  return { root, workspace, store, scheduler, dispatcher, tasks, create, get, setNow: (date: Date) => { now = date; }, setTargets: (values: ScheduleTarget[]) => { targets = values; }, counts: () => ({ createCalls, startCalls }) };
}

test('once recipe executes from durable intent exactly once across restart and retains review separation', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create('once', true);
  const result = await f.scheduler.tick();
  assert.deepEqual(result.issues, []);
  assert.equal(result.occurrences[0].state, 'ACTIVE');
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
  const occurrence = (await f.get(schedule.id)).occurrences[0];
  assert.equal(occurrence.expectedVersion, 2);
  const reopenedStore = await FileScheduleStore.create(f.store.root, f.workspace);
  const restarted = createDashboardScheduler({ store: reopenedStore, dispatcher: f.dispatcher });
  await restarted.tick(minute(10));
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
  f.tasks.set(occurrence.taskId, { ...f.tasks.get(occurrence.taskId)!, state: 'terminal', version: 4 });
  await restarted.tick(minute(11));
  const terminal = await f.get(schedule.id);
  assert.equal(terminal.occurrences[0].state, 'TERMINAL');
  assert.equal(terminal.occurrences.length, 1);
  assert.equal(Object.hasOwn(terminal, 'acceptance'), false);
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
});

test('missed intervals coalesce latest, skip overlapping active execution and never rewind on clock rollback', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  f.setNow(minute(7));
  await f.scheduler.tick();
  let record = await f.get(schedule.id);
  assert.equal(record.occurrences.length, 1);
  assert.equal(record.occurrences[0].dueAt, minute(7).toISOString());
  assert.equal(record.occurrences[0].coalescedCount, 7);
  f.setNow(minute(9));
  await f.scheduler.tick();
  record = await f.get(schedule.id);
  assert.equal(record.occurrences[1].state, 'SKIPPED_OVERLAP');
  assert.equal(record.occurrences[1].coalescedCount, 1);
  assert.match(record.occurrences[1].issue!, /still owns/);
  f.setNow(minute(5));
  await f.scheduler.tick();
  assert.equal((await f.get(schedule.id)).occurrences.length, 2);
  const task = f.tasks.get(record.occurrences[0].taskId)!;
  f.tasks.set(task.taskId, { ...task, state: 'terminal', version: 4 });
  f.setNow(minute(10));
  await f.scheduler.tick();
  record = await f.get(schedule.id);
  assert.equal(record.occurrences[0].state, 'TERMINAL');
  assert.equal(record.occurrences[2].state, 'ACTIVE');
  assert.deepEqual(f.counts(), { createCalls: 2, startCalls: 2 });
});

test('concurrent ticks on two scheduler instances launch one occurrence', async (t) => {
  const f = await fixture(t);
  await f.create();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const original = f.dispatcher.create;
  f.dispatcher.create = async (input) => { entered(); await gate; return original(input); };
  const first = f.scheduler.tick();
  await entry;
  const other = createDashboardScheduler({ store: await FileScheduleStore.create(f.store.root, f.workspace), dispatcher: f.dispatcher });
  assert.equal((await other.tick(minute(0))).busy, true);
  release();
  await first;
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
  await other.tick(minute(0));
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
});

test('one-second ticks with advancing canonical task versions do not grow unchanged schedule history', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  await f.scheduler.tick(minute(0));
  const active = await f.get(record.id);
  const originalInspect = f.dispatcher.inspect;
  f.dispatcher.inspect = async (taskId, startRequestId) => {
    const task = f.tasks.get(taskId)!;
    f.tasks.set(taskId, { ...task, version: task.version + 1 });
    return originalInspect(taskId, startRequestId);
  };
  for (let tick = 1; tick <= 12; tick++) {
    const outcome = await f.scheduler.tick(new Date(Date.parse(anchor) + tick * 1000));
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.occurrences[0].state, 'ACTIVE');
  }
  assert.deepEqual(await f.get(record.id), active);
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
  const occurrence = active.occurrences[0];
  f.tasks.set(occurrence.taskId, { ...f.tasks.get(occurrence.taskId)!, state: 'terminal' });
  await f.scheduler.tick(new Date(Date.parse(anchor) + 13_000));
  const completed = await f.get(record.id);
  assert.equal(completed.version, active.version + 1);
  assert.equal(completed.events.length, active.events.length + 1);
  assert.equal(completed.occurrences[0].state, 'TERMINAL');
});

test('crash after canonical create resumes the same deterministic task rather than creating another', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  const original = f.dispatcher.create;
  let fail = true;
  f.dispatcher.create = async (input) => {
    const task = await original(input);
    if (fail) { fail = false; throw new Error('Process exited after task creation.'); }
    return task;
  };
  await f.scheduler.tick();
  let record = await f.get(schedule.id);
  assert.equal(record.occurrences[0].state, 'INTENT');
  assert.match(record.occurrences[0].issue!, /exited after/);
  const restarted = createDashboardScheduler({ store: await FileScheduleStore.create(f.store.root, f.workspace), dispatcher: f.dispatcher });
  await restarted.tick(minute(0));
  record = await f.get(schedule.id);
  assert.equal(record.occurrences[0].state, 'ACTIVE');
  assert.equal(f.tasks.size, 1);
  assert.deepEqual(f.counts(), { createCalls: 2, startCalls: 1 });
});

async function retainStarting(f: Awaited<ReturnType<typeof fixture>>, record: ScheduleRecord) {
  const occurrence = await f.store.claimOccurrence(record.id, anchor, 0, 'INTENT', null, minute(0));
  assert(occurrence);
  await f.dispatcher.create({ requestId: occurrence.requestId, recipeId: record.target.id });
  await f.store.updateOccurrence(record.id, occurrence.id, { state: 'PREPARED', issue: null }, minute(0));
  return f.store.updateOccurrence(record.id, occurrence.id, { state: 'STARTING', expectedVersion: 2, issue: null }, minute(0));
}

test('restart between retained start and invocation uses the original command/version once', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  const starting = await retainStarting(f, schedule);
  const restarted = createDashboardScheduler({ store: await FileScheduleStore.create(f.store.root, f.workspace), dispatcher: f.dispatcher });
  await restarted.tick(minute(0));
  assert.equal((await f.get(schedule.id)).occurrences[0].state, 'ACTIVE');
  assert.deepEqual(f.tasks.get(starting.taskId)!.starts, [starting.startRequestId]);
  await restarted.tick(minute(0));
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
});

test('restart after start reached executor recognizes exact receipt and never invokes start twice', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  const starting = await retainStarting(f, schedule);
  await f.dispatcher.start(starting.taskId, { requestId: starting.startRequestId, expectedVersion: 2 });
  const restarted = createDashboardScheduler({ store: await FileScheduleStore.create(f.store.root, f.workspace), dispatcher: f.dispatcher });
  await restarted.tick(minute(0));
  assert.equal((await f.get(schedule.id)).occurrences[0].state, 'ACTIVE');
  assert.deepEqual(f.counts(), { createCalls: 1, startCalls: 1 });
});

test('uncertain and pending starts block later occurrences without automatically retrying or cancelling owned work', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  f.dispatcher.start = async (taskId, input) => {
    const task = f.tasks.get(taskId)!;
    f.tasks.set(taskId, { ...task, starts: [input.requestId], version: 3, state: 'uncertain', intent: 'pending', issue: 'Executor response was lost.' });
    throw new Error('Start acknowledgement was lost.');
  };
  await f.scheduler.tick();
  const record = await f.get(schedule.id);
  assert.equal(record.occurrences[0].state, 'UNCERTAIN');
  await f.scheduler.tick(minute(1));
  const blocked = await f.get(schedule.id);
  assert.equal(blocked.occurrences[1].state, 'SKIPPED_OVERLAP');
  assert.equal(f.tasks.size, 1);
  await f.scheduler.update(schedule.id, { requestId: 'cancel-future', expectedVersion: blocked.version, action: 'cancel' });
  await f.scheduler.tick(minute(2));
  assert.equal((await f.get(schedule.id)).status, 'CANCELLED');
  assert.equal(f.tasks.get(record.occurrences[0].taskId)!.state, 'uncertain');
  assert.equal((await f.get(schedule.id)).occurrences.length, 2);
});

test('a changed task version before invocation is quarantined rather than replacing the retained version', async (t) => {
  const f = await fixture(t);
  const schedule = await f.create();
  const starting = await retainStarting(f, schedule);
  const task = f.tasks.get(starting.taskId)!;
  f.tasks.set(task.taskId, { ...task, version: 3 });
  await f.scheduler.tick(minute(0));
  const occurrence = (await f.get(schedule.id)).occurrences[0];
  assert.equal(occurrence.state, 'UNCERTAIN');
  assert.equal(occurrence.expectedVersion, 2);
  assert.match(occurrence.issue!, /version changed/);
  assert.equal(f.counts().startCalls, 0);
});

test('pause prevents dispatch, resume coalesces elapsed time, and cancellation does not invoke an active-task cancel', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  let current = await f.scheduler.update(record.id, { requestId: 'pause', expectedVersion: record.version, action: 'pause' });
  await f.scheduler.tick(minute(8));
  assert.equal((await f.get(record.id)).occurrences.length, 0);
  current = await f.scheduler.update(record.id, { requestId: 'resume', expectedVersion: current.version, action: 'resume' });
  await f.scheduler.tick(minute(9));
  current = await f.get(record.id);
  assert.equal(current.occurrences[0].coalescedCount, 9);
  const taskId = current.occurrences[0].taskId;
  await f.scheduler.update(record.id, { requestId: 'cancel', expectedVersion: current.version, action: 'cancel' });
  await f.scheduler.tick(minute(10));
  assert.equal(f.tasks.get(taskId)!.state, 'active');
  assert.equal((await f.get(record.id)).occurrences.length, 1);
});

test('cancellation during preparation prevents the previously admitted start from running', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  const original = f.dispatcher.create;
  f.dispatcher.create = async (input) => {
    const task = await original(input);
    const current = await f.get(record.id);
    await f.scheduler.update(record.id, { requestId: 'cancel-during-create', expectedVersion: current.version, action: 'cancel' });
    return task;
  };
  await f.scheduler.tick(minute(0));
  assert.equal(f.counts().startCalls, 0);
  await f.scheduler.tick(minute(1));
  assert.equal((await f.get(record.id)).occurrences[0].state, 'CANCELLED');
});

test('removed or changed host recipe pins block new effects while retained running tasks remain observable', async (t) => {
  const f = await fixture(t);
  const record = await f.create();
  f.setTargets([{ ...target, pin: 'b'.repeat(64) }]);
  const blocked = await f.scheduler.tick(minute(0));
  assert.match(blocked.issues[0].message, /removed or changed/);
  assert.equal(f.counts().createCalls, 0);
  f.setTargets([target]);
  await f.scheduler.tick(minute(0));
  const occurrence = (await f.get(record.id)).occurrences[0];
  f.tasks.set(occurrence.taskId, { ...f.tasks.get(occurrence.taskId)!, state: 'terminal' });
  f.setTargets([]);
  await f.scheduler.tick(minute(1));
  assert.equal((await f.get(record.id)).occurrences[0].state, 'TERMINAL');
  assert.equal((await f.get(record.id)).occurrences.length, 1);
  assert.equal(f.counts().startCalls, 1);
});

test('scheduler input cannot inject commands, paths, coding modes or malformed clock policies', async (t) => {
  const f = await fixture(t);
  assert.throws(() => parseDashboardScheduleCreate({ requestId: 'unsafe', targetId: 'verify', cadence: { kind: 'once', at: anchor }, command: ['sh'] }), /Unexpected/);
  await assert.rejects(f.scheduler.create({ requestId: 'unsafe', targetId: 'verify', cadence: { kind: 'once', at: anchor }, mode: 'implementation' }), /Unexpected/);
  await assert.rejects(f.scheduler.create({ requestId: 'unsafe', targetId: '../../command', cadence: { kind: 'once', at: anchor } }), /Invalid schedule ID/);
  await assert.rejects(f.scheduler.create({ requestId: 'unsafe', targetId: 'unconfigured', cadence: { kind: 'once', at: anchor } }), /Unknown scheduled/);
  const record = await f.create();
  assert.equal(latestScheduleDue(record, minute(-1)), null);
  await assert.rejects(f.scheduler.update(record.id, { requestId: 'change', expectedVersion: 1, action: 'resume', recipeId: 'other' }), /Unexpected/);
});

test('next due and available actions are read projections without changing durable history', async (t) => {
  const f = await fixture(t);
  const interval = await f.create('interval');
  assert.equal(nextScheduleDue(interval, minute(-1)), anchor);
  assert.equal(nextScheduleDue(interval, minute(4)), minute(4).toISOString());
  await f.scheduler.tick(minute(4));
  const after = await f.get(interval.id);
  assert.equal(nextScheduleDue(after, minute(4)), minute(5).toISOString());
  assert.equal(nextScheduleDue(after, minute(2)), minute(5).toISOString());
  const once = await f.create('once', true);
  assert.equal(nextScheduleDue(once, minute(-1)), anchor);
  await f.scheduler.tick(minute(4));
  assert.equal(nextScheduleDue(await f.get(once.id), minute(4)), null);
  const paused = await f.scheduler.update(interval.id, { requestId: 'pause-projection', expectedVersion: (await f.get(interval.id)).version, action: 'pause' });
  assert.equal(nextScheduleDue(paused, minute(6)), null);
  const before = await f.store.list();
  const projection = await f.scheduler.describe() as { schedules: (ScheduleRecord & { actions: string[]; nextDueAt: string | null })[] };
  assert.deepEqual(projection.schedules.find((record) => record.id === interval.id)?.actions, ['resume', 'cancel']);
  assert.equal(projection.schedules.find((record) => record.id === interval.id)?.nextDueAt, null);
  assert.deepEqual(await f.store.list(), before);
});
