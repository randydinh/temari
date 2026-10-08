import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

/** Read-only observer for the retained exact native run. No recovery/adoption of
 * latest, and no status-only identity assertion. Runtime decides revocation. */
export async function createManagedArchonSupervisor(options: {
  executable: string;
  executableSha256: string;
  home: string;
  nativeRunId: string;
  runId: string;
  revision: string;
  planSha256: string;
  requestSha256: string;
  workspaceRoot: string;
}): Promise<() => Promise<boolean>> {
  assert(isAbsolute(options.home) && isAbsolute(options.executable));
  assert.match(options.nativeRunId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  assert.notEqual(options.nativeRunId.toLowerCase(), 'latest');
  assert.equal(
    createHash('sha256')
      .update(await readFile(options.executable))
      .digest('hex'),
    options.executableSha256,
  );
  const originalParent = process.ppid;
  assert(originalParent > 1, 'Managed bridge already lost its native parent.');
  return async () => {
    if (process.ppid !== originalParent) return false;
    try {
      const response = await promisify(execFile)(
        options.executable,
        ['workflow', 'get', options.nativeRunId, '--json'],
        {
          cwd: options.workspaceRoot,
          env: { ...process.env, ARCHON_HOME: options.home },
          timeout: 2000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
      );
      const record = JSON.parse(response.stdout);
      const inputs = record.metadata?.inputs;
      const bound = JSON.parse(inputs?.temari_binding);
      return (
        process.ppid === originalParent &&
        record.id === options.nativeRunId &&
        ['running', 'in_progress'].includes(
          String(record.status).toLowerCase(),
        ) &&
        record.workflow_name === 'temari-reviewed-local-candidate' &&
        (await realpath(record.working_path)) === options.workspaceRoot &&
        bound.schema === 1 &&
        bound.harnessId === 'archon' &&
        bound.harnessVersion === '0.10.1' &&
        bound.workspaceRoot === options.workspaceRoot &&
        bound.runId === options.runId &&
        bound.revision === options.revision &&
        bound.planSha256 === options.planSha256 &&
        bound.entrypoint === 'temari-reviewed-local-candidate' &&
        inputs.request_sha256 === options.requestSha256 &&
        inputs.native_home === options.home &&
        inputs.native_executable === options.executable &&
        inputs.native_executable_sha256 === options.executableSha256
      );
    } catch {
      return false;
    }
  };
}
