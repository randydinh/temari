import { FileChildTaskStore } from './child-task-store.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hostname } from 'node:os';
import {
  assertRepairRecord,
  assertRepairReference,
  assertRepairSelection,
  type TaskRepair,
  type TaskRepairResolution,
  type RepairSupervisorRef,
  type TaskRepairAdmission,
  type TaskRepairLaunch,
} from './task-repair.js';
import {
  DEFAULT_STAGES,
  HOST_CAPABILITIES,
  type ExecutionPlan,
  type HarnessRunRef,
  type HarnessRunSnapshot,
} from '@temari/contracts';

export interface TaskCommand {
  readonly taskId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}

/** Opaque host/session identity; a session may be linked to many goals. */
export interface TaskSessionIdentity {
  readonly host: string;
  readonly sessionId: string;
}
export interface TaskSessionRef extends TaskSessionIdentity {
  readonly enteredAt: string;
  readonly lastEnteredAt: string;
}
export interface TaskContextRef {
  readonly kind: string;
  readonly location: string;
  readonly sha256?: string;
}
export interface TaskHandoffInput {
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly nextAction: string;
  readonly blocker: string | null;
  readonly contextRefs: readonly TaskContextRef[];
}
/** Context for a later session. This never establishes execution completion. */
export interface TaskHandoff extends TaskHandoffInput {
  readonly actor: string;
  readonly at: string;
  readonly taskVersion: number;
  readonly runId: string | null;
}
export interface TaskCreationInput {
  readonly title: string;
  readonly goal: string;
  readonly workspaceRoot: string;
}
export type EnterTaskRequest = TaskCommand & {
  readonly session: TaskSessionIdentity;
  readonly create?: TaskCreationInput;
};

/** A link to source authority, never a copied assertion of source validity. */
export interface TaskSourceRef {
  readonly sourceId: string;
  readonly publicationId: string;
  readonly location: string;
}
export interface TaskChildRef {
  readonly storeRoot: string;
  readonly groupId: string;
}
export interface TaskRunBinding {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  /** May be attached once the native executor publishes its output location. */
  readonly receiptRoot?: string;
  readonly evidenceRoot?: string;
  readonly sourceRefs?: readonly TaskSourceRef[];
  readonly childRefs?: readonly TaskChildRef[];
  /** Source-managed route ownership; retains cleanup barriers across new run bindings. */
  readonly executionStoreRoot?: string;
}
export interface TaskOperation {
  readonly commandId: string;
  readonly kind: 'dispatch' | 'resume' | 'cancel';
  readonly state: 'PENDING' | 'UNCERTAIN' | 'CONFIRMED';
  /** CONFIRMED records a resolved intent; only cancelled confirms its effect. */
  readonly outcome?: 'cancelled' | 'finished-before-cancel';
  readonly reason: string | null;
  readonly entrypoint?: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly harnessId?: string;
  readonly harnessVersion?: string;
}
export interface TaskRun extends TaskRunBinding {
  readonly planSha256: string;
  readonly boundAt: string;
  readonly nativeRef: HarnessRunRef | null;
  readonly nativeSnapshot: HarnessRunSnapshot | null;
  readonly operations: readonly TaskOperation[];
}
export interface TaskAcceptance {
  readonly runId: string;
  readonly receiptSha256: string;
  readonly scope: 'local-stage-evidence-and-coordinator-acceptance';
  readonly reason: string;
  readonly actor: string;
  readonly at: string;
}
export interface TaskRecord {
  readonly schema: 1;
  readonly taskId: string;
  readonly version: number;
  readonly title: string;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly nextAction: string | null;
  readonly blocker: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentRunId: string | null;
  readonly runs: readonly TaskRun[];
  readonly acceptance: TaskAcceptance | null;
  readonly sessions: readonly TaskSessionRef[];
  readonly handoff: TaskHandoff | null;
  readonly repairs: readonly TaskRepair[];
  readonly events: readonly TaskEvent[];
}
export type TaskChange =
  | { readonly type: 'repair-bound'; readonly repair: TaskRepair }
  | {
      readonly type: 'repair-admitted';
      readonly repairId: string;
      readonly admission: TaskRepairAdmission;
      readonly launch: TaskRepairLaunch;
    }
  | {
      readonly type: 'repair-launch-observed';
      readonly repairId: string;
      readonly launchId: string;
      readonly reference: RepairSupervisorRef;
    }
  | {
      readonly type: 'repair-launch-uncertain';
      readonly repairId: string;
      readonly launchId: string;
      readonly reason: string;
      readonly diagnosticRef?: TaskContextRef;
    }
  | {
      readonly type: 'repair-resolved';
      readonly repairId: string;
      readonly resolution: TaskRepairResolution;
    }
  | {
      readonly type: 'task-entered';
      readonly session: TaskSessionIdentity;
      readonly create?: TaskCreationInput;
    }
  | { readonly type: 'handoff-recorded'; readonly handoff: TaskHandoffInput }
  | {
      readonly type: 'task-created';
      readonly title: string;
      readonly goal: string;
      readonly workspaceRoot: string;
    }
  | {
      readonly type: 'metadata-updated';
      readonly title?: string;
      readonly nextAction?: string | null;
      readonly blocker?: string | null;
    }
  | { readonly type: 'run-bound'; readonly run: TaskRunBinding }
  | {
      readonly type: 'evidence-roots-attached';
      readonly runId: string;
      readonly receiptRoot: string;
      readonly evidenceRoot: string;
    }
  | {
      readonly type: 'dispatch-requested';
      readonly runId: string;
      readonly entrypoint: string;
      readonly inputs: Readonly<Record<string, string>>;
      readonly harnessId: string;
      readonly harnessVersion: string;
    }
  | {
      readonly type: 'control-requested';
      readonly runId: string;
      readonly kind: 'resume' | 'cancel';
    }
  | {
      readonly type: 'native-bound';
      readonly runId: string;
      readonly reference: HarnessRunRef;
      readonly operationId: string;
    }
  | {
      readonly type: 'native-observed';
      readonly runId: string;
      readonly snapshot: HarnessRunSnapshot;
      readonly operationId?: string;
    }
  | {
      readonly type: 'operation-uncertain';
      readonly runId: string;
      readonly operationId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'evidence-verified';
      readonly runId: string;
      readonly receiptSha256: string;
    }
  | {
      readonly type: 'task-accepted';
      readonly runId: string;
      readonly receiptSha256: string;
      readonly reason: string;
    };
export interface TaskEvent {
  readonly schema: 1;
  readonly sequence: number;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly at: string;
  readonly change: TaskChange;
}
export interface TaskMutation {
  readonly task: TaskRecord;
  /** False means the same command is already durable; do not repeat effects. */
  readonly applied: boolean;
}

export function taskDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object')
      return `{${Object.entries(item)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(',')}}`;
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function assertTaskId(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    'Task/run ID must be a safe filename component.',
  );
}
function text(
  value: unknown,
  label: string,
  max = 512,
): asserts value is string {
  assert(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= max &&
      !value.includes('\0'),
    `Invalid ${label}.`,
  );
}
function path(value: unknown): asserts value is string {
  text(value, 'absolute path', 4096);
  assert(isAbsolute(value), 'Path must be absolute.');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected object.',
  );
}
function keys(value: unknown, allowed: string[]): void {
  object(value);
  assert(
    Object.keys(value).every((k) => allowed.includes(k)),
    'Unexpected task record field.',
  );
}
function digest(value: unknown): void {
  assert(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'Invalid task digest.',
  );
}
function date(value: unknown): void {
  assert(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'Invalid task timestamp.',
  );
}
export function assertTaskSessionIdentity(value: TaskSessionIdentity): void {
  keys(value, ['host', 'sessionId']);
  text(value.host, 'session host', 128);
  text(value.sessionId, 'session ID');
  assert(
    !/[\u0000-\u001f\u007f]/.test(value.host + value.sessionId),
    'Session identity must not contain control characters.',
  );
}
function handoffInput(value: TaskHandoffInput): void {
  keys(value, ['summary', 'decisions', 'nextAction', 'blocker', 'contextRefs']);
  text(value.summary, 'handoff summary', 4096);
  text(value.nextAction, 'handoff next action', 4096);
  if (value.blocker !== null) text(value.blocker, 'handoff blocker', 4096);
  assert(
    Array.isArray(value.decisions) && value.decisions.length <= 16,
    'Handoff decisions exceed the 16-item limit.',
  );
  for (const decision of value.decisions)
    text(decision, 'handoff decision', 1024);
  assert(
    Array.isArray(value.contextRefs) && value.contextRefs.length <= 16,
    'Handoff context references exceed the 16-item limit.',
  );
  for (const ref of value.contextRefs) {
    keys(ref, ['kind', 'location', 'sha256']);
    text(ref.kind, 'context reference kind', 64);
    text(ref.location, 'context reference location', 4096);
    if (ref.sha256 !== undefined) digest(ref.sha256);
  }
}
function plan(value: ExecutionPlan): void {
  keys(value, [
    'version',
    'workType',
    'stages',
    'delegation',
    'review',
    'evidence',
    'delivery',
    'requiredCapabilities',
    'parallelism',
  ]);
  assert.equal(value.version, 1);
  assert(
    ['investigation', 'design', 'bug', 'feature', 'qa', 'migration'].includes(
      value.workType,
    ),
  );
  assert.deepEqual(
    value.stages,
    DEFAULT_STAGES,
    'Task plan stages must be canonical.',
  );
  assert(['none', 'optional', 'required'].includes(value.delegation));
  assert(['self', 'coordinator', 'independent'].includes(value.review));
  assert(['minimal', 'standard', 'revision-bound'].includes(value.evidence));
  assert(['local', 'commit', 'pull-request'].includes(value.delivery));
  assert(
    Array.isArray(value.requiredCapabilities) &&
      value.requiredCapabilities.length <= HOST_CAPABILITIES.length,
  );
  assert(
    value.requiredCapabilities.every((c) => HOST_CAPABILITIES.includes(c)),
  );
  if (value.parallelism !== undefined) {
    keys(value.parallelism, ['maxConcurrency']);
    assert(
      Number.isSafeInteger(value.parallelism.maxConcurrency) &&
        value.parallelism.maxConcurrency > 0 &&
        value.parallelism.maxConcurrency <= 1024,
    );
  }
}
function binding(value: TaskRunBinding): void {
  keys(value, [
    'runId',
    'revision',
    'plan',
    'receiptRoot',
    'evidenceRoot',
    'sourceRefs',
    'childRefs',
    'executionStoreRoot',
  ]);
  assertTaskId(value.runId);
  if (value.executionStoreRoot !== undefined) path(value.executionStoreRoot);
  text(value.revision, 'revision');
  plan(value.plan);
  assert.equal(
    value.receiptRoot === undefined,
    value.evidenceRoot === undefined,
    'Receipt and evidence roots must be attached together.',
  );
  if (value.receiptRoot !== undefined) {
    path(value.receiptRoot);
    path(value.evidenceRoot);
  }
  assert(
    value.sourceRefs === undefined ||
      (Array.isArray(value.sourceRefs) && value.sourceRefs.length <= 256),
  );
  for (const ref of value.sourceRefs ?? []) {
    keys(ref, ['sourceId', 'publicationId', 'location']);
    text(ref.sourceId, 'source ID');
    text(ref.publicationId, 'publication ID');
    text(ref.location, 'source location', 4096);
  }
  assert(
    value.childRefs === undefined ||
      (Array.isArray(value.childRefs) && value.childRefs.length <= 64),
  );
  for (const ref of value.childRefs ?? []) {
    keys(ref, ['storeRoot', 'groupId']);
    path(ref.storeRoot);
    assertTaskId(ref.groupId);
  }
}
export function assertTaskNativeRef(
  ref: HarnessRunRef,
  task: TaskRecord,
  run: TaskRun,
): void {
  keys(ref, [
    'schema',
    'harnessId',
    'harnessVersion',
    'runId',
    'revision',
    'planSha256',
    'externalRunId',
    'workspaceRoot',
    'entrypoint',
    'startedAt',
  ]);
  assert.equal(ref.schema, 1);
  text(ref.harnessId, 'harness ID');
  text(ref.harnessVersion, 'harness version');
  text(ref.externalRunId, 'native run ID', 128);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref.externalRunId) &&
      !ref.externalRunId.includes('..'),
    'Invalid native run ID.',
  );
  assert.equal(ref.runId, run.runId, 'Native run binding mismatch.');
  assert.equal(ref.revision, run.revision, 'Native revision mismatch.');
  assert.equal(ref.planSha256, run.planSha256, 'Native plan mismatch.');
  assert.equal(
    ref.workspaceRoot,
    task.workspaceRoot,
    'Native workspace mismatch.',
  );
  text(ref.entrypoint, 'entrypoint', 4096);
  date(ref.startedAt);
  const dispatch = run.operations.find((op) => op.kind === 'dispatch');
  assert(dispatch, 'Native binding requires retained dispatch intent.');
  assert.equal(
    ref.entrypoint,
    dispatch.entrypoint,
    'Native entrypoint mismatch.',
  );
  assert.equal(ref.harnessId, dispatch.harnessId, 'Native harness mismatch.');
  assert.equal(
    ref.harnessVersion,
    dispatch.harnessVersion,
    'Native harness version mismatch.',
  );
}
function snapshot(value: HarnessRunSnapshot): void {
  keys(value, [
    'status',
    'observedAt',
    'summary',
    'rawLogPath',
    'nativeProjectId',
  ]);
  if (value.nativeProjectId !== undefined) assertTaskId(value.nativeProjectId);
  assert(
    [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
      'UNKNOWN',
    ].includes(value.status),
  );
  date(value.observedAt);
  assert(typeof value.summary === 'string' && value.summary.length <= 16384);
  assert(
    value.rawLogPath === null ||
      (typeof value.rawLogPath === 'string' && value.rawLogPath.length <= 4096),
  );
}
function runFor(task: TaskRecord, runId: string): TaskRun {
  assertTaskId(runId);
  const run = task.runs.find((item) => item.runId === runId);
  assert(run, 'Run is not bound to this task.');
  return run;
}
function amendRun(task: TaskRecord, run: TaskRun): TaskRecord {
  return {
    ...task,
    runs: task.runs.map((item) => (item.runId === run.runId ? run : item)),
  };
}
function createdTask(event: TaskEvent, input: TaskCreationInput): TaskRecord {
  keys(input, ['title', 'goal', 'workspaceRoot']);
  text(input.title, 'title', 256);
  text(input.goal, 'goal', 16384);
  path(input.workspaceRoot);
  return {
    schema: 1,
    taskId: event.taskId,
    version: 1,
    ...input,
    nextAction: null,
    blocker: null,
    createdAt: event.at,
    updatedAt: event.at,
    currentRunId: null,
    runs: [],
    acceptance: null,
    sessions: [],
    handoff: null,
    repairs: [],
    events: [event],
  };
}

/** Replay is the sole projection; there is no mutable status alongside the log. */
function apply(task: TaskRecord | undefined, event: TaskEvent): TaskRecord {
  const change = event.change;
  object(change);
  if (change.type === 'task-created') {
    assert(!task, 'Task already exists.');
    keys(change, ['type', 'title', 'goal', 'workspaceRoot']);
    return createdTask(event, {
      title: change.title,
      goal: change.goal,
      workspaceRoot: change.workspaceRoot,
    });
  }
  if (change.type === 'task-entered') {
    keys(change, ['type', 'session', 'create']);
    assertTaskSessionIdentity(change.session);
    if (task)
      assert(
        change.create === undefined,
        'Existing task entry cannot create or replace task metadata.',
      );
    else assert(change.create, 'New task entry requires creation metadata.');
    const current = task
      ? {
          ...task,
          version: event.taskVersion,
          updatedAt: event.at,
          events: [...task.events, event],
        }
      : createdTask(event, change.create!);
    const existing = current.sessions.find(
      (session) =>
        session.host === change.session.host &&
        session.sessionId === change.session.sessionId,
    );
    assert(
      existing || current.sessions.length < 256,
      'Task session reference limit exceeded.',
    );
    return {
      ...current,
      sessions: existing
        ? current.sessions.map((session) =>
            session === existing
              ? { ...session, lastEnteredAt: event.at }
              : session,
          )
        : [
            ...current.sessions,
            { ...change.session, enteredAt: event.at, lastEnteredAt: event.at },
          ],
    };
  }
  assert(task, 'Task does not exist.');
  const next = {
    ...task,
    version: event.taskVersion,
    updatedAt: event.at,
    events: [...task.events, event],
  };
  if (change.type === 'repair-bound') {
    keys(change, ['type', 'repair']);
    assertRepairRecord(change.repair);
    assert(task.repairs.length < 64, 'Task repair limit exceeded.');
    assert(
      !task.repairs.some(
        (repair) => repair.report.repairId === change.repair.report.repairId,
      ),
      'Repair binding is immutable.',
    );
    return { ...next, repairs: [...task.repairs, change.repair] };
  }
  if (change.type === 'repair-admitted') {
    keys(change, ['type', 'repairId', 'admission', 'launch']);
    const old = task.repairs.find(
      (item) => item.report.repairId === change.repairId,
    );
    assert(
      old &&
        old.admission.status === 'BLOCKED' &&
        !old.launch &&
        !old.resolution,
      'Only a never-launched BLOCKED repair may be admitted.',
    );
    assert.equal(change.admission.status, 'ADMITTED');
    const amended = {
      ...old,
      admission: change.admission,
      launch: change.launch,
    };
    assertRepairRecord(amended);
    return {
      ...next,
      repairs: task.repairs.map((item) => (item === old ? amended : item)),
    };
  }
  if (
    change.type === 'repair-launch-observed' ||
    change.type === 'repair-launch-uncertain' ||
    change.type === 'repair-resolved'
  ) {
    const repair = task.repairs.find(
      (item) => item.report.repairId === change.repairId,
    );
    assert(
      repair && repair.admission.status === 'ADMITTED' && repair.launch,
      'Admitted repair reservation is missing.',
    );
    let amended: TaskRepair;
    if (change.type === 'repair-resolved') {
      keys(change, ['type', 'repairId', 'resolution']);
      keys(change.resolution, ['selection', 'reason', 'actor', 'at']);
      assertRepairSelection(change.resolution.selection);
      text(change.resolution.reason, 'repair resolution', 4096);
      assert.equal(change.resolution.actor, event.actor);
      assert(Number.isFinite(Date.parse(change.resolution.at)));
      assert(!repair.resolution, 'Repair resolution is immutable.');
      amended = { ...repair, resolution: change.resolution };
    } else {
      assert.equal(
        change.launchId,
        repair.launch.launchId,
        'Repair launch binding changed.',
      );
      if (change.type === 'repair-launch-observed') {
        keys(change, ['type', 'repairId', 'launchId', 'reference']);
        assertRepairReference(change.reference);
        assert.equal(change.reference.launchId, repair.launch.launchId);
        assert.equal(
          change.reference.executionId,
          repair.admission.executionId,
        );
        assert.equal(
          change.reference.manifestSha256,
          repair.admission.manifestSha256,
        );
        if (repair.launch.reference)
          assert.deepEqual(
            repair.launch.reference,
            change.reference,
            'Repair observation is immutable.',
          );
        amended = {
          ...repair,
          launch: {
            ...repair.launch,
            state: 'CONFIRMED',
            reference: change.reference,
            reason: null,
          },
        };
      } else {
        keys(change, [
          'type',
          'repairId',
          'launchId',
          'reason',
          'diagnosticRef',
        ]);
        text(change.reason, 'repair launch uncertainty', 4096);
        if (change.diagnosticRef) {
          keys(change.diagnosticRef, ['kind', 'location', 'sha256']);
          assert.equal(change.diagnosticRef.kind, 'repair-controller-failure');
          assert(isAbsolute(change.diagnosticRef.location));
          digest(change.diagnosticRef.sha256!);
        }
        assert(
          !repair.launch.reference,
          'Observed repair launch cannot become unobserved.',
        );
        amended = {
          ...repair,
          launch: {
            ...repair.launch,
            state: 'UNCERTAIN',
            reason: change.reason,
            ...(change.diagnosticRef
              ? { diagnosticRef: change.diagnosticRef }
              : {}),
          },
        };
      }
    }
    return {
      ...next,
      repairs: task.repairs.map((item) => (item === repair ? amended : item)),
    };
  }
  if (change.type === 'handoff-recorded') {
    keys(change, ['type', 'handoff']);
    handoffInput(change.handoff);
    return {
      ...next,
      nextAction: change.handoff.nextAction,
      blocker: change.handoff.blocker,
      handoff: {
        ...change.handoff,
        actor: event.actor,
        at: event.at,
        taskVersion: event.taskVersion,
        runId: task.currentRunId,
      },
    };
  }
  if (change.type === 'metadata-updated') {
    keys(change, ['type', 'title', 'nextAction', 'blocker']);
    if (change.title !== undefined) text(change.title, 'title', 256);
    for (const value of [change.nextAction, change.blocker])
      if (value !== undefined && value !== null)
        text(value, 'task metadata', 4096);
    const { type: _type, ...patch } = change;
    return { ...next, ...patch };
  }
  if (change.type === 'run-bound') {
    keys(change, ['type', 'run']);
    binding(change.run);
    assert(
      !task.runs.some((r) => r.runId === change.run.runId),
      'Run binding is immutable.',
    );
    assert(task.runs.length < 1024, 'Task run limit exceeded.');
    const current = task.runs.find((r) => r.runId === task.currentRunId);
    if (current)
      assert(
        !current.operations.some((o) => o.state !== 'CONFIRMED') &&
          (!current.nativeRef ||
            ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
              current.nativeSnapshot?.status ?? 'UNKNOWN',
            )),
        'Resolve or stop the current execution before binding another run.',
      );
    return {
      ...next,
      currentRunId: change.run.runId,
      acceptance: null,
      blocker: null,
      runs: [
        ...task.runs,
        {
          ...change.run,
          planSha256: taskDigest(change.run.plan),
          boundAt: event.at,
          nativeRef: null,
          nativeSnapshot: null,
          operations: [],
        },
      ],
    };
  }
  const run = runFor(task, change.runId);
  if (change.type === 'evidence-roots-attached') {
    keys(change, ['type', 'runId', 'receiptRoot', 'evidenceRoot']);
    path(change.receiptRoot);
    path(change.evidenceRoot);
    if (run.receiptRoot !== undefined) {
      assert.equal(
        run.receiptRoot,
        change.receiptRoot,
        'Receipt root binding is immutable.',
      );
      assert.equal(
        run.evidenceRoot,
        change.evidenceRoot,
        'Evidence root binding is immutable.',
      );
    }
    return amendRun(next, {
      ...run,
      receiptRoot: change.receiptRoot,
      evidenceRoot: change.evidenceRoot,
    });
  }
  if (change.type === 'dispatch-requested') {
    keys(change, [
      'type',
      'runId',
      'entrypoint',
      'inputs',
      'harnessId',
      'harnessVersion',
    ]);
    text(change.entrypoint, 'entrypoint', 4096);
    text(change.harnessId, 'harness ID');
    text(change.harnessVersion, 'harness version');
    object(change.inputs);
    assert(Object.keys(change.inputs).length <= 64);
    for (const [k, v] of Object.entries(change.inputs)) {
      text(k, 'input key', 128);
      assert(typeof v === 'string' && v.length <= 16384);
    }
    assert.equal(
      task.currentRunId,
      run.runId,
      'Only current run may dispatch.',
    );
    assert(
      !run.nativeRef && run.operations.length === 0,
      'Dispatch already requested; reconcile the exact native run.',
    );
    return amendRun(next, {
      ...run,
      operations: [
        {
          commandId: event.idempotencyKey,
          kind: 'dispatch',
          state: 'PENDING',
          reason: null,
          entrypoint: change.entrypoint,
          inputs: change.inputs,
          harnessId: change.harnessId,
          harnessVersion: change.harnessVersion,
        },
      ],
    });
  }
  if (change.type === 'control-requested') {
    keys(change, ['type', 'runId', 'kind']);
    assert(['resume', 'cancel'].includes(change.kind));
    assert.equal(
      task.currentRunId,
      run.runId,
      'Only current run may be controlled.',
    );
    assert(run.nativeRef, 'Control requires exact native binding.');
    assert(!task.acceptance, 'Accepted task cannot be controlled.');
    assert(
      !run.operations.some((o) => o.state !== 'CONFIRMED'),
      'Reconcile pending control before another operation.',
    );
    return amendRun(next, {
      ...run,
      operations: [
        ...run.operations,
        {
          commandId: event.idempotencyKey,
          kind: change.kind,
          state: 'PENDING',
          reason: null,
        },
      ],
    });
  }
  if (change.type === 'native-bound') {
    keys(change, ['type', 'runId', 'reference', 'operationId']);
    assertTaskNativeRef(change.reference, task, run);
    if (run.nativeRef)
      assert.deepEqual(
        run.nativeRef,
        change.reference,
        'Native identity is immutable.',
      );
    const op = run.operations.find((o) => o.commandId === change.operationId);
    assert(op?.kind === 'dispatch', 'Dispatch intent missing.');
    return amendRun(next, {
      ...run,
      nativeRef: change.reference,
      operations: run.operations.map((o) =>
        o === op ? { ...o, state: 'CONFIRMED', reason: null } : o,
      ),
    });
  }
  if (change.type === 'native-observed') {
    keys(change, ['type', 'runId', 'snapshot', 'operationId']);
    assert(run.nativeRef, 'Native observation requires exact binding.');
    snapshot(change.snapshot);
    let operations = run.operations;
    if (change.operationId !== undefined) {
      text(change.operationId, 'operation ID');
      const op = operations.find((o) => o.commandId === change.operationId);
      assert(op, 'Control intent missing.');
      const cancelled =
        op.kind === 'cancel' && change.snapshot.status === 'CANCELLED';
      const finishedBeforeCancel =
        op.kind === 'cancel' &&
        ['SUCCEEDED', 'FAILED'].includes(change.snapshot.status);
      const confirmed =
        op.kind === 'cancel'
          ? cancelled || finishedBeforeCancel
          : change.snapshot.status !== 'UNKNOWN';
      operations = operations.map((o) =>
        o === op
          ? {
              ...o,
              state: confirmed ? 'CONFIRMED' : 'UNCERTAIN',
              ...(cancelled
                ? { outcome: 'cancelled' as const }
                : finishedBeforeCancel
                  ? { outcome: 'finished-before-cancel' as const }
                  : {}),
              reason: finishedBeforeCancel
                ? `Executor finished ${change.snapshot.status} before cancellation was confirmed.`
                : confirmed
                  ? null
                  : 'Executor has not confirmed the requested action.',
            }
          : o,
      );
    }
    return amendRun(next, {
      ...run,
      nativeSnapshot: change.snapshot,
      operations,
    });
  }
  if (change.type === 'operation-uncertain') {
    keys(change, ['type', 'runId', 'operationId', 'reason']);
    text(change.reason, 'uncertainty reason', 4096);
    assert(
      run.operations.some(
        (o) => o.commandId === change.operationId && o.state !== 'CONFIRMED',
      ),
      'Uncertain operation intent missing.',
    );
    return amendRun(next, {
      ...run,
      operations: run.operations.map((o) =>
        o.commandId === change.operationId
          ? { ...o, state: 'UNCERTAIN', reason: change.reason }
          : o,
      ),
    });
  }
  if (change.type === 'evidence-verified') {
    keys(change, ['type', 'runId', 'receiptSha256']);
    digest(change.receiptSha256);
    return next;
  }
  assert.equal(change.type, 'task-accepted', 'Unsupported task event.');
  keys(change, ['type', 'runId', 'receiptSha256', 'reason']);
  digest(change.receiptSha256);
  text(change.reason, 'acceptance reason', 4096);
  assert.equal(
    task.currentRunId,
    run.runId,
    'Acceptance requires current run.',
  );
  assert(
    !run.operations.some((o) => o.state !== 'CONFIRMED'),
    'Pending execution control prevents acceptance.',
  );
  return {
    ...next,
    blocker: null,
    nextAction: null,
    acceptance: {
      runId: run.runId,
      receiptSha256: change.receiptSha256,
      scope: 'local-stage-evidence-and-coordinator-acceptance',
      reason: change.reason,
      actor: event.actor,
      at: event.at,
    },
  };
}

function replay(events: readonly TaskEvent[]): Map<string, TaskRecord> {
  const tasks = new Map<string, TaskRecord>();
  const commands = new Set<string>();
  const runOwners = new Set<string>();
  const nativeOwners = new Map<string, string>();
  assert(
    Array.isArray(events) && events.length <= 50000,
    'Invalid or oversized task ledger.',
  );
  for (let i = 0; i < events.length; i++) {
    const event: TaskEvent = events[i]!;
    keys(event, [
      'schema',
      'sequence',
      'taskId',
      'taskVersion',
      'actor',
      'idempotencyKey',
      'at',
      'change',
    ]);
    assert.equal(event.schema, 1);
    assert.equal(event.sequence, i + 1, 'Task ledger sequence is corrupt.');
    assertTaskId(event.taskId);
    text(event.actor, 'actor');
    text(event.idempotencyKey, 'idempotency key');
    date(event.at);
    const task = tasks.get(event.taskId);
    assert.equal(
      event.taskVersion,
      (task?.version ?? 0) + 1,
      'Task version is corrupt.',
    );
    const command = `${event.taskId}\0${event.idempotencyKey}`;
    assert(!commands.has(command), 'Duplicate task command.');
    commands.add(command);
    if (event.change.type === 'run-bound') {
      assert(
        !runOwners.has(event.change.run.runId),
        'Run ID already belongs to a task.',
      );
      runOwners.add(event.change.run.runId);
    }
    if (event.change.type === 'native-bound') {
      const reference = event.change.reference;
      const identity = taskDigest([
        reference.harnessId,
        reference.externalRunId,
      ]);
      const owner = nativeOwners.get(identity);
      assert(
        owner === undefined || owner === event.change.runId,
        'Native run ID is already bound to another Temari run.',
      );
      nativeOwners.set(identity, event.change.runId);
    }
    tasks.set(event.taskId, apply(task, event));
  }
  return tasks;
}

/** One small local event ledger provides atomic task + run ownership changes.
 * A leftover lock fails visibly; never steal a lock and risk concurrent writers.
 * External actions happen after this lock is released and intent is fsynced.
 */
export class FileTaskStore {
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<FileTaskStore> {
    path(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    assert(
      (await lstat(root)).isDirectory(),
      'Task store root must be a directory.',
    );
    const store = new FileTaskStore(await realpath(root));
    await store.withLock(async () => {
      const marked = await store.hasInitializationMarker();
      if (marked) {
        await store.read();
        return;
      }
      let ledgerExists = false;
      try {
        await lstat(join(store.root, 'tasks.json'));
        ledgerExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (ledgerExists) await store.read();
      else
        assert(
          (await readdir(store.root)).every((entry) => entry === '.tasks.lock'),
          'Refusing to initialize a nonempty directory without a task ledger.',
        );
      // The independent marker prevents a later missing ledger from looking
      // like a new store. An interrupted initialization fails visibly.
      const marker = await open(
        join(store.root, '.task-store.json'),
        'wx',
        0o600,
      );
      try {
        await marker.writeFile(
          JSON.stringify({ schema: 1, kind: 'temari-task-store' }),
        );
        await marker.sync();
      } finally {
        await marker.close();
      }
      if (!ledgerExists) await store.publish([]);
      else await store.syncDirectory();
    });
    return store;
  }
  static async openExisting(root: string): Promise<FileTaskStore> {
    path(root);
    assert(
      (await lstat(root)).isDirectory(),
      'Task store root must be a directory.',
    );
    const store = new FileTaskStore(await realpath(root));
    await store.read();
    return store;
  }
  async createTask(
    request: Omit<TaskCommand, 'expectedVersion'> & {
      readonly title: string;
      readonly goal: string;
      readonly workspaceRoot: string;
    },
  ): Promise<TaskRecord> {
    return (
      await this.append(
        { ...request, expectedVersion: 0 },
        {
          type: 'task-created',
          title: request.title,
          goal: request.goal,
          workspaceRoot: request.workspaceRoot,
        },
      )
    ).task;
  }
  async enterTask(request: EnterTaskRequest): Promise<TaskRecord> {
    return (
      await this.append(request, {
        type: 'task-entered',
        session: request.session,
        ...(request.create === undefined ? {} : { create: request.create }),
      })
    ).task;
  }
  async handoffTask(
    request: TaskCommand & { readonly handoff: TaskHandoffInput },
  ): Promise<TaskRecord> {
    return (
      await this.append(request, {
        type: 'handoff-recorded',
        handoff: request.handoff,
      })
    ).task;
  }
  async load(taskId: string): Promise<TaskRecord | null> {
    assertTaskId(taskId);
    return (await this.read()).tasks.get(taskId) ?? null;
  }
  async list(): Promise<readonly TaskRecord[]> {
    return [...(await this.read()).tasks.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.taskId.localeCompare(b.taskId),
    );
  }
  async updateTask(
    request: TaskCommand & {
      readonly title?: string;
      readonly nextAction?: string | null;
      readonly blocker?: string | null;
    },
  ): Promise<TaskRecord> {
    return (
      await this.append(request, {
        type: 'metadata-updated',
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.nextAction !== undefined
          ? { nextAction: request.nextAction }
          : {}),
        ...(request.blocker !== undefined ? { blocker: request.blocker } : {}),
      })
    ).task;
  }
  async bindRun(
    request: TaskCommand & { readonly run: TaskRunBinding },
  ): Promise<TaskRecord> {
    return (await this.append(request, { type: 'run-bound', run: request.run }))
      .task;
  }
  async attachEvidenceRoots(
    request: TaskCommand & {
      readonly runId: string;
      readonly receiptRoot: string;
      readonly evidenceRoot: string;
    },
  ): Promise<TaskRecord> {
    return (
      await this.append(request, {
        type: 'evidence-roots-attached',
        runId: request.runId,
        receiptRoot: request.receiptRoot,
        evidenceRoot: request.evidenceRoot,
      })
    ).task;
  }
  /** Trusted runtime append. Call TaskRuntime.accept for evidence-gated closeout. */
  async append(
    request: TaskCommand,
    change: TaskChange,
  ): Promise<TaskMutation> {
    assertTaskId(request.taskId);
    text(request.actor, 'actor');
    text(request.idempotencyKey, 'idempotency key');
    assert(
      Number.isSafeInteger(request.expectedVersion) &&
        request.expectedVersion >= 0,
      'Expected version is required.',
    );
    const copy = structuredClone(change);
    return this.withLock(async () => {
      const { events, tasks } = await this.read();
      const existing = tasks.get(request.taskId);
      const prior = existing?.events.find(
        (e) => e.idempotencyKey === request.idempotencyKey,
      );
      if (prior) {
        assert.equal(prior.actor, request.actor, 'Idempotency actor conflict.');
        assert.deepEqual(prior.change, copy, 'Idempotency payload conflict.');
        return { task: existing!, applied: false };
      }
      assert.equal(
        existing?.version ?? 0,
        request.expectedVersion,
        'Task version conflict; reload before updating.',
      );
      if (copy.type === 'run-bound') {
        const current = existing?.runs.find(
          (run) => run.runId === existing.currentRunId,
        );
        if (current?.executionStoreRoot) {
          // Missing/corrupt ownership is recovery work, never an empty-store success.
          assert(
            (await lstat(current.executionStoreRoot)).isDirectory(),
            'Execution store is missing.',
          );
          const store = await FileChildTaskStore.create(
            current.executionStoreRoot,
          );
          const records = await store.executionRecords(current.runId);
          assert(
            records.every(
              (record) =>
                !['QUEUED', 'RUNNING'].includes(record.status) &&
                (!record.execution || record.execution.state === 'CLEANED'),
            ),
            'Managed execution cleanup is unresolved; replacement run binding refused.',
          );
        }
      }
      const event: TaskEvent = {
        schema: 1,
        sequence: events.length + 1,
        taskId: request.taskId,
        taskVersion: request.expectedVersion + 1,
        actor: request.actor,
        idempotencyKey: request.idempotencyKey,
        at: new Date().toISOString(),
        change: copy,
      };
      const next = [...events, event];
      const projected = replay(next);
      await this.publish(next);
      return { task: projected.get(request.taskId)!, applied: true };
    });
  }
  private async publish(events: readonly TaskEvent[]): Promise<void> {
    const body = JSON.stringify({
      schema: 1,
      sha256: taskDigest(events),
      events,
    });
    assert(
      Buffer.byteLength(body) <= 32 * 1024 * 1024,
      'Task ledger exceeds local storage bound.',
    );
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.root, 'tasks.json'));
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(this.root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async hasInitializationMarker(): Promise<boolean> {
    try {
      const file = await open(
        join(this.root, '.task-store.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        assert(
          (await file.stat()).size <= 256,
          'Task store marker is invalid.',
        );
        assert.deepEqual(
          JSON.parse(await file.readFile('utf8')),
          { schema: 1, kind: 'temari-task-store' },
          'Task store marker is invalid.',
        );
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async read(): Promise<{
    events: readonly TaskEvent[];
    tasks: Map<string, TaskRecord>;
  }> {
    let content: string;
    try {
      const file = await open(
        join(this.root, 'tasks.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        assert(
          (await file.stat()).size <= 32 * 1024 * 1024,
          'Task ledger exceeds local storage bound.',
        );
        content = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          'Task ledger is missing; restore tasks.json from the retained store backup before continuing.',
          { cause: error },
        );
      throw error;
    }
    const ledger = JSON.parse(content) as {
      schema: number;
      sha256: string;
      events: TaskEvent[];
    };
    keys(ledger, ['schema', 'sha256', 'events']);
    assert.equal(ledger.schema, 1);
    assert.equal(
      ledger.sha256,
      taskDigest(ledger.events),
      'Task ledger digest mismatch.',
    );
    return { events: ledger.events, tasks: replay(ledger.events) };
  }
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.root, '.tasks.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!acquired)
      throw new Error(
        `Task ledger is locked; ${await this.lockOwnerDiagnostic(lock)}. Inspect the recorded host and process before manually recovering .tasks.lock. No automatic takeover was attempted.`,
      );
    const ownerPath = join(lock, 'owner.json');
    let ownerCreated = false;
    try {
      const owner = await open(ownerPath, 'wx', 0o600);
      ownerCreated = true;
      try {
        await owner.writeFile(
          JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            nonce: randomUUID(),
          }),
        );
        await owner.sync();
      } finally {
        await owner.close();
      }
      return await operation();
    } finally {
      if (ownerCreated) await unlink(ownerPath);
      await rmdir(lock);
    }
  }
  private async lockOwnerDiagnostic(lock: string): Promise<string> {
    try {
      const file = await open(
        join(lock, 'owner.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let body: string;
      try {
        assert((await file.stat()).size <= 4096);
        body = await file.readFile('utf8');
      } finally {
        await file.close();
      }
      const owner: unknown = JSON.parse(body);
      keys(owner, ['pid', 'hostname', 'startedAt', 'nonce']);
      object(owner);
      assert(Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0);
      text(owner.hostname, 'lock hostname', 256);
      date(owner.startedAt);
      assert(
        typeof owner.nonce === 'string' && /^[a-f0-9-]{36}$/.test(owner.nonce),
      );
      return `recorded owner ${JSON.stringify(owner)}`;
    } catch {
      return 'owner metadata is missing, unreadable, or invalid';
    }
  }
}
