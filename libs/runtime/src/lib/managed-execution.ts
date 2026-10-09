import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OwnedCommand,
  OwnedExecutionAdapter,
  OwnedExecutionOutcome,
} from '@temari/contracts';
import type {
  ChildTaskRecord,
  ChildTaskStore,
  ChildExecutionRecord,
} from './child-task-store.js';

export class ManagedExecutionFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OwnedExecutionOutcome,
  ) {
    super(message);
  }
}

/** No scheduler or second store: the existing child store fences one stage and
 * each adapter group. Lease renewal requires fresh independent supervision. */
export class ManagedExecutionControl {
  readonly controller = new AbortController();
  private authority!: ChildTaskRecord;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private stopped?: Promise<void>;
  private active = new Map<string, ChildTaskRecord>();
  private sequence = 0;
  private get owner(): string {
    return `managed:${createHash('sha256').update(this.options.binding).digest('hex')}`;
  }
  constructor(
    readonly options: {
      store: ChildTaskStore;
      adapter: OwnedExecutionAdapter;
      runId: string;
      revision: string;
      binding: string;
      root: string;
      authorityId: string;
      processIds: readonly string[];
      observeSupervisor: () => Promise<boolean>;
      signal?: AbortSignal;
      intervalMs?: number;
    },
  ) {}
  private abort = (): void => {
    void this.stop('external cancellation').catch(() => {});
  };
  async start(): Promise<void> {
    const o = this.options;
    assert(
      o.store.updateExecution,
      'Child store lacks durable execution ownership.',
    );
    assert(!o.signal?.aborted, 'Managed stage cancelled before admission.');
    await this.checkSupervisor();
    for (const taskId of [o.authorityId, ...o.processIds])
      await o.store.create({
        taskId,
        runId: o.runId,
        revision: o.revision,
        dependsOn: [],
        actor: this.owner,
      });
    await o.store.ensureGroup({
      groupId: o.authorityId,
      runId: o.runId,
      revision: o.revision,
      taskIds: [o.authorityId, ...o.processIds],
      assignmentIds: [o.authorityId, ...o.processIds],
    });
    // Any old attempt (including terminal) is reconciliation-only, never relaunch.
    const old = await o.store.load(o.authorityId);
    assert.equal(
      old?.attempt,
      0,
      'Uncertain stage dispatch: prior managed authority exists; reconcile cleanup before replacement/replay.',
    );
    const claimed = await o.store.claim({
      taskId: o.authorityId,
      owner: this.owner,
      leaseMs: 15000,
    });
    assert(claimed.claimed, 'Managed authority is already owned.');
    this.authority = claimed.record;
    o.signal?.addEventListener('abort', this.abort, { once: true });
    if (o.signal?.aborted) this.abort();
    this.timer = setInterval(() => {
      if (this.polling || this.controller.signal.aborted) return;
      this.polling = this.poll()
        .catch((error) => {
          this.controller.abort(error);
        })
        .finally(() => {
          this.polling = undefined;
        });
    }, o.intervalMs ?? 1000);
  }
  private async checkSupervisor(): Promise<void> {
    const alive = await Promise.race([
      this.options.observeSupervisor(),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3500);
        timer.unref();
      }),
    ]);
    assert(
      alive,
      'Native supervision lost or terminal; execution authority revoked.',
    );
  }
  async assertActive(): Promise<void> {
    assert(
      !this.controller.signal.aborted && !this.options.signal?.aborted,
      'Managed execution cancelled.',
    );
    try {
      await this.checkSupervisor();
      const record = await this.options.store.load(this.options.authorityId);
      assert(
        record?.lease?.token === this.authority.lease?.token &&
          record?.status === 'RUNNING',
      );
      assert(
        Date.parse(record.lease!.expiresAt) > Date.now(),
        'Managed authority lease expired.',
      );
      assert(
        !(await this.options.store.cancellationRequested(
          this.options.authorityId,
        )),
        'Managed authority cancelled.',
      );
      assert(
        !this.controller.signal.aborted,
        'Managed execution cancelled during supervision readback.',
      );
    } catch (error) {
      await this.stop(String(error));
      throw error;
    }
  }
  private async poll(): Promise<void> {
    try {
      await this.assertActive();
      for (const record of [this.authority, ...this.active.values()]) {
        assert(
          !(await this.options.store.cancellationRequested(record.taskId)),
          'Child cancellation requested.',
        );
        try {
          await this.options.store.renew({
            taskId: record.taskId,
            owner: this.owner,
            leaseToken: record.lease!.token,
            fencingEpoch: record.lease!.fencingEpoch,
            leaseMs: 15000,
            idempotencyKey: `supervision:${++this.sequence}:${record.taskId}`,
          });
        } catch (error) {
          const settled = await this.options.store.load(record.taskId);
          if (
            record.taskId === this.options.authorityId ||
            settled?.status !== 'SUCCEEDED' ||
            settled.execution?.state !== 'CLEANED'
          )
            throw error;
        }
      }
    } catch (error) {
      await this.stop(String(error));
    }
  }
  async stop(reason: string): Promise<void> {
    if (this.stopped) return this.stopped;
    if (this.timer) clearInterval(this.timer);
    this.stopped = (async () => {
      await Promise.resolve(); // publish the shared stop promise before abort listeners reenter
      for (const taskId of [
        this.options.authorityId,
        ...this.options.processIds,
      ]) {
        const record = await this.options.store.load(taskId);
        if (record && ['QUEUED', 'RUNNING'].includes(record.status))
          await this.options.store.cancel({
            taskId,
            actor: this.owner,
            idempotencyKey: `managed-stop:${taskId}`,
          });
      }
    })();
    this.controller.abort(reason); // revoke dispatch immediately, before store I/O
    return this.stopped;
  }
  async run(
    taskId: string,
    command: OwnedCommand,
    upstream?: {
      readonly taskId: string;
      readonly runId: string;
      readonly attempt: number;
      readonly fencingEpoch: number;
    },
  ): Promise<OwnedExecutionOutcome> {
    assert(
      this.options.processIds.includes(taskId),
      'Unregistered process scope.',
    );
    await this.assertActive();
    const claim = await this.options.store.claim({
      taskId,
      owner: this.owner,
      leaseMs: 15000,
    });
    assert(
      claim.claimed && claim.record.attempt === 1,
      'Process attempt exists; replay refused.',
    );
    const record = claim.record;
    this.active.set(taskId, record);
    let execution: ChildExecutionRecord = {
      nonce: randomUUID(),
      binding: JSON.stringify({
        invocation: this.options.binding,
        taskId,
        attempt: record.attempt,
        fencingEpoch: record.lease!.fencingEpoch,
        upstream,
      }),
      attempt: record.attempt,
      fencingEpoch: record.lease!.fencingEpoch,
      state: 'PREPARED',
      receiptPath: join(this.options.root, `${taskId}.cleanup.json`),
      guardianPid: null,
      anchorPid: null,
    };
    const update = async (next: ChildExecutionRecord) => {
      await this.options.store.updateExecution!({
        taskId,
        actor: this.owner,
        leaseToken: record.lease!.token,
        execution: next,
      });
      execution = next;
    };
    await update(execution);
    try {
      const result = await this.options.adapter.launch(
        command,
        {
          nonce: execution.nonce,
          binding: execution.binding,
          receiptPath: execution.receiptPath,
        },
        this.controller.signal,
        async (witness) => {
          await this.assertActive();
          await update({ ...execution, ...witness, state: 'LIVE' });
          await this.assertActive();
        },
      );
      await update({
        ...execution,
        ...result.witness,
        state: result.cleanup === 'CONFIRMED' ? 'CLEANED' : 'UNCERTAIN',
      });
      assert.equal(
        result.cleanup,
        'CONFIRMED',
        'Owned group cleanup unresolved; replacement refused.',
      );
      await this.assertActive();
      assert.equal(
        result.reason,
        'normal-exit',
        `Owned process stopped: ${result.reason}`,
      );
      if (result.code !== 0)
        throw new ManagedExecutionFailure('Owned process failed.', result);
      await this.options.store.complete({
        taskId,
        owner: this.owner,
        leaseToken: record.lease!.token,
        fencingEpoch: record.lease!.fencingEpoch,
        status: 'SUCCEEDED',
        idempotencyKey: `managed-complete:${execution.nonce}`,
        result: {
          status: 'PASS',
          summary: 'Owned command exited and group cleanup confirmed.',
          evidencePaths: [execution.receiptPath],
          rawLogPath: null,
        },
      });
      return result;
    } catch (error) {
      // A lost adapter reply is not absence proof. Only its exact receipt can resolve it.
      const recovered = await this.options.adapter
        .recover({
          nonce: execution.nonce,
          binding: execution.binding,
          receiptPath: execution.receiptPath,
        })
        .catch(() => null);
      if (execution.state !== 'CLEANED')
        await update({
          ...execution,
          ...(recovered?.witness ?? {}),
          state: recovered?.cleanup === 'CONFIRMED' ? 'CLEANED' : 'UNCERTAIN',
        });
      await this.stop(String(error));
      if (execution.state === 'CLEANED') {
        await this.options.store
          .complete({
            taskId,
            owner: this.owner,
            leaseToken: record.lease!.token,
            fencingEpoch: record.lease!.fencingEpoch,
            status: 'CANCELLED',
            idempotencyKey: `managed-cancelled:${execution.nonce}`,
          })
          .catch(() => {});
      }
      throw error;
    } finally {
      this.active.delete(taskId);
    }
  }
  async finish(): Promise<void> {
    try {
      await this.assertActive();
      this.dispose();
      if (this.polling) await this.polling;
      assert(
        !this.controller.signal.aborted,
        'Authority lost during final lease drain.',
      );
      assert(this.active.size === 0, 'Owned work is still active.');
      const proofPath = join(
        this.options.root,
        `${this.authority.taskId}.authority.json`,
      );
      const children = await Promise.all(
        this.options.processIds.map((id) => this.options.store.load(id)),
      );
      assert(
        children.every(
          (child) =>
            child?.status === 'SUCCEEDED' &&
            child.execution?.state === 'CLEANED',
        ),
      );
      await writeFile(
        proofPath,
        JSON.stringify({ binding: this.options.binding, children }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      await this.assertActive();
      await this.options.store.complete({
        taskId: this.authority.taskId,
        owner: this.owner,
        leaseToken: this.authority.lease!.token,
        fencingEpoch: this.authority.lease!.fencingEpoch,
        status: 'SUCCEEDED',
        idempotencyKey: `managed-stage-finished:${this.authority.taskId}`,
        result: {
          status: 'PASS',
          summary: 'Managed stage work and cleanup finished.',
          evidencePaths: [proofPath],
          rawLogPath: null,
        },
      });
    } finally {
      this.dispose();
    }
  }
  async drain(): Promise<void> {
    this.dispose();
    if (this.stopped) await this.stopped;
    if (this.polling) await this.polling;
    if (this.stopped && this.active.size === 0) {
      const records = await Promise.all(
        this.options.processIds.map((id) => this.options.store.load(id)),
      );
      if (
        records.every(
          (record) =>
            record &&
            (!record.execution || record.execution.state === 'CLEANED'),
        )
      ) {
        const authority = await this.options.store.load(
          this.options.authorityId,
        );
        if (authority?.status === 'RUNNING' && authority.lease) {
          await this.options.store
            .complete({
              taskId: authority.taskId,
              owner: authority.lease.owner,
              leaseToken: authority.lease.token,
              fencingEpoch: authority.lease.fencingEpoch,
              status: 'CANCELLED',
              idempotencyKey: `managed-stop-confirmed:${authority.taskId}`,
            })
            .catch(() => {});
        }
      }
    }
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.options.signal?.removeEventListener('abort', this.abort);
  }
}

/** Recovery imports cleanup evidence; never a PID control. Pending/uncertain
 * launch remains fenced even after lease expiry or native semantic terminal. */
export async function recoverManagedExecution(
  store: ChildTaskStore,
  adapter: OwnedExecutionAdapter,
  taskId: string,
): Promise<'CONFIRMED' | 'UNCERTAIN'> {
  const record = await store.load(taskId);
  assert(record?.execution);
  const e = record.execution;
  const receipt = await adapter.recover({
    nonce: e.nonce,
    binding: e.binding,
    receiptPath: e.receiptPath,
  });
  if (!receipt || receipt.cleanup !== 'CONFIRMED') {
    await store.updateExecution!({
      taskId,
      actor: 'managed-recovery',
      execution: { ...e, state: 'UNCERTAIN' },
    });
    return 'UNCERTAIN';
  }
  assert(
    !e.anchorPid || e.anchorPid === receipt.witness.anchorPid,
    'Recovered anchor identity changed.',
  );
  assert(
    !e.guardianPid || e.guardianPid === receipt.witness.guardianPid,
    'Recovered guardian identity changed.',
  );
  if (record.status === 'RUNNING')
    await store.cancel({
      taskId,
      actor: 'managed-recovery',
      idempotencyKey: `recovery-cancel:${e.nonce}`,
    });
  await store.updateExecution!({
    taskId,
    actor: 'managed-recovery',
    execution: { ...e, ...receipt.witness, state: 'CLEANED' },
  });
  const current = await store.load(taskId);
  if (current?.status === 'RUNNING' && current.lease)
    await store
      .complete({
        taskId,
        owner: current.lease.owner,
        leaseToken: current.lease.token,
        fencingEpoch: current.lease.fencingEpoch,
        status: 'CANCELLED',
        idempotencyKey: `recovery-complete:${e.nonce}`,
      })
      .catch(() => {});
  return 'CONFIRMED';
}

/** Coordinator recovery of an exact retained group after controller loss.
 * All cleanup proofs must resolve before the non-process stage authority settles. */
export async function recoverManagedExecutionGroup(
  store: ChildTaskStore,
  adapter: OwnedExecutionAdapter,
  groupId: string,
): Promise<'CONFIRMED' | 'UNCERTAIN'> {
  const group = await store.loadGroup(groupId);
  assert(group, 'Managed group missing.');
  for (const taskId of group.taskIds) {
    const record = await store.load(taskId);
    assert(record, 'Managed child missing.');
    assert.equal(record.runId, group.runId);
    assert.equal(record.revision, group.revision);
    if (
      record.execution &&
      (await recoverManagedExecution(store, adapter, taskId)) !== 'CONFIRMED'
    )
      return 'UNCERTAIN';
  }
  for (const taskId of group.taskIds) {
    const record = await store.load(taskId);
    if (record && ['RUNNING', 'QUEUED'].includes(record.status)) {
      const stopped = await store.cancel({
        taskId,
        actor: 'managed-recovery',
        idempotencyKey: `managed-recovery:${groupId}:${taskId}`,
      });
      if (stopped.status === 'RUNNING' && stopped.lease)
        await store
          .complete({
            taskId,
            owner: stopped.lease.owner,
            leaseToken: stopped.lease.token,
            fencingEpoch: stopped.lease.fencingEpoch,
            status: 'CANCELLED',
            idempotencyKey: `managed-recovered:${groupId}:${taskId}`,
          })
          .catch(() => {});
      assert(
        !['RUNNING', 'QUEUED'].includes((await store.load(taskId))!.status),
        'Recovery authority remains unresolved.',
      );
    }
  }
  return 'CONFIRMED';
}
