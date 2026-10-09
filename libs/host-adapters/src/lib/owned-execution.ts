import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  OwnedExecutionAdapter,
  OwnedExecutionIdentity,
  OwnedExecutionOutcome,
} from '@temari/contracts';

// An in-process capability supplied only by the guarded operation entry.
const groupScope = new AsyncLocalStorage<boolean>();
export const inOwnedProcessGroup = (): boolean =>
  groupScope.getStore() === true;
export const withOwnedProcessGroup = <T>(handler: () => T): T =>
  groupScope.run(true, handler);

function validate(
  value: OwnedExecutionOutcome,
  identity: OwnedExecutionIdentity,
): OwnedExecutionOutcome {
  assert.deepEqual(
    value.identity,
    identity,
    'Cleanup receipt belongs to another invocation.',
  );
  assert(['CONFIRMED', 'UNCERTAIN'].includes(value.cleanup));
  assert(
    Number.isSafeInteger(value.witness?.guardianPid) &&
      value.witness.guardianPid > 1,
  );
  assert(
    Number.isSafeInteger(value.witness?.anchorPid) &&
      value.witness.anchorPid > 1,
  );
  return value;
}
export function createOwnedExecutionAdapter(): OwnedExecutionAdapter {
  return {
    async recover(identity) {
      try {
        assert(
          (await lstat(identity.receiptPath)).isFile(),
          'Cleanup receipt must be a regular file.',
        );
        return {
          ...validate(
            JSON.parse(await readFile(identity.receiptPath, 'utf8')),
            identity,
          ),
          stdout: '',
          stderr: '',
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async launch(command, identity, signal, register) {
      assert(
        process.platform !== 'win32',
        'Managed group cleanup requires a POSIX host; Windows is not admitted.',
      );
      assert(!signal.aborted, 'Execution cancelled before prepare.');
      const guardian = fork(
        fileURLToPath(new URL('./owned-process/guardian.mjs', import.meta.url)),
        [],
        {
          detached: true,
          execArgv: [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let stdout = '',
        stderr = '',
        size = 0;
      const limit = command.outputLimitBytes ?? 4 * 1024 * 1024;
      const cancel = (reason = 'cancelled') => {
        if (guardian.connected) {
          try {
            guardian.send({ type: 'cancel', reason }, () => {});
          } catch {}
        }
      };
      const abort = () => cancel();
      signal.addEventListener('abort', abort, { once: true });
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (
          error: Error | null,
          receipt?: OwnedExecutionOutcome,
        ) => {
          if (finished) return;
          finished = true;
          clearTimeout(bound);
          signal.removeEventListener('abort', abort);
          if (guardian.connected) guardian.disconnect();
          if (error) reject(error);
          else resolve({ ...validate(receipt!, identity), stdout, stderr });
        };
        const bound = setTimeout(() => {
          cancel('adapter-deadline');
          finish(new Error('Owned cleanup did not settle; recovery required.'));
        }, command.timeoutMs + 10000);
        const collect = (which: 'stdout' | 'stderr', chunk: Buffer) => {
          size += chunk.length;
          if (size <= limit) {
            if (which === 'stdout') stdout += chunk.toString();
            else stderr += chunk.toString();
          } else cancel('output-limit');
        };
        guardian.stdout!.on('data', (chunk) => collect('stdout', chunk));
        guardian.stderr!.on('data', (chunk) => collect('stderr', chunk));
        guardian.on('error', (error) => finish(error));
        guardian.on('exit', () => {
          if (!finished)
            finish(
              new Error('Guardian lost; cleanup evidence must be recovered.'),
            );
        });
        guardian.on('message', async (message: unknown) => {
          const msg = message as {
            type: string;
            witness: OwnedExecutionOutcome['witness'];
            receipt: OwnedExecutionOutcome;
          };
          if (msg.type === 'prepared') {
            try {
              await register(msg.witness);
              if (signal.aborted) cancel();
              else if (guardian.connected) guardian.send({ type: 'go' });
            } catch {
              cancel('registration-refused');
            }
          } else if (msg.type === 'finished') finish(null, msg.receipt);
        });
        guardian.send({ type: 'prepare', command, identity });
        if (signal.aborted) abort();
      });
    },
  };
}
