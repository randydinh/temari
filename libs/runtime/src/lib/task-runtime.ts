import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import {
  TaskRepairs,
  type TaskRepairHost,
  type TaskRepairReport,
  type RepairVerificationSelection,
  type TaskRepairSnapshot,
} from './task-repair.js';
import type {
  HarnessRunRef,
  HarnessRunSnapshot,
  WorkflowStageId,
} from '@temari/contracts';
import { FileWorkflowReceiptStore } from './runtime.js';
import { FileEvidenceStore } from './evidence-store.js';
import {
  FileChildTaskStore,
  type ChildTaskRecord,
} from './child-task-store.js';
import { verifyStageEvidenceRecord } from './stage-evidence.js';
import {
  cancelExecutionHarness,
  getExecutionHarnessStatus,
  resumeExecutionHarness,
  startExecutionHarness,
  verifyExecutionHarnessRunIdentity,
  startReviewedLocalCandidateHarness,
  type ReviewedLocalCandidatePaths,
} from './harness-runtime.js';
import {
  selectExecutionHarness,
  type HarnessSelection,
} from './harness-selector.js';
import {
  FileTaskStore,
  assertTaskNativeRef,
  taskDigest,
  type TaskChange,
  type TaskCommand,
  type TaskRecord,
  type TaskRun,
} from './task-store.js';
import {
  projectTaskPickupBrief,
  projectTaskPickupChoice,
  selectTaskPickupCandidates,
  type TaskPickupRequest,
  type TaskPickupResult,
} from './task-pickup.js';

export type TaskStatus =
  'OPEN' | 'RUNNING' | 'BLOCKED' | 'NEEDS_REVIEW' | 'DONE' | 'CANCELLED';
export interface TaskEvidenceSnapshot {
  readonly verified: boolean;
  readonly scope: 'persisted-stage-evidence-only' | null;
  readonly receiptSha256: string | null;
  readonly issues: readonly string[];
}
export interface TaskRunSnapshot {
  readonly runId: string;
  readonly revision: string;
  readonly receiptStatus: string | null;
  readonly stages: readonly {
    readonly stage: WorkflowStageId;
    readonly status: string;
    readonly summary: string;
  }[];
  readonly evidence: TaskEvidenceSnapshot;
  readonly children: readonly ChildTaskRecord[];
  readonly issues: readonly string[];
}
export interface TaskSnapshot extends TaskRecord {
  readonly status: TaskStatus;
  readonly currentStage: WorkflowStageId | null;
  readonly evidence: TaskEvidenceSnapshot;
  readonly semanticAcceptance: boolean;
  readonly runSnapshots: readonly TaskRunSnapshot[];
  readonly repairSnapshots: readonly TaskRepairSnapshot[];
}
export type TaskRunCommand = TaskCommand & { readonly runId: string };
const missingEvidence: TaskEvidenceSnapshot = {
  verified: false,
  scope: null,
  receiptSha256: null,
  issues: ['No run is bound to this task.'],
};
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}
function boundRun(task: TaskRecord, runId: string): TaskRun {
  const run = task.runs.find((r) => r.runId === runId);
  assert(run, 'Run is not bound to this task.');
  return run;
}
function closeoutEligibility(run: TaskRun): void {
  assert(
    run.plan.delivery === 'local' &&
      run.plan.delegation !== 'required' &&
      run.plan.review !== 'independent' &&
      (run.plan.parallelism?.maxConcurrency ?? 1) === 1,
    'This closeout verifies local serial stage evidence only; required delegation, independent review, parallel or forge delivery needs a route-specific verifier.',
  );
}

/** Task continuity composes the existing executor and evidence stores; it does
 * not execute workflow stages, retry native runs, or infer semantic acceptance.
 */
export class TaskRuntime {
  private readonly store: FileTaskStore;
  private readonly selection: HarnessSelection | undefined;
  private readonly repairs: TaskRepairs;
  constructor(options: {
    readonly store: FileTaskStore;
    readonly selection?: HarnessSelection;
    readonly repairHost?: TaskRepairHost;
  }) {
    this.store = options.store;
    this.selection = options.selection;
    this.repairs = new TaskRepairs(options.store, options.repairHost);
  }

  async snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(taskId);
    const runSnapshots = await Promise.all(
      task.runs.map((run) => this.inspectRun(run)),
    );
    return this.projectSnapshot(
      task,
      runSnapshots,
      await this.repairs.snapshots(task),
    );
  }
  async initiateRepair(
    input: TaskCommand & { readonly report: TaskRepairReport },
  ): Promise<TaskSnapshot> {
    await this.repairs.initiate(input);
    return this.snapshot(input.taskId);
  }
  async reconcileRepair(input: {
    readonly taskId: string;
    readonly repairId: string;
  }): Promise<TaskSnapshot> {
    await this.repairs.reconcile(input.taskId, input.repairId);
    return this.snapshot(input.taskId);
  }
  async readmitRepair(
    input: TaskCommand & { readonly report: TaskRepairReport },
  ): Promise<TaskSnapshot> {
    await this.repairs.initiate(input, true);
    return this.snapshot(input.taskId);
  }
  async acceptRepair(
    input: TaskCommand & {
      readonly repairId: string;
      readonly selection: RepairVerificationSelection;
      readonly reason: string;
    },
  ): Promise<TaskSnapshot> {
    await this.repairs.accept(input);
    return this.snapshot(input.taskId);
  }
  private projectSnapshot(
    task: TaskRecord,
    runSnapshots: readonly TaskRunSnapshot[],
    repairSnapshots: readonly TaskRepairSnapshot[],
  ): TaskSnapshot {
    const run = task.runs.find((r) => r.runId === task.currentRunId);
    const observed = runSnapshots.find((r) => r.runId === task.currentRunId);
    const evidence = observed?.evidence ?? missingEvidence;
    const pending = run?.operations.find((op) => op.state !== 'CONFIRMED');
    let eligible = false;
    if (run) {
      try {
        closeoutEligibility(run);
        eligible = true;
      } catch {
        /* Present verified evidence for review while stronger route proof is unavailable. */
      }
    }
    const parentAccepted = Boolean(
      task.acceptance &&
      task.acceptance.runId === run?.runId &&
      task.acceptance.receiptSha256 === evidence.receiptSha256 &&
      evidence.verified &&
      eligible &&
      !pending &&
      !observed?.issues.length &&
      observed?.children.every((c) => c.status === 'SUCCEEDED') &&
      (!run?.nativeRef || run.nativeSnapshot?.status === 'SUCCEEDED'),
    );
    let status: TaskStatus = 'OPEN';
    let blocker = task.blocker;
    let nextAction = task.nextAction;
    const currentStage =
      observed?.stages.find((s) => s.status !== 'PASS')?.stage ??
      (observed && run
        ? (run.plan.stages[observed.stages.length] ?? null)
        : null);
    if (parentAccepted && !task.blocker) status = 'DONE';
    else if (pending) {
      status = 'BLOCKED';
      blocker ??=
        pending.reason ??
        `${pending.kind} intent is retained; its executor outcome is unresolved.`;
      nextAction ??=
        'Reconcile the exact native run before sending another control command.';
    } else if (
      task.blocker ||
      observed?.issues.length ||
      observed?.children.some((c) =>
        ['FAILED', 'BLOCKED', 'ISSUES', 'DROPPED'].includes(c.status),
      )
    ) {
      status = 'BLOCKED';
      blocker ??= observed?.issues[0] ?? 'A child assignment needs attention.';
    } else if (run?.nativeSnapshot?.status === 'CANCELLED')
      status = 'CANCELLED';
    else if (
      run?.nativeSnapshot &&
      ['FAILED', 'BLOCKED'].includes(run.nativeSnapshot.status)
    ) {
      status = 'BLOCKED';
      blocker ??= run.nativeSnapshot.summary;
    } else if (
      run?.nativeRef &&
      (!run.nativeSnapshot || run.nativeSnapshot.status === 'UNKNOWN')
    ) {
      status = 'BLOCKED';
      blocker ??= 'The bound executor state has not been confirmed.';
      nextAction ??= 'Observe the exact bound run.';
    } else if (
      run?.nativeSnapshot &&
      ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot.status)
    )
      status = 'RUNNING';
    else if (observed?.receiptStatus && observed.receiptStatus !== 'PASS') {
      status = 'BLOCKED';
      blocker ??= `Canonical workflow receipt reports ${observed.receiptStatus}.`;
    } else if (
      observed?.children.some((child) =>
        ['QUEUED', 'RUNNING'].includes(child.status),
      )
    )
      status = 'RUNNING';
    else if (observed?.children.some((child) => child.status === 'CANCELLED')) {
      status = 'CANCELLED';
      nextAction ??=
        'Review the retained worker results. Cancelled assignments do not establish completion.';
    } else if (evidence.verified) {
      status = 'NEEDS_REVIEW';
      nextAction ??= eligible
        ? 'Review the verified stage evidence and record coordinator acceptance.'
        : 'Obtain the route-specific review, delegation or delivery proof before closeout.';
    } else if (task.acceptance) {
      status = 'BLOCKED';
      blocker ??= 'Previously accepted evidence no longer verifies.';
    } else if (
      observed?.children.length &&
      observed.children.every((child) => child.status === 'SUCCEEDED')
    ) {
      status = 'NEEDS_REVIEW';
      nextAction ??=
        'Parallel findings are ready. Temari must review the retained worker evidence and decide the next step; this is not canonical task completion.';
    } else if (run?.nativeSnapshot?.status === 'SUCCEEDED')
      nextAction ??=
        'Retain and verify the canonical stage evidence; native success does not close this task.';
    else
      nextAction ??= run
        ? 'Execute the bound plan and retain its canonical receipt and evidence.'
        : 'Bind the first execution plan to this task.';
    const unresolved = repairSnapshots.find(
      (repair) => repair.state !== 'RESOLVED',
    );
    if (
      unresolved &&
      (!run || status === 'DONE' || status === 'NEEDS_REVIEW')
    ) {
      status = ['RUNNING', 'STARTING'].includes(unresolved.state)
        ? 'RUNNING'
        : unresolved.state === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : 'BLOCKED';
      blocker ??= unresolved.issues[0] ?? null;
      nextAction ??= `Review required repair ${unresolved.repairId} before closing this task.`;
    }
    return {
      ...task,
      status,
      nextAction,
      blocker,
      currentStage,
      evidence,
      semanticAcceptance: parentAccepted && !unresolved,
      runSnapshots,
      repairSnapshots,
    };
  }
  async listSnapshots(): Promise<readonly TaskSnapshot[]> {
    const tasks = await this.store.list();
    return Promise.all(tasks.map((t) => this.snapshot(t.taskId)));
  }
  async pickup(request: TaskPickupRequest): Promise<TaskPickupResult> {
    const { candidates, limit } = await selectTaskPickupCandidates(
      await this.store.list(),
      request,
    );
    const choices = candidates.slice(0, limit).map(projectTaskPickupChoice);
    if (candidates.length !== 1)
      return {
        schema: 1,
        status: candidates.length === 0 ? 'empty' : 'choices',
        choices,
        hasMore: candidates.length > limit,
        selected: null,
      };
    const task = candidates[0]!;
    const run = task.runs.find((item) => item.runId === task.currentRunId);
    // A pickup validates only the selected current run. Full history remains
    // available through the explicit task snapshot and retained event ledger.
    const refreshed = this.projectSnapshot(
      task,
      run ? [await this.inspectRun(run)] : [],
      await this.repairs.snapshots(task),
    );
    return {
      schema: 1,
      status: 'selected',
      choices,
      hasMore: false,
      selected: projectTaskPickupBrief(refreshed),
    };
  }

  async dispatch(
    request: TaskRunCommand & {
      readonly entrypoint: string;
      readonly inputs: Readonly<Record<string, string>>;
    },
  ): Promise<TaskSnapshot> {
    assert.notEqual(
      request.entrypoint,
      'temari-reviewed-local-candidate',
      'Managed candidate requires route-specific admission and dispatch.',
    );
    return (
      await this.dispatchThrough(request, (run, task, intent) =>
        startExecutionHarness(this.requireSelection(), {
          runId: run.runId,
          revision: run.revision,
          plan: run.plan,
          workspaceRoot: task.workspaceRoot,
          entrypoint: intent.entrypoint!,
          inputs: intent.inputs!,
          recovery: 'required',
        }),
      )
    ).task;
  }

  /** Persist the exact protected inputs before the managed admission/start port.
   * Duplicate and uncertain dispatch never fall through to a second native launch. */
  async dispatchReviewedLocalCandidate(
    request: TaskRunCommand & {
      readonly paths: ReviewedLocalCandidatePaths;
    },
  ): Promise<{ readonly task: TaskSnapshot; readonly dispatched: boolean }> {
    const paths = structuredClone(request.paths);
    for (const pin of [
      paths.expectedRequestSha256,
      paths.expectedBridgeSha256,
      paths.bridgeRuntimeSha256,
    ])
      assert.match(pin, /^[a-f0-9]{64}$/);
    return this.dispatchThrough(
      {
        ...request,
        entrypoint: 'temari-reviewed-local-candidate',
        inputs: {
          spec: paths.specPath,
          bridge: paths.bridgePath,
          request_sha256: paths.expectedRequestSha256,
          bridge_sha256: paths.expectedBridgeSha256,
          bridge_runtime: paths.bridgeRuntimeExecutable,
          bridge_runtime_sha256: paths.bridgeRuntimeSha256,
        },
      },
      (run, task) =>
        startReviewedLocalCandidateHarness(
          this.requireSelection(),
          {
            runId: run.runId,
            revision: run.revision,
            plan: run.plan,
            workspaceRoot: task.workspaceRoot,
            recovery: 'required',
          },
          paths,
        ),
    );
  }

  private async dispatchThrough(
    request: TaskRunCommand & {
      readonly entrypoint: string;
      readonly inputs: Readonly<Record<string, string>>;
    },
    launch: (
      run: TaskRun,
      task: TaskRecord,
      intent: TaskRun['operations'][number],
    ) => Promise<HarnessRunRef>,
  ): Promise<{ readonly task: TaskSnapshot; readonly dispatched: boolean }> {
    const selection = this.requireSelection();
    const harness = selectExecutionHarness(selection);
    assert(
      harness.verifyRunIdentity,
      'Task dispatch requires independent native identity verification support.',
    );
    const started = await this.store.append(request, {
      type: 'dispatch-requested',
      runId: request.runId,
      entrypoint: request.entrypoint,
      inputs: request.inputs,
      harnessId: harness.id,
      harnessVersion: harness.version,
    });
    if (!started.applied)
      return { task: await this.snapshot(request.taskId), dispatched: false };
    const run = boundRun(started.task, request.runId);
    const intent = run.operations.find(
      (op) => op.commandId === request.idempotencyKey,
    )!;
    try {
      const reference = await launch(run, started.task, intent);
      await this.finish(request, 'bound', {
        type: 'native-bound',
        runId: run.runId,
        reference,
        operationId: request.idempotencyKey,
      });
    } catch (error) {
      await this.uncertain(request, error);
      throw error;
    }
    return { task: await this.snapshot(request.taskId), dispatched: true };
  }

  /** Recover a retained dispatch only after the selected executor recognizes
   * the exact reference. UNKNOWN never authorizes a second start.
   */
  async reconcileNative(
    request: TaskRunCommand & { readonly reference: HarnessRunRef },
  ): Promise<TaskSnapshot> {
    const task = await this.requireTask(request.taskId);
    const run = boundRun(task, request.runId);
    assertTaskNativeRef(request.reference, task, run);
    if (run.nativeRef)
      assert.deepEqual(
        run.nativeRef,
        request.reference,
        'Native identity is immutable.',
      );
    const duplicate = task.events.find(
      (event) => event.idempotencyKey === request.idempotencyKey,
    );
    if (duplicate) {
      assert.equal(
        duplicate.actor,
        request.actor,
        'Idempotency actor conflict.',
      );
      assert.equal(
        duplicate.change.type,
        'native-bound',
        'Idempotency command conflict.',
      );
      assert(duplicate.change.type === 'native-bound');
      assert.deepEqual(
        duplicate.change.reference,
        request.reference,
        'Idempotency native binding conflict.',
      );
      return this.snapshot(request.taskId);
    }
    await verifyExecutionHarnessRunIdentity(
      this.requireSelection(),
      request.reference,
    );
    const observation = await getExecutionHarnessStatus(
      this.requireSelection(),
      request.reference,
    );
    assert.notEqual(
      observation.status,
      'UNKNOWN',
      'Exact native run is not verified by the executor.',
    );
    const dispatch = run.operations.find((op) => op.kind === 'dispatch')!;
    await this.store.append(request, {
      type: 'native-bound',
      runId: run.runId,
      reference: request.reference,
      operationId: dispatch.commandId,
    });
    await this.finish(request, 'observation', {
      type: 'native-observed',
      runId: run.runId,
      snapshot: observation,
    });
    return this.snapshot(request.taskId);
  }

  /** Status observation also resolves a pending resume/cancel, but only when
   * the returned state resolves that operation. A naturally terminal run
   * resolves cancel intent without claiming that cancellation took effect.
   */
  async observeNative(request: TaskRunCommand): Promise<TaskSnapshot> {
    const task = await this.requireTask(request.taskId);
    const run = boundRun(task, request.runId);
    assert(run.nativeRef, 'No native run is bound.');
    const duplicate = task.events.find(
      (event) => event.idempotencyKey === request.idempotencyKey,
    );
    if (duplicate) {
      assert.equal(
        duplicate.actor,
        request.actor,
        'Idempotency actor conflict.',
      );
      assert.equal(
        duplicate.change.type,
        'native-observed',
        'Idempotency command conflict.',
      );
      assert(duplicate.change.type === 'native-observed');
      assert.equal(
        duplicate.change.runId,
        request.runId,
        'Idempotency run binding conflict.',
      );
      return this.snapshot(request.taskId);
    }
    const observation = await getExecutionHarnessStatus(
      this.requireSelection(),
      run.nativeRef,
    );
    const pending = run.operations.find((op) => op.state !== 'CONFIRMED');
    await this.store.append(request, {
      type: 'native-observed',
      runId: run.runId,
      snapshot: observation,
      ...(pending ? { operationId: pending.commandId } : {}),
    });
    return this.snapshot(request.taskId);
  }

  async resume(request: TaskRunCommand): Promise<TaskSnapshot> {
    return this.control(request, 'resume');
  }
  async cancel(request: TaskRunCommand): Promise<TaskSnapshot> {
    return this.control(request, 'cancel');
  }
  private async control(
    request: TaskRunCommand,
    kind: 'resume' | 'cancel',
  ): Promise<TaskSnapshot> {
    const selection = this.requireSelection();
    const retained = await this.store.append(request, {
      type: 'control-requested',
      runId: request.runId,
      kind,
    });
    if (!retained.applied) return this.snapshot(request.taskId);
    const run = boundRun(retained.task, request.runId);
    assert(run.nativeRef);
    try {
      const observation: HarnessRunSnapshot = await (
        kind === 'cancel' ? cancelExecutionHarness : resumeExecutionHarness
      )(selection, run.nativeRef);
      await this.finish(request, 'observation', {
        type: 'native-observed',
        runId: run.runId,
        snapshot: observation,
        operationId: request.idempotencyKey,
      });
    } catch (error) {
      await this.uncertain(request, error);
      throw error;
    }
    return this.snapshot(request.taskId);
  }

  async verifyEvidence(request: TaskRunCommand): Promise<TaskSnapshot> {
    const task = await this.requireTask(request.taskId);
    const inspected = await this.inspectRun(boundRun(task, request.runId));
    assert(inspected.evidence.verified, inspected.evidence.issues.join('; '));
    assert(inspected.evidence.receiptSha256);
    await this.store.append(request, {
      type: 'evidence-verified',
      runId: request.runId,
      receiptSha256: inspected.evidence.receiptSha256,
    });
    return this.snapshot(request.taskId);
  }

  /** Explicit trusted coordinator decision; there is no caller-provided PASS.
   * Evidence is independently loaded from immutable run bindings on every call.
   * Stronger route profiles deliberately require their own closeout verifier.
   */
  async accept(
    request: TaskRunCommand & { readonly reason: string },
  ): Promise<TaskSnapshot> {
    const task = await this.requireTask(request.taskId);
    assert.equal(
      task.currentRunId,
      request.runId,
      'Acceptance requires current run.',
    );
    const run = boundRun(task, request.runId);
    closeoutEligibility(run);
    if (run.nativeRef) {
      const native = await getExecutionHarnessStatus(
        this.requireSelection(),
        run.nativeRef,
      );
      assert.equal(
        native.status,
        'SUCCEEDED',
        'Native execution has not succeeded.',
      );
      assert.equal(
        run.nativeSnapshot?.status,
        'SUCCEEDED',
        'Observe the successful exact run before accepting.',
      );
    }
    const inspected = await this.inspectRun(run);
    assert(inspected.evidence.verified, inspected.evidence.issues.join('; '));
    assert.equal(inspected.issues.length, 0, inspected.issues.join('; '));
    assert(
      !inspected.children.some((c) => c.status !== 'SUCCEEDED'),
      'Every bound child must succeed before acceptance.',
    );
    assert(inspected.evidence.receiptSha256);
    await this.store.append(request, {
      type: 'task-accepted',
      runId: request.runId,
      receiptSha256: inspected.evidence.receiptSha256,
      reason: request.reason,
    });
    return this.snapshot(request.taskId);
  }

  private async inspectRun(run: TaskRun): Promise<TaskRunSnapshot> {
    let evidence: TaskEvidenceSnapshot = {
      verified: false,
      scope: null,
      receiptSha256: null,
      issues: ['Canonical receipt is missing.'],
    };
    let receiptStatus: string | null = null;
    let stages: TaskRunSnapshot['stages'] = [];
    const issues: string[] = [];
    const children: ChildTaskRecord[] = [];
    try {
      if (!run.receiptRoot || !run.evidenceRoot)
        throw new Error(
          'Canonical receipt and evidence locations have not been attached.',
        );
      const store = await FileWorkflowReceiptStore.openExisting(
        run.receiptRoot,
      );
      const receipt = await store.load(run.runId);
      if (receipt) {
        assert.equal(receipt.runId, run.runId, 'Receipt run binding changed.');
        assert.equal(
          receipt.revision,
          run.revision,
          'Receipt revision is stale.',
        );
        assert.equal(
          taskDigest(receipt.plan),
          run.planSha256,
          'Receipt plan does not match the bound plan.',
        );
        receiptStatus = receipt.status;
        stages = receipt.stages.map(({ stage, status, summary }) => ({
          stage,
          status,
          summary,
        }));
        const receiptSha256 = taskDigest(receipt);
        try {
          const evidenceStore = await FileEvidenceStore.openExisting(
            run.evidenceRoot,
          );
          await verifyStageEvidenceRecord(
            receipt,
            run.runId,
            run.revision,
            evidenceStore,
            true,
          );
          assert.equal(
            taskDigest(await store.load(run.runId)),
            receiptSha256,
            'Receipt changed during evidence verification.',
          );
          evidence = {
            verified: true,
            scope: 'persisted-stage-evidence-only',
            receiptSha256,
            issues: [],
          };
        } catch (error) {
          evidence = {
            verified: false,
            scope: null,
            receiptSha256,
            issues: [errorMessage(error)],
          };
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      evidence = {
        verified: false,
        scope: null,
        receiptSha256: null,
        issues: [message],
      };
      if (run.receiptRoot && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        issues.push(message);
    }
    for (const ref of run.childRefs ?? []) {
      try {
        // Existing store loading reconciles its own journal; task continuity
        // retains the same child identities without copying their lifecycle.
        assert(
          (await lstat(ref.storeRoot)).isDirectory(),
          'Bound child store is missing.',
        );
        const childStore = await FileChildTaskStore.create(ref.storeRoot);
        const group = await childStore.loadGroup(ref.groupId);
        assert(group, 'Bound child group is missing.');
        assert.equal(group.runId, run.runId, 'Child group run mismatch.');
        assert.equal(
          group.revision,
          run.revision,
          'Child group revision mismatch.',
        );
        assert(
          group.taskIds.length + children.length <= 1024,
          'Bound child groups exceed projection limit.',
        );
        for (const taskId of group.taskIds) {
          const child = await childStore.load(taskId);
          assert(child, `Bound child ${taskId} is missing.`);
          assert.equal(child.runId, run.runId, 'Child run mismatch.');
          assert.equal(
            child.revision,
            run.revision,
            'Child revision mismatch.',
          );
          children.push(child);
        }
      } catch (error) {
        issues.push(errorMessage(error));
      }
    }
    if (run.executionStoreRoot) {
      try {
        assert(
          (await lstat(run.executionStoreRoot)).isDirectory(),
          'Execution store is missing.',
        );
        const store = await FileChildTaskStore.create(run.executionStoreRoot);
        for (const child of await store.executionRecords(run.runId)) {
          assert.equal(
            child.revision,
            run.revision,
            'Execution revision mismatch.',
          );
          if (!children.some((existing) => existing.taskId === child.taskId))
            children.push(child);
          if (child.execution && child.execution.state !== 'CLEANED')
            issues.push(`Execution cleanup unresolved: ${child.taskId}`);
        }
      } catch (error) {
        issues.push(errorMessage(error));
      }
    }
    return {
      runId: run.runId,
      revision: run.revision,
      receiptStatus,
      stages,
      evidence,
      children,
      issues,
    };
  }
  private requireSelection(): HarnessSelection {
    assert(
      this.selection,
      'A selected execution harness is required for native actions.',
    );
    return this.selection;
  }
  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.load(taskId);
    assert(task, `Task ${taskId} does not exist.`);
    return task;
  }
  private async finish(
    request: TaskRunCommand,
    suffix: string,
    change: TaskChange,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const task = await this.requireTask(request.taskId);
      try {
        await this.store.append(
          {
            ...request,
            expectedVersion: task.version,
            idempotencyKey: `runtime:${taskDigest([request.idempotencyKey, suffix])}`,
          },
          change,
        );
        return;
      } catch (error) {
        if (
          !errorMessage(error).includes('Task version conflict') ||
          attempt === 7
        )
          throw error;
      }
    }
  }
  private async uncertain(
    request: TaskRunCommand,
    error: unknown,
  ): Promise<void> {
    await this.finish(request, 'uncertain', {
      type: 'operation-uncertain',
      runId: request.runId,
      operationId: request.idempotencyKey,
      reason: errorMessage(error),
    });
  }
}
