import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import {
  FileChildTaskStore,
  type ChildTaskRecord,
} from './child-task-store.js';
import {
  taskDigest,
  type FileTaskStore,
  type TaskCommand,
  type TaskContextRef,
  type TaskRecord,
} from './task-store.js';

export interface TaskRepairReport {
  readonly repairId: string;
  readonly counterexample: string;
  readonly affectedSurface: string;
  readonly expectedInvariant: string;
  readonly evidenceRefs: readonly TaskContextRef[];
  readonly requestedScopes: readonly string[];
  readonly regressionContract: string;
  /** Temari's selected requirement; this can demand authority, never grant it. */
  readonly requiredRoute: 'lightweight-engineering' | 'full-playbook';
}
export type TaskRepairAdmission =
  | { readonly status: 'BLOCKED'; readonly missingAuthority: string }
  | {
      readonly status: 'ADMITTED';
      readonly executionId: string;
      readonly revision: string;
      readonly childRef: {
        readonly storeRoot: string;
        readonly groupId: string;
      };
      readonly selectionRef: TaskContextRef;
      readonly frozenCandidate: {
        readonly root: string;
        readonly revision: string;
        readonly tree: string;
      };
      readonly authorityRef: TaskContextRef;
      readonly selectionId: string;
      readonly selectionSha256: string;
      readonly manifestSha256: string;
    };
export interface RepairSupervisorRef {
  readonly schema: 1;
  readonly launchId: string;
  readonly executionId: string;
  readonly manifestSha256: string;
  readonly evidenceRoot: string;
  readonly supervisorId: string;
  readonly pid: number;
  readonly startedAt: string;
}
export interface TaskRepairLaunch {
  readonly commandId: string;
  readonly launchId: string;
  readonly state: 'PENDING' | 'UNCERTAIN' | 'CONFIRMED';
  readonly reference: RepairSupervisorRef | null;
  readonly reason: string | null;
  readonly diagnosticRef?: TaskContextRef;
}
/** Installed hosts retain the raw cause privately before projecting uncertainty. */
export class RepairLaunchFailure extends Error {
  constructor(
    message: string,
    readonly diagnosticRef: TaskContextRef,
  ) {
    super(message);
    fields(diagnosticRef, ['kind', 'location', 'sha256']);
    assert.equal(diagnosticRef.kind, 'repair-controller-failure');
    assert(isAbsolute(diagnosticRef.location));
    digest(diagnosticRef.sha256);
  }
}
export interface RepairVerificationSelection {
  readonly candidateRoot: string;
  readonly revision: string;
  readonly artifactRoot: string;
  readonly manifestSha256: string;
  readonly evidencePath: string;
  readonly evidenceSha256: string;
}
export interface TaskRepairResolution {
  readonly selection: RepairVerificationSelection;
  readonly reason: string;
  readonly actor: string;
  readonly at: string;
}
export interface TaskRepair {
  readonly report: TaskRepairReport;
  readonly reportSha256: string;
  readonly admission: TaskRepairAdmission;
  readonly launch: TaskRepairLaunch | null;
  readonly resolution: TaskRepairResolution | null;
  readonly requestedAt: string;
}
export interface RepairHostObservation {
  readonly reference: RepairSupervisorRef | null;
  readonly workerStarted: boolean;
  readonly heartbeatCurrent: boolean;
  readonly drained: boolean;
  readonly issues: readonly string[];
}
/** Host configuration is selected independently of a discrepancy report. */
export interface TaskRepairHost {
  reserve(
    task: TaskRecord,
    report: TaskRepairReport,
    launchId: string,
  ): Promise<TaskRepairAdmission>;
  launch(task: TaskRecord, repair: TaskRepair): Promise<RepairSupervisorRef>;
  inspect(task: TaskRecord, repair: TaskRepair): Promise<RepairHostObservation>;
  verify(
    task: TaskRecord,
    repair: TaskRepair,
    selection?: RepairVerificationSelection,
  ): Promise<RepairVerificationSelection>;
}
export interface TaskRepairSnapshot {
  readonly repairId: string;
  readonly state:
    | 'BLOCKED'
    | 'STARTING'
    | 'RUNNING'
    | 'RECOVERY_REQUIRED'
    | 'FAILED'
    | 'CANCELLED'
    | 'NEEDS_REVIEW'
    | 'RESOLVED';
  readonly launch: TaskRepairLaunch | null;
  readonly child: ChildTaskRecord | null;
  readonly issues: readonly string[];
  readonly selectionRef: TaskContextRef | null;
}

function fields(value: object, expected: readonly string[]): void {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    'Repair has unknown or missing fields.',
  );
}
function text(value: unknown, limit = 4096): asserts value is string {
  assert(
    typeof value === 'string' &&
      value.trim() &&
      value.length <= limit &&
      !value.includes('\0'),
    'Invalid repair text.',
  );
}
function id(value: unknown): void {
  text(value, 128);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value));
}
function digest(value: unknown): void {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}
export function assertRepairReport(value: TaskRepairReport): void {
  fields(value, [
    'repairId',
    'counterexample',
    'affectedSurface',
    'expectedInvariant',
    'evidenceRefs',
    'requestedScopes',
    'regressionContract',
    'requiredRoute',
  ]);
  assert(
    ['lightweight-engineering', 'full-playbook'].includes(value.requiredRoute),
  );
  id(value.repairId);
  text(value.counterexample, 16384);
  text(value.affectedSurface);
  text(value.expectedInvariant, 16384);
  id(value.regressionContract);
  assert(
    Array.isArray(value.requestedScopes) &&
      value.requestedScopes.length > 0 &&
      value.requestedScopes.length <= 32,
  );
  assert.equal(
    new Set(value.requestedScopes).size,
    value.requestedScopes.length,
  );
  value.requestedScopes.forEach(id);
  assert(
    Array.isArray(value.evidenceRefs) &&
      value.evidenceRefs.length > 0 &&
      value.evidenceRefs.length <= 32,
  );
  for (const ref of value.evidenceRefs) {
    assert(
      Object.keys(ref).every((key) =>
        ['kind', 'location', 'sha256'].includes(key),
      ),
    );
    text(ref.kind, 64);
    text(ref.location);
    if (ref.sha256 !== undefined) digest(ref.sha256);
  }
}
export function assertRepairSelection(
  value: RepairVerificationSelection,
): void {
  fields(value, [
    'candidateRoot',
    'revision',
    'artifactRoot',
    'manifestSha256',
    'evidencePath',
    'evidenceSha256',
  ]);
  for (const path of [
    value.candidateRoot,
    value.artifactRoot,
    value.evidencePath,
  ]) {
    text(path);
    assert(isAbsolute(path));
  }
  assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision));
  digest(value.manifestSha256);
  digest(value.evidenceSha256);
}
export function assertRepairReference(value: RepairSupervisorRef): void {
  fields(value, [
    'schema',
    'launchId',
    'executionId',
    'manifestSha256',
    'evidenceRoot',
    'supervisorId',
    'pid',
    'startedAt',
  ]);
  assert.equal(value.schema, 1);
  id(value.launchId);
  id(value.executionId);
  digest(value.manifestSha256);
  text(value.evidenceRoot);
  assert(isAbsolute(value.evidenceRoot));
  text(value.supervisorId, 128);
  assert(Number.isSafeInteger(value.pid) && value.pid > 0);
  assert(Number.isFinite(Date.parse(value.startedAt)));
}
export function assertRepairRecord(value: TaskRepair): void {
  fields(value, [
    'report',
    'reportSha256',
    'admission',
    'launch',
    'resolution',
    'requestedAt',
  ]);
  assertRepairReport(value.report);
  assert.equal(value.reportSha256, taskDigest(value.report));
  assert.equal(value.resolution, null);
  assert(Number.isFinite(Date.parse(value.requestedAt)));
  const admission = value.admission;
  if (admission.status === 'BLOCKED') {
    fields(admission, ['status', 'missingAuthority']);
    text(admission.missingAuthority);
    assert.equal(value.launch, null);
  } else {
    fields(admission, [
      'status',
      'executionId',
      'revision',
      'childRef',
      'selectionRef',
      'frozenCandidate',
      'authorityRef',
      'selectionId',
      'selectionSha256',
      'manifestSha256',
    ]);
    assert.equal(admission.status, 'ADMITTED');
    id(admission.executionId);
    text(admission.revision);
    id(admission.selectionId);
    digest(admission.selectionSha256);
    digest(admission.manifestSha256);
    fields(admission.childRef, ['storeRoot', 'groupId']);
    assert(isAbsolute(admission.childRef.storeRoot));
    id(admission.childRef.groupId);
    fields(admission.selectionRef, ['kind', 'location', 'sha256']);
    assert.equal(admission.selectionRef.kind, 'repair-selection-context');
    assert(isAbsolute(admission.selectionRef.location));
    assert.equal(admission.selectionRef.sha256, admission.selectionSha256);
    fields(admission.frozenCandidate, ['root', 'revision', 'tree']);
    assert(isAbsolute(admission.frozenCandidate.root));
    assert.equal(admission.frozenCandidate.revision, admission.revision);
    assert(/^[a-f0-9]{40,64}$/.test(admission.frozenCandidate.tree));
    fields(admission.authorityRef, ['kind', 'location', 'sha256']);
    assert.equal(admission.authorityRef.kind, 'repair-admission-observation');
    assert(isAbsolute(admission.authorityRef.location));
    digest(admission.authorityRef.sha256);
    assert(value.launch);
    fields(value.launch, [
      'commandId',
      'launchId',
      'state',
      'reference',
      'reason',
    ]);
    id(value.launch.launchId);
    text(value.launch.commandId, 128);
    assert.equal(value.launch.state, 'PENDING');
    assert.equal(value.launch.reference, null);
    assert.equal(value.launch.reason, null);
  }
}

function repairFor(task: TaskRecord, repairId: string): TaskRepair {
  const repair = task.repairs.find((item) => item.report.repairId === repairId);
  assert(repair, 'Repair is not bound to this task.');
  return repair;
}
/** Composes ledger facts and the existing child owner; never reclaims a launch. */
export class TaskRepairs {
  constructor(
    private readonly store: FileTaskStore,
    private readonly host?: TaskRepairHost,
  ) {}
  async initiate(
    command: TaskCommand & { readonly report: TaskRepairReport },
    readmit = false,
  ): Promise<void> {
    assertRepairReport(command.report);
    const task = await this.store.load(command.taskId);
    assert(task, 'Task does not exist.');
    const priorCommand = task.events.find(
      (event) => event.idempotencyKey === command.idempotencyKey,
    );
    if (priorCommand) {
      assert.equal(
        priorCommand.actor,
        command.actor,
        'Idempotency actor conflict.',
      );
      assert(
        ['repair-bound', 'repair-admitted'].includes(priorCommand.change.type),
        'Idempotency payload conflict.',
      );
      if (priorCommand.change.type === 'repair-bound')
        assert.deepEqual(
          priorCommand.change.repair.report,
          command.report,
          'Idempotency payload conflict.',
        );
      if (priorCommand.change.type === 'repair-admitted')
        assert.equal(
          priorCommand.change.repairId,
          command.report.repairId,
          'Idempotency payload conflict.',
        );
    }
    const old = task.repairs.find(
      (item) => item.report.repairId === command.report.repairId,
    );
    if (readmit)
      assert(
        old &&
          (priorCommand?.change.type === 'repair-admitted' ||
            (old.admission.status === 'BLOCKED' &&
              !old.launch &&
              !old.resolution)),
        'Only a never-launched BLOCKED repair may be explicitly re-admitted.',
      );
    if (old) {
      assert.deepEqual(
        old.report,
        command.report,
        'Repair report is immutable.',
      );
      if (
        !readmit ||
        priorCommand ||
        old.admission.status !== 'BLOCKED' ||
        old.launch ||
        !this.host
      )
        return;
    }
    assert.equal(
      task.version,
      command.expectedVersion,
      'Task version conflict; reload before updating.',
    );
    const launchId = `repair-${taskDigest([task.taskId, command.report.repairId, command.report]).slice(0, 48)}`;
    const admission = this.host
      ? await this.host.reserve(task, command.report, launchId)
      : {
          status: 'BLOCKED' as const,
          missingAuthority:
            'No independently selected repair authority is available.',
        };
    const repair: TaskRepair = {
      report: command.report,
      reportSha256: taskDigest(command.report),
      admission,
      launch:
        admission.status === 'ADMITTED'
          ? {
              commandId: command.idempotencyKey,
              launchId,
              state: 'PENDING',
              reference: null,
              reason: null,
            }
          : null,
      resolution: null,
      requestedAt: old?.requestedAt ?? new Date().toISOString(),
    };
    let applied;
    try {
      if (old && admission.status === 'BLOCKED')
        throw new Error(
          `Repair re-admission remains BLOCKED: ${admission.missingAuthority}`,
        );
      applied = await this.store.append(
        command,
        old
          ? {
              type: 'repair-admitted',
              repairId: old.report.repairId,
              admission,
              launch: repair.launch!,
            }
          : { type: 'repair-bound', repair },
      );
    } catch (error) {
      const raced = await this.store.load(command.taskId);
      const same = raced?.repairs.find(
        (item) => item.report.repairId === command.report.repairId,
      );
      if (!same || same.admission.status === 'BLOCKED') throw error;
      assert.deepEqual(
        same.report,
        command.report,
        'Repair report is immutable.',
      );
      return;
    }
    if (!applied.applied || admission.status === 'BLOCKED') return;
    try {
      const reference = await this.host!.launch(applied.task, repair);
      await this.recordObservation(command.taskId, repair, reference);
    } catch (error) {
      await this.appendLatest(command.taskId, `${launchId}:uncertain`, {
        type: 'repair-launch-uncertain',
        repairId: command.report.repairId,
        launchId,
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          4096,
        ),
        ...(error instanceof RepairLaunchFailure
          ? { diagnosticRef: error.diagnosticRef }
          : {}),
      });
    }
  }
  private async appendLatest(
    taskId: string,
    key: string,
    change: Parameters<FileTaskStore['append']>[1],
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const task = await this.store.load(taskId);
      assert(task);
      try {
        await this.store.append(
          {
            taskId,
            actor: 'temari-repair-runtime',
            idempotencyKey: key,
            expectedVersion: task.version,
          },
          change,
        );
        return;
      } catch (error) {
        if (!String(error).includes('version conflict') || attempt === 7)
          throw error;
      }
    }
  }
  private async recordObservation(
    taskId: string,
    repair: TaskRepair,
    reference: RepairSupervisorRef,
  ): Promise<void> {
    await this.appendLatest(taskId, `${repair.launch!.launchId}:observed`, {
      type: 'repair-launch-observed',
      repairId: repair.report.repairId,
      launchId: repair.launch!.launchId,
      reference,
    });
  }
  async reconcile(taskId: string, repairId: string): Promise<void> {
    const task = await this.store.load(taskId);
    assert(task);
    const repair = repairFor(task, repairId);
    if (!this.host || repair.admission.status === 'BLOCKED') return;
    try {
      const observed = await this.host.inspect(task, repair);
      if (observed.reference && !repair.launch?.reference)
        await this.recordObservation(taskId, repair, observed.reference);
    } catch {}
  }
  async accept(
    command: TaskCommand & {
      readonly repairId: string;
      readonly selection: RepairVerificationSelection;
      readonly reason: string;
    },
  ): Promise<void> {
    assertRepairSelection(command.selection);
    text(command.reason);
    assert(this.host, 'Repair verification host is unavailable.');
    const task = await this.store.load(command.taskId);
    assert(task);
    const repair = repairFor(task, command.repairId);
    if (repair.resolution) {
      assert.deepEqual(
        repair.resolution.selection,
        command.selection,
        'Repair resolution is immutable.',
      );
      assert.equal(
        repair.resolution.reason,
        command.reason,
        'Repair resolution is immutable.',
      );
      assert.equal(
        repair.resolution.actor,
        command.actor,
        'Repair resolution actor conflict.',
      );
      await this.host.verify(task, repair, command.selection);
      return;
    }
    const snapshot = await this.inspect(task, repair);
    assert(
      ['NEEDS_REVIEW', 'RESOLVED'].includes(snapshot.state),
      'Repair is not ready for coordinator review.',
    );
    const selection = await this.host.verify(task, repair, command.selection);
    assert.deepEqual(selection, command.selection);
    await this.store.append(command, {
      type: 'repair-resolved',
      repairId: command.repairId,
      resolution: {
        selection,
        reason: command.reason,
        actor: command.actor,
        at: new Date().toISOString(),
      },
    });
  }
  async snapshots(task: TaskRecord): Promise<readonly TaskRepairSnapshot[]> {
    return Promise.all(
      task.repairs.map((repair) => this.inspect(task, repair)),
    );
  }
  private async inspect(
    task: TaskRecord,
    repair: TaskRepair,
  ): Promise<TaskRepairSnapshot> {
    const base = {
      repairId: repair.report.repairId,
      launch: repair.launch,
      child: null,
      issues: [] as readonly string[],
      selectionRef:
        repair.admission.status === 'ADMITTED'
          ? repair.admission.selectionRef
          : null,
    };
    if (repair.admission.status === 'BLOCKED')
      return {
        ...base,
        state: 'BLOCKED',
        issues: [repair.admission.missingAuthority],
      };
    if (!this.host)
      return {
        ...base,
        state: 'RECOVERY_REQUIRED',
        issues: [
          'The independently selected repair host is unavailable; no launch is permitted.',
        ],
      };
    try {
      const observed = await this.host.inspect(task, repair);
      const rootInfo = await lstat(repair.admission.childRef.storeRoot);
      assert(
        rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
        'Repair child store is missing or changed.',
      );
      const store = await FileChildTaskStore.create(
        repair.admission.childRef.storeRoot,
      );
      const group = await store.loadGroup(repair.admission.childRef.groupId);
      assert(
        group &&
          group.taskIds.length === 1 &&
          group.runId === repair.admission.executionId &&
          group.revision === repair.admission.revision,
        'Repair child binding changed.',
      );
      const child = await store.load(group.taskIds[0]!);
      assert(child, 'Repair child is missing.');
      const result = { ...base, child, issues: observed.issues };
      if (observed.issues.length)
        return {
          ...result,
          state: repair.resolution ? 'BLOCKED' : 'RECOVERY_REQUIRED',
        };
      if (!observed.drained) {
        if (!observed.heartbeatCurrent)
          return {
            ...result,
            state: 'RECOVERY_REQUIRED',
            issues: [
              'Repair launch is uncertain; inspect the same reservation without relaunching.',
            ],
          };
        if (!observed.workerStarted || child.status === 'QUEUED')
          return { ...result, state: 'STARTING' };
        if (
          child.status !== 'RUNNING' ||
          !child.lease ||
          Date.parse(child.lease.expiresAt) <= Date.now()
        )
          return {
            ...result,
            state: 'RECOVERY_REQUIRED',
            issues: ['Repair child lease or supervisor drain is uncertain.'],
          };
        return { ...result, state: 'RUNNING' };
      }
      if (child.status === 'CANCELLED')
        return { ...result, state: 'CANCELLED' };
      if (child.status === 'RUNNING' || child.status === 'QUEUED')
        return {
          ...result,
          state: 'RECOVERY_REQUIRED',
          issues: [
            'Supervisor drained without a terminal child fact; no replacement launch is permitted.',
          ],
        };
      if (child.status !== 'SUCCEEDED')
        return {
          ...result,
          state: 'FAILED',
          issues: [
            child.error ?? child.result?.summary ?? 'Repair did not succeed.',
          ],
        };
      await this.host.verify(task, repair, repair.resolution?.selection);
      return {
        ...result,
        state: repair.resolution ? 'RESOLVED' : 'NEEDS_REVIEW',
      };
    } catch (error) {
      return {
        ...base,
        state: repair.resolution ? 'BLOCKED' : 'RECOVERY_REQUIRED',
        issues: [
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            4096,
          ),
        ],
      };
    }
  }
}
