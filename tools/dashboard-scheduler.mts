import assert from 'node:assert/strict';
import {
  FileScheduleStore,
  assertScheduleId,
  assertScheduleRequestId,
  assertScheduleTarget,
  parseScheduleCadence,
  type ScheduleCadence,
  type ScheduleOccurrence,
  type ScheduleRecord,
  type ScheduleTarget,
  type UpdateScheduleRequest,
} from '../libs/runtime/src/lib/schedule-store.js';

export interface DashboardScheduleCreate {
  readonly requestId: string;
  readonly targetId: string;
  readonly cadence: ScheduleCadence;
}
export interface ScheduledTaskInspection {
  readonly taskId: string;
  readonly version: number;
  /** Execution-terminal does not imply review, acceptance or canonical DONE. */
  readonly state: 'prepared' | 'active' | 'terminal' | 'uncertain';
  readonly startAllowed: boolean;
  /** Canonical receipt of the exact start request, required during recovery. */
  readonly intent?: 'absent' | 'pending' | 'confirmed';
  readonly issue?: string | null;
}
export interface DashboardScheduleDispatcher {
  describeTargets(): Promise<readonly ScheduleTarget[]>;
  create(input: { readonly requestId: string; readonly recipeId: string }): Promise<{ readonly taskId: string; readonly version: number }>;
  inspect(taskId: string, startRequestId?: string): Promise<ScheduledTaskInspection>;
  start(taskId: string, input: { readonly requestId: string; readonly expectedVersion: number }): Promise<unknown>;
}
export interface DashboardSchedulerOptions {
  readonly store: FileScheduleStore;
  readonly dispatcher: DashboardScheduleDispatcher;
  readonly now?: () => Date;
}
export interface DashboardSchedulerTick {
  readonly busy: boolean;
  readonly at: string;
  readonly occurrences: readonly { readonly scheduleId: string; readonly occurrenceId: string; readonly state: string }[];
  readonly issues: readonly { readonly scheduleId: string; readonly message: string }[];
}
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected schedule request.');
  assert(Object.keys(value).every((key) => allowed.includes(key)), 'Unexpected schedule request field.');
}
export function parseDashboardScheduleCreate(value: unknown): DashboardScheduleCreate {
  fields(value, ['requestId', 'targetId', 'cadence']);
  assertScheduleRequestId(value.requestId);
  assertScheduleId(value.targetId);
  return { requestId: value.requestId, targetId: value.targetId, cadence: parseScheduleCadence(value.cadence) };
}
export function parseDashboardScheduleUpdate(value: unknown): UpdateScheduleRequest {
  fields(value, ['requestId', 'expectedVersion', 'action']);
  assertScheduleRequestId(value.requestId);
  assert(Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 1, 'Expected schedule version is required.');
  assert(['pause', 'resume', 'cancel'].includes(String(value.action)), 'Unknown schedule action.');
  return { requestId: value.requestId, expectedVersion: value.expectedVersion as number, action: value.action as UpdateScheduleRequest['action'] };
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 4096) || 'Unknown scheduling failure.';
const terminalStates = new Set(['TERMINAL', 'SKIPPED_OVERLAP', 'CANCELLED']);

/** Compute only the latest unclaimed due time. Clock rollback never rewinds
 * the durable cursor; paused time is coalesced under the same explicit policy. */
export function latestScheduleDue(record: ScheduleRecord, now: Date): { dueAt: string; coalescedCount: number } | null {
  const clock = now.getTime();
  assert(Number.isFinite(clock), 'Invalid scheduler clock.');
  if (record.cadence.kind === 'once') {
    if (record.lastDueAt || Date.parse(record.cadence.at) > clock) return null;
    return { dueAt: record.cadence.at, coalescedCount: 0 };
  }
  const { everyMs, anchor } = record.cadence;
  const anchorTime = Date.parse(anchor);
  if (clock < anchorTime) return null;
  const slot = Math.floor((clock - anchorTime) / everyMs);
  const dueTime = anchorTime + slot * everyMs;
  const priorSlot = record.lastDueAt === null ? -1 : Math.floor((Date.parse(record.lastDueAt) - anchorTime) / everyMs);
  if (slot <= priorSlot) return null;
  return { dueAt: new Date(dueTime).toISOString(), coalescedCount: slot - priorSlot - 1 };
}

/** Read projection only. A past result is the latest occurrence due now under
 * coalescing; a future result is the next anchored slot. Paused/cancelled clocks
 * have no next automatic dispatch, and a retained once intent is not repeated. */
export function nextScheduleDue(record: ScheduleRecord, now: Date): string | null {
  if (record.status !== 'ACTIVE') return null;
  const due = latestScheduleDue(record, now);
  if (due) return due.dueAt;
  if (record.cadence.kind === 'once') return record.lastDueAt ? null : record.cadence.at;
  if (record.lastDueAt === null) return record.cadence.anchor;
  return new Date(Date.parse(record.lastDueAt) + record.cadence.everyMs).toISOString();
}

/** A runtime clock adapter over admitted fixed recipes. It never generates
 * commands, starts coding plans, changes host scopes or accepts task evidence. */
export class DashboardScheduler {
  private readonly now: () => Date;
  constructor(private readonly options: DashboardSchedulerOptions) { this.now = options.now ?? (() => new Date()); }
  async create(input: unknown): Promise<ScheduleRecord> {
    const request = parseDashboardScheduleCreate(input);
    const targets = await this.targets();
    const target = targets.find((item) => item.id === request.targetId);
    assert(target, 'Unknown scheduled verification recipe.');
    return this.options.store.createSchedule({ requestId: request.requestId, target, cadence: request.cadence }, this.now());
  }
  async list(): Promise<readonly ScheduleRecord[]> { return this.options.store.list(); }
  async get(id: string): Promise<ScheduleRecord | null> { return this.options.store.get(id); }
  async update(id: string, input: unknown): Promise<ScheduleRecord> { return this.options.store.update(id, parseDashboardScheduleUpdate(input), this.now()); }
  async describe(): Promise<unknown> {
    const now = this.now();
    const schedules = (await this.list()).map((record) => ({
      ...record,
      nextDueAt: nextScheduleDue(record, now),
      actions: record.status === 'CANCELLED' ? [] : record.status === 'ACTIVE' ? ['pause', 'cancel'] : ['resume', 'cancel'],
    }));
    return { available: true, targets: await this.targets(), missedPolicy: 'coalesce-latest', overlapPolicy: 'skip', minimumIntervalMs: 60_000, automationScope: 'fixed-verification-recipes', schedules };
  }
  async tick(now = this.now()): Promise<DashboardSchedulerTick> {
    const at = now.toISOString();
    const locked = await this.options.store.withTickLock(async () => {
      const occurrences: { scheduleId: string; occurrenceId: string; state: string }[] = [];
      const issues: { scheduleId: string; message: string }[] = [];
      const targets = await this.targets();
      for (const initial of await this.list()) {
        try {
          // Reconcile already retained ownership even if future runs are paused,
          // cancelled, or their recipe pin has been removed from configuration.
          for (const occurrence of initial.occurrences.filter((item) => !terminalStates.has(item.state))) {
            const current = await this.require(initial.id);
            const target = targets.find((item) => item.id === current.target.id);
            const admitted = target?.pin === current.target.pin;
            const observed = await this.reconcile(current, occurrence, now, admitted);
            occurrences.push({ scheduleId: current.id, occurrenceId: observed.id, state: observed.state });
          }
          const current = await this.require(initial.id);
          if (current.status !== 'ACTIVE') continue;
          const target = targets.find((item) => item.id === current.target.id);
          if (!target || target.pin !== current.target.pin) {
            issues.push({ scheduleId: current.id, message: 'The host recipe was removed or changed; this pinned schedule cannot dispatch. Create a new schedule for the reviewed recipe.' });
            continue;
          }
          const due = latestScheduleDue(current, now);
          if (!due) continue;
          const owner = current.occurrences.find((item) => !terminalStates.has(item.state));
          const occurrence = await this.options.store.claimOccurrence(current.id, due.dueAt, due.coalescedCount,
            owner ? 'SKIPPED_OVERLAP' : 'INTENT', owner ? `Prior occurrence ${owner.id} still owns an active, pending or uncertain execution.` : null, now);
          if (!occurrence) continue;
          const observed = owner ? occurrence : await this.reconcile(await this.require(current.id), occurrence, now, true);
          occurrences.push({ scheduleId: current.id, occurrenceId: observed.id, state: observed.state });
        } catch (error) { issues.push({ scheduleId: initial.id, message: message(error) }); }
      }
      return { busy: false, at, occurrences, issues };
    });
    return locked.busy ? { busy: true, at, occurrences: [], issues: [] } : locked.result;
  }
  private async targets(): Promise<readonly ScheduleTarget[]> {
    const targets = await this.options.dispatcher.describeTargets();
    assert(Array.isArray(targets) && targets.length <= 128, 'Invalid configured scheduling targets.');
    const ids = new Set<string>();
    for (const target of targets) { assertScheduleTarget(target); assert(!ids.has(target.id), 'Duplicate scheduling target.'); ids.add(target.id); }
    return targets;
  }
  private async require(id: string): Promise<ScheduleRecord> {
    const record = await this.options.store.get(id);
    assert(record, 'Schedule disappeared during dispatch.');
    return record;
  }
  private async inspect(occurrence: ScheduleOccurrence, exact = false): Promise<ScheduledTaskInspection> {
    const inspected = await this.options.dispatcher.inspect(occurrence.taskId, exact ? occurrence.startRequestId : undefined);
    assert.equal(inspected.taskId, occurrence.taskId, 'Dispatcher returned another scheduled task.');
    assert(Number.isSafeInteger(inspected.version) && inspected.version >= 1, 'Invalid scheduled task version.');
    assert(['prepared', 'active', 'terminal', 'uncertain'].includes(inspected.state), 'Invalid scheduled task state.');
    assert(typeof inspected.startAllowed === 'boolean');
    if (exact) assert(['absent', 'pending', 'confirmed'].includes(String(inspected.intent)), 'Exact scheduled start intent is unavailable; automatic retry is blocked.');
    return inspected;
  }
  private async reconcile(record: ScheduleRecord, initial: ScheduleOccurrence, now: Date, admitted: boolean): Promise<ScheduleOccurrence> {
    let occurrence = initial;
    const update = (patch: Parameters<FileScheduleStore['updateOccurrence']>[2]) => this.options.store.updateOccurrence(record.id, occurrence.id, patch, now);
    const canDispatch = async () => {
      const current = await this.require(record.id);
      return current.status === 'ACTIVE' && admitted;
    };
    // Cancellation stops future invocation but does not cancel an owned active
    // task. The latter remains an explicit task controller operation.
    if (['INTENT', 'PREPARED'].includes(occurrence.state)) {
      if (record.status === 'CANCELLED') return update({ state: 'CANCELLED', issue: 'Future schedule dispatch was cancelled; no task cancellation is implied.' });
      if (!await canDispatch()) return occurrence;
    }
    if (occurrence.state === 'INTENT') {
      try {
        const task = await this.options.dispatcher.create({ requestId: occurrence.requestId, recipeId: record.target.id });
        assert.equal(task.taskId, occurrence.taskId, 'Prepared scheduled task identity differs from durable intent.');
        assert(Number.isSafeInteger(task.version) && task.version >= 1);
        occurrence = await update({ state: 'PREPARED', issue: null });
      } catch (error) {
        // Creation is idempotent at the task controller. Keep the exact intent
        // rather than allocate another task after preparation failure/crash.
        return update({ state: 'INTENT', issue: message(error) });
      }
    }
    if (occurrence.state === 'PREPARED') {
      if (!await canDispatch()) return occurrence;
      let task: ScheduledTaskInspection;
      try { task = await this.inspect(occurrence); }
      catch (error) { return update({ state: 'UNCERTAIN', issue: message(error) }); }
      if (task.state !== 'prepared' || !task.startAllowed)
        return update({ state: 'UNCERTAIN', issue: task.issue ? message(task.issue) : 'Prepared task changed or its start is unavailable; reconcile the exact task before another occurrence.' });
      // This is fsynced before calling an executor. The original optimistic
      // version and command ID are immutable across process restarts.
      occurrence = await update({ state: 'STARTING', expectedVersion: task.version, issue: null });
    }
    if (occurrence.state === 'STARTING') {
      try {
        const before = await this.inspect(occurrence, true);
        if (before.intent === 'absent') {
          if (!await canDispatch()) {
            const latest = await this.require(record.id);
            if (latest.status === 'CANCELLED') return update({ state: 'CANCELLED', issue: 'Future schedule dispatch was cancelled before the exact start intent existed.' });
            return occurrence;
          }
          if (before.state !== 'prepared' || !before.startAllowed || before.version !== occurrence.expectedVersion)
            return update({ state: 'UNCERTAIN', issue: 'The prepared task version changed before its retained start; refresh and reconcile this task.' });
          await this.options.dispatcher.start(occurrence.taskId, { requestId: occurrence.startRequestId, expectedVersion: occurrence.expectedVersion! });
        }
        const after = await this.inspect(occurrence, true);
        if (after.state === 'terminal' && after.intent === 'confirmed') return update({ state: 'TERMINAL', issue: after.issue ? message(after.issue) : null });
        if (after.state === 'active' && after.intent === 'confirmed') return update({ state: 'ACTIVE', issue: after.issue ? message(after.issue) : null });
        return update({ state: 'UNCERTAIN', issue: after.issue ? message(after.issue) : 'The executor has not confirmed the retained start intent; reconcile the exact task. Another occurrence is blocked.' });
      } catch (error) { return update({ state: 'UNCERTAIN', issue: message(error) }); }
    }
    if (occurrence.state === 'ACTIVE' || occurrence.state === 'UNCERTAIN') {
      try {
        const task = await this.inspect(occurrence, true);
        if (task.state === 'terminal' && task.intent === 'confirmed') return update({ state: 'TERMINAL', issue: task.issue ? message(task.issue) : null });
        if (task.state === 'active' && task.intent === 'confirmed' && occurrence.expectedVersion !== null) return update({ state: 'ACTIVE', issue: task.issue ? message(task.issue) : null });
        return update({ state: 'UNCERTAIN', issue: task.issue ? message(task.issue) : 'Scheduled execution ownership is uncertain; reconcile the exact task before another occurrence.' });
      } catch (error) { return update({ state: 'UNCERTAIN', issue: message(error) }); }
    }
    return occurrence;
  }
}
export function createDashboardScheduler(options: DashboardSchedulerOptions): DashboardScheduler { return new DashboardScheduler(options); }
