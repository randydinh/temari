import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';

import type {
  ExecutionHarness,
  HarnessRunRef,
  HarnessRunRequest,
  HarnessRunSnapshot,
} from '@temari/contracts';
import { DEFAULT_STAGES } from '@temari/contracts';
import type { ManagedArchonRuntime } from './managed-runtime.js';

const EXPECTED_VERSION = '0.10.1';
const EXPECTED_COMMIT = '9820785c';
const TEMARI_BINDING_INPUT = 'temari_binding';

export interface ArchonCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ArchonCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<ArchonCommandResult>;
}

export interface ArchonHarnessOptions {
  readonly runtime: ManagedArchonRuntime;
  readonly workflowSource?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly commandRunner?: ArchonCommandRunner;
  readonly timeoutMs?: number;
}

export interface CanonicalArchonPaths {
  readonly specPath: string;
  readonly bridgePath: string;
  readonly finalizerPath: string;
}

function defaultRunner(): ArchonCommandRunner {
  return {
    run(executable, args, cwd, environment, timeoutMs) {
      return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], {
          cwd,
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nativeBinding(reference: Omit<HarnessRunRef, 'externalRunId' | 'startedAt'>): Record<string, unknown> {
  return {
    schema: reference.schema,
    harnessId: reference.harnessId,
    harnessVersion: reference.harnessVersion,
    runId: reference.runId,
    revision: reference.revision,
    planSha256: reference.planSha256,
    workspaceRoot: reference.workspaceRoot,
    entrypoint: reference.entrypoint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) &&
    !value.includes('..')
  );
}

function requireSafeToken(value: string, label: string): void {
  if (!isSafeToken(value)) {
    throw new Error(`${label} must be a safe, non-empty identifier.`);
  }
}

function parseJson(output: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid object.`);
  }
  return value as Record<string, unknown>;
}

function mapStatus(value: unknown): HarnessRunSnapshot['status'] {
  switch (String(value).toLowerCase()) {
    case 'queued':
    case 'pending':
      return 'QUEUED';
    case 'running':
    case 'in_progress':
      return 'RUNNING';
    case 'completed':
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
    case 'error':
      return 'FAILED';
    case 'blocked':
      return 'BLOCKED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

async function windowsBashPath(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const joinPath = win32.join;
  const candidates = [
    environment.ARCHON_BASH_PATH,
    environment.ProgramFiles
      ? joinPath(environment.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : undefined,
    environment['ProgramFiles(x86)']
      ? joinPath(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return await realpath(candidate);
    } catch {
      // Check only known Git for Windows locations; do not trust PATH's bash.exe.
    }
  }
  throw new Error(
    'Archon workflows with bash nodes on Windows require Git for Windows; set ARCHON_BASH_PATH to its bash.exe.',
  );
}

function assertReference(
  reference: HarnessRunRef,
  runtime: ManagedArchonRuntime,
): void {
  if (
    reference.schema !== 1 ||
    reference.harnessId !== 'archon' ||
    reference.harnessVersion !== runtime.version ||
    !isSafeToken(reference.externalRunId) ||
    !isSafeToken(reference.runId) ||
    !isSafeToken(reference.entrypoint) ||
    !isAbsolute(reference.workspaceRoot) ||
    !reference.revision ||
    !/^[a-f0-9]{64}$/.test(reference.planSha256)
  ) {
    throw new Error(
      'Harness run reference is invalid or belongs to another harness.',
    );
  }
}

/** Adapter for the pinned Archon CLI; workflow policy remains outside it. */
export class ArchonHarness implements ExecutionHarness {
  readonly id = 'archon';
  readonly version: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runner: ArchonCommandRunner;
  private readonly timeoutMs: number;

  constructor(private readonly options: ArchonHarnessOptions) {
    if (
      options.runtime.version !== EXPECTED_VERSION ||
      options.runtime.commitPrefix !== EXPECTED_COMMIT
    ) {
      throw new Error(
        `Archon harness requires v${EXPECTED_VERSION} at ${EXPECTED_COMMIT}.`,
      );
    }
    if (!isAbsolute(options.runtime.executablePath)) {
      throw new Error('Managed Archon executable path must be absolute.');
    }
    this.version = options.runtime.version;
    this.environment = { ...process.env, ...options.environment };
    this.runner = options.commandRunner ?? defaultRunner();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async execute(
    args: readonly string[],
    cwd: string,
    timeoutMs = this.timeoutMs,
  ): Promise<ArchonCommandResult> {
    const environment = { ...this.environment };
    if (process.platform === 'win32') {
      environment.ARCHON_BASH_PATH = await windowsBashPath(environment);
    }
    const result = await this.runner.run(
      this.options.runtime.executablePath,
      args,
      cwd,
      environment,
      timeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Archon ${args.slice(0, 2).join(' ')} failed with exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }

  async verifyRuntime(): Promise<void> {
    await access(this.options.runtime.executablePath, constants.F_OK);
    const result = await this.execute(
      ['version'],
      dirname(this.options.runtime.executablePath),
    );
    if (
      !new RegExp(
        `^Archon CLI v${EXPECTED_VERSION.replaceAll('.', '\\.')}$`,
        'm',
      ).test(result.stdout) ||
      !new RegExp(`^  Git commit: ${EXPECTED_COMMIT}$`, 'm').test(result.stdout)
    ) {
      throw new Error(
        'Managed Archon binary version or commit does not match its pin.',
      );
    }
  }

  async validateWorkflow(
    workspaceRoot: string,
    entrypoint: string,
  ): Promise<void> {
    requireSafeToken(entrypoint, 'Workflow entrypoint');
    await this.execute(
      ['validate', 'workflows', entrypoint, '--cwd', workspaceRoot],
      workspaceRoot,
    );
  }

  async start(request: HarnessRunRequest): Promise<HarnessRunRef> {
    requireSafeToken(request.runId, 'Temari run ID');
    requireSafeToken(request.entrypoint, 'Workflow entrypoint');
    if (!request.revision || !isAbsolute(request.workspaceRoot)) {
      throw new Error(
        'Harness request requires a revision and absolute workspace path.',
      );
    }
    if (Object.hasOwn(request.inputs, TEMARI_BINDING_INPUT)) {
      throw new Error(`Workflow input ${TEMARI_BINDING_INPUT} is reserved for Temari run identity.`);
    }
    const identity = {
      schema: 1 as const,
      harnessId: this.id,
      harnessVersion: this.version,
      runId: request.runId,
      revision: request.revision,
      planSha256: sha256(canonical(request.plan)),
      workspaceRoot: request.workspaceRoot,
      entrypoint: request.entrypoint,
    };

    const args = [
      'workflow',
      'run',
      request.entrypoint,
      '--cwd',
      request.workspaceRoot,
      ...(this.options.workflowSource
        ? ['--workflow-source', this.options.workflowSource]
        : []),
      '--no-worktree',
    ];
    for (const [key, value] of Object.entries(request.inputs)) {
      requireSafeToken(key, 'Workflow input key');
      if (typeof value !== 'string') {
        throw new Error(`Workflow input ${key} must be a string.`);
      }
      args.push('--input', `${key}=${value}`);
    }
    if (request.recovery === 'required') {
      args.push('--input', `${TEMARI_BINDING_INPUT}=${JSON.stringify(nativeBinding(identity))}`);
    }
    args.push('--detach', '--json');

    const result = await this.execute(args, request.workspaceRoot, 60_000);
    const output = parseJson(result.stdout, 'Archon workflow launch');
    if (!isSafeToken(output.runId)) {
      throw new Error(
        'Archon workflow launch did not return a safe native run ID.',
      );
    }
    return {
      ...identity,
      externalRunId: output.runId,
      startedAt: new Date().toISOString(),
    };
  }

  /** Start the installed, model-free six-stage conformance workflow. */
  async startCanonical(
    request: Omit<HarnessRunRequest, 'entrypoint' | 'inputs'>,
    paths: CanonicalArchonPaths,
  ): Promise<HarnessRunRef> {
    if (!this.options.workflowSource || !isAbsolute(this.options.workflowSource)) {
      throw new Error('Canonical workflow requires an absolute installed workflow source.');
    }
    await access(join(this.options.workflowSource, '.archon', 'workflows', 'temari-nx-canonical.yaml'));
    for (const path of [paths.specPath, paths.bridgePath, paths.finalizerPath]) {
      if (!isAbsolute(path)) throw new Error('Canonical workflow paths must be absolute.');
      await access(path);
    }
    const spec = JSON.parse(await readFile(paths.specPath, 'utf8')) as {
      runId?: unknown;
      revision?: unknown;
      repositoryRoot?: unknown;
      plan?: { stages?: unknown };
    };
    if (
      spec.runId !== request.runId ||
      spec.revision !== request.revision ||
      typeof spec.repositoryRoot !== 'string' ||
      !isAbsolute(spec.repositoryRoot) ||
      (await realpath(spec.repositoryRoot)) !== (await realpath(request.workspaceRoot)) ||
      !Array.isArray(spec.plan?.stages) ||
      JSON.stringify(spec.plan.stages) !== JSON.stringify(DEFAULT_STAGES) ||
      sha256(canonical(spec.plan)) !== sha256(canonical(request.plan))
    ) {
      throw new Error('Canonical spec does not match the frozen Temari request.');
    }
    return this.start({
      ...request,
      entrypoint: 'temari-nx-canonical',
      inputs: {
        bridge: paths.bridgePath,
        finalizer: paths.finalizerPath,
        spec: paths.specPath,
      },
    });
  }

  async status(reference: HarnessRunRef): Promise<HarnessRunSnapshot> {
    assertReference(reference, this.options.runtime);
    const result = await this.execute(
      ['workflow', 'get', reference.externalRunId, '--json'],
      reference.workspaceRoot,
    );
    const output = parseJson(result.stdout, 'Archon workflow status');
    if (output.id !== reference.externalRunId) {
      throw new Error('Archon returned a different native run ID.');
    }
    const status = mapStatus(output.status);
    const summary =
      typeof output.error === 'string'
        ? output.error
        : `Archon workflow status: ${String(output.status ?? 'unknown')}`;
    const rawLogPath =
      typeof output.log_path === 'string' ? output.log_path : null;
    return {
      status,
      observedAt: new Date().toISOString(),
      summary,
      rawLogPath,
      ...(isSafeToken(output.codebase_id) && !output.codebase_id.includes('/')
        ? { nativeProjectId: output.codebase_id }
        : {}),
    };
  }

  async verifyRunIdentity(reference: HarnessRunRef): Promise<void> {
    assertReference(reference, this.options.runtime);
    const result = await this.execute(
      ['workflow', 'get', reference.externalRunId, '--json'],
      reference.workspaceRoot,
    );
    const output = parseJson(result.stdout, 'Archon workflow identity');
    if (output.id !== reference.externalRunId) {
      throw new Error('Archon returned a different native run ID.');
    }
    const metadata = output.metadata;
    const inputs = isRecord(metadata) ? metadata.inputs : undefined;
    const rawBinding = isRecord(inputs) ? inputs[TEMARI_BINDING_INPUT] : undefined;
    if (typeof rawBinding !== 'string') {
      throw new Error('Archon native run has no retained Temari identity binding; recovery is unavailable.');
    }
    const binding = parseJson(rawBinding, 'Archon retained Temari identity');
    if (
      canonical(binding) !== canonical(nativeBinding(reference)) ||
      output.workflow_name !== reference.entrypoint ||
      typeof output.working_path !== 'string' ||
      !isAbsolute(output.working_path) ||
      (await realpath(output.working_path)) !== (await realpath(reference.workspaceRoot))
    ) {
      throw new Error('Archon native run identity does not match the Temari run, plan, workflow, or workspace.');
    }
  }

  async resume(reference: HarnessRunRef): Promise<HarnessRunSnapshot> {
    assertReference(reference, this.options.runtime);
    await this.execute(
      [
        'workflow',
        'resume',
        reference.externalRunId,
        '--cwd',
        reference.workspaceRoot,
        '--detach',
        '--json',
      ],
      reference.workspaceRoot,
      60_000,
    );
    return this.status(reference);
  }

  async cancel(reference: HarnessRunRef): Promise<HarnessRunSnapshot> {
    assertReference(reference, this.options.runtime);
    if (reference.externalRunId.toLowerCase() === 'latest') {
      throw new Error('Cancellation requires an exact native run ID.');
    }
    await this.execute(
      ['workflow', 'cancel', reference.externalRunId, '--json'],
      reference.workspaceRoot,
    );
    return this.status(reference);
  }
}
