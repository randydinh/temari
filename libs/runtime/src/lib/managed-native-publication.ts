import assert from 'node:assert/strict';
import type { HarnessRunRef } from '@temari/contracts';
import type { FileTaskStore, TaskRecord, TaskRun } from './task-store.js';

export const MANAGED_NATIVE_PUBLICATION_WAIT_MS = 10000;
const POLL_MS = 100;

/** Initial native execution can precede publication by its dispatch caller.
 * Wait only for the existing matching pending dispatch, without creating child
 * authority or inventing a reference. The returned live observer never waits
 * for later missing/changed references. Runtime owns this mechanical handshake;
 * the adapter's independently selected native observer still proves native state. */
export async function createManagedTaskSupervisor(options: {
  readonly tasks: Pick<FileTaskStore, 'load'>;
  readonly taskId: string;
  readonly executionStoreRoot: string;
  readonly reference: Omit<HarnessRunRef, 'startedAt'>;
  readonly observeNative: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly allowInitialPublication: boolean;
  /** Trusted host/test bound, never read from a managed request. */
  readonly publicationWaitMs?: number;
}): Promise<() => Promise<boolean>> {
  const waitMs =
    options.publicationWaitMs ?? MANAGED_NATIVE_PUBLICATION_WAIT_MS;
  assert(
    Number.isSafeInteger(waitMs) &&
      waitMs > 0 &&
      waitMs <= MANAGED_NATIVE_PUBLICATION_WAIT_MS,
  );
  const deadline = performance.now() + waitMs;
  let dispatchId: string | undefined;
  const reference = options.reference;
  const scope = (task: TaskRecord | null): TaskRun => {
    assert(
      task && task.currentRunId === reference.runId,
      'Managed task/run changed during native publication.',
    );
    const run = task.runs.find((item) => item.runId === reference.runId);
    assert(
      run &&
        run.revision === reference.revision &&
        run.planSha256 === reference.planSha256 &&
        run.executionStoreRoot === options.executionStoreRoot,
      'Managed run binding changed during native publication.',
    );
    assert(
      !run.operations.some(
        (op) => op.kind === 'cancel' && op.state !== 'CONFIRMED',
      ),
      'Managed task cancellation requested.',
    );
    assert(
      !run.nativeSnapshot ||
        ['QUEUED', 'RUNNING'].includes(run.nativeSnapshot.status),
      'Managed native observation is terminal or uncertain.',
    );
    return run;
  };
  const exact = (run: TaskRun): boolean =>
    !!run.nativeRef &&
    Object.entries(reference).every(
      ([key, value]) => run.nativeRef![key as keyof HarnessRunRef] === value,
    );
  const bounded = async <T>(read: () => Promise<T>): Promise<T> => {
    assert(!options.signal?.aborted, 'Native reference publication cancelled.');
    const remaining = deadline - performance.now();
    assert(
      remaining > 0,
      'Native reference publication deadline expired; no useful work admitted.',
    );
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Native reference publication deadline expired; no useful work admitted.',
                ),
              ),
            remaining,
          );
          abort = () =>
            reject(new Error('Native reference publication cancelled.'));
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer!);
      options.signal?.removeEventListener('abort', abort!);
    }
  };
  const observe = async (): Promise<boolean> => {
    try {
      if (options.signal?.aborted) return false;
      const run = scope(await options.tasks.load(options.taskId));
      if (!exact(run)) return false;
      if (
        dispatchId &&
        !run.operations.some(
          (op) =>
            op.commandId === dispatchId &&
            op.kind === 'dispatch' &&
            op.state === 'CONFIRMED',
        )
      )
        return false;
      if (!(await options.observeNative())) return false;
      // Cancellation or a changed parent binding during the native read also fences.
      return (
        !options.signal?.aborted &&
        exact(scope(await options.tasks.load(options.taskId)))
      );
    } catch {
      return false;
    }
  };
  for (;;) {
    const task = await bounded(() => options.tasks.load(options.taskId));
    const run = scope(task);
    if (run.nativeRef) {
      assert(
        exact(run),
        'Published native reference does not match the selected invocation.',
      );
      assert(
        await bounded(observe),
        'Published native supervision is not valid.',
      );
      assert(
        performance.now() <= deadline,
        'Native reference publication deadline expired.',
      );
      return observe;
    }
    assert(
      options.allowInitialPublication,
      'Exact native reference is missing after startup.',
    );
    assert(
      !task!.events.some(
        (event) =>
          event.change.type === 'native-bound' &&
          event.change.runId === reference.runId,
      ),
      'Previously bound native reference was lost.',
    );
    const pending = run.operations.filter(
      (op) => op.kind === 'dispatch' && op.state === 'PENDING',
    );
    assert(
      pending.length === 1 &&
        pending[0]!.entrypoint === reference.entrypoint &&
        pending[0]!.harnessId === reference.harnessId &&
        pending[0]!.harnessVersion === reference.harnessVersion,
      'Native publication requires the exact existing pending dispatch.',
    );
    const selected = pending[0]!.commandId;
    assert(
      !dispatchId || dispatchId === selected,
      'Pending native dispatch changed.',
    );
    dispatchId = selected;
    assert(
      await bounded(options.observeNative),
      'Native supervision ended during reference publication.',
    );
    await bounded(() => new Promise((resolve) => setTimeout(resolve, POLL_MS)));
  }
}
