import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  open,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcilePlan,
  type HostCapabilityReport,
  type WorkerAssignment,
  type WorkerResult,
} from '../libs/contracts/src/index.js';
import {
  resolveCodexExecutable,
  runProcessToFiles,
  retainProcessDiagnostic,
  runCodexExecWriteWorker,
  type CodexWriteOwnedPath,
  type CapturedStream,
  type CapturedProcessDiagnostic,
} from '../libs/host-adapters/src/index.js';
import {
  preflightParallelWorkers,
  runParallelWorkers,
  type ParallelWorkerReceipt,
} from '../libs/workflow-engine/src/index.js';
import {
  WorkerExecutionFailure,
  streamEvidenceFile,
} from '../libs/runtime/src/index.js';

export type OwnedPath = CodexWriteOwnedPath;
export interface WriteAssignment {
  readonly worker: WorkerAssignment;
  readonly owns: readonly OwnedPath[];
}
export interface CommandSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}
export interface WriteRunRequest {
  readonly runId: string;
  readonly sourceRepo: string;
  readonly baseCommit: string;
  readonly evidenceRoot: string;
  readonly maxConcurrency: number;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes?: number;
  readonly finalResponseLimitBytes?: number;
  readonly prepare?: readonly CommandSpec[];
  readonly verify: readonly CommandSpec[];
  readonly assignments: readonly WriteAssignment[];
}
export interface WorkerPatch {
  readonly assignmentId: string;
  readonly baseCommit: string;
  readonly snapshotCommit: string;
  readonly changedPaths: readonly string[];
  readonly sha256: string;
  readonly patchPath: string;
}
interface CommandResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputLimitExceeded: boolean;
}
export interface WriteRunReceipt {
  readonly schema: 1;
  readonly runId: string;
  readonly baseCommit: string;
  readonly status: 'PASS' | 'ISSUES' | 'BLOCKED';
  readonly reason: string | null;
  readonly workerReceipt: ParallelWorkerReceipt | null;
  readonly patches: readonly WorkerPatch[];
  readonly integratedCommit: string | null;
  readonly integrationPath: string;
  readonly verification: readonly {
    program: string;
    args: readonly string[];
    code: number | null;
    logPath: string;
    capture?: {
      readonly complete: boolean;
      readonly error: string | null;
      readonly stdout: CapturedStream;
      readonly stderr: CapturedStream;
      readonly diagnostics: readonly CapturedProcessDiagnostic[];
      readonly evidencePaths: readonly string[];
      readonly transcript?: CapturedProcessDiagnostic | null;
    };
  }[];
}
/** Legacy receipts carry only their combined transcript; new captures also
 * identify available raw and operational sources without parsing error prose. */
export function verificationEvidencePaths(
  receipt: WriteRunReceipt,
): readonly string[] {
  return receipt.verification.flatMap((command) => [
    ...(command.capture && 'transcript' in command.capture
      ? command.capture.transcript
        ? [command.logPath]
        : []
      : [command.logPath]),
    ...(command.capture?.evidencePaths ?? []),
  ]);
}
const gitEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  ),
  GIT_AUTHOR_NAME: 'Temari',
  GIT_AUTHOR_EMAIL: 'temari@localhost',
  GIT_COMMITTER_NAME: 'Temari',
  GIT_COMMITTER_EMAIL: 'temari@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function id(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    throw new Error(`${name} must be a safe identifier.`);
  return value;
}
function absolute(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}
function numberIn(value: unknown, name: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  )
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return value as number;
}
function repoPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git',
      )
  )
    throw new Error(`Unsafe repository path: ${String(value)}`);
  return value;
}
function overlap(a: OwnedPath, b: OwnedPath): boolean {
  const left = a.path.toLowerCase();
  const right = b.path.toLowerCase();
  return (
    left === right ||
    (a.kind === 'directory' && right.startsWith(`${left}/`)) ||
    (b.kind === 'directory' && left.startsWith(`${right}/`))
  );
}
function command(value: unknown): CommandSpec {
  const item = object(value);
  if (
    typeof item.program !== 'string' ||
    !item.program.trim() ||
    item.program.includes('\0') ||
    !Array.isArray(item.args) ||
    !item.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
  )
    throw new Error('Command must have a program and string argv.');
  return {
    program: item.program,
    args: item.args as string[],
    timeoutMs:
      item.timeoutMs === undefined
        ? undefined
        : numberIn(item.timeoutMs, 'command timeoutMs', 30 * 60 * 1000),
  };
}
function worker(value: unknown): WorkerAssignment {
  const item = object(value);
  const brief = object(item.brief);
  if (
    typeof item.id !== 'string' ||
    item.role !== 'implementer' ||
    typeof item.required !== 'boolean' ||
    typeof brief.goal !== 'string' ||
    typeof brief.context !== 'string' ||
    typeof brief.scope !== 'string' ||
    !Array.isArray(brief.acceptanceCriteria) ||
    !brief.acceptanceCriteria.every((v) => typeof v === 'string') ||
    !(
      brief.verificationCommand === null ||
      typeof brief.verificationCommand === 'string'
    ) ||
    brief.reportFormat !== 'json' ||
    !Array.isArray(brief.forbiddenActions) ||
    !brief.forbiddenActions.every((v) => typeof v === 'string')
  )
    throw new Error('Write workers require complete implementer JSON briefs.');
  return value as WorkerAssignment;
}
export function parseWriteRunRequest(value: unknown): WriteRunRequest {
  const item = object(value);
  const runId = id(item.runId, 'runId');
  const sourceRepo = absolute(item.sourceRepo, 'sourceRepo');
  const evidenceRoot = absolute(item.evidenceRoot, 'evidenceRoot');
  if (
    typeof item.baseCommit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.baseCommit)
  )
    throw new Error('baseCommit must be a full commit ID.');
  const maxConcurrency = numberIn(item.maxConcurrency, 'maxConcurrency', 16);
  const timeoutMs = numberIn(item.timeoutMs, 'timeoutMs', 30 * 60 * 1000);
  const outputLimitBytes =
    item.outputLimitBytes === undefined
      ? undefined
      : numberIn(item.outputLimitBytes, 'outputLimitBytes', 16 * 1024 * 1024);
  const finalResponseLimitBytes =
    item.finalResponseLimitBytes === undefined
      ? undefined
      : numberIn(
          item.finalResponseLimitBytes,
          'finalResponseLimitBytes',
          16 * 1024 * 1024,
        );
  if (
    outputLimitBytes !== undefined &&
    finalResponseLimitBytes !== undefined &&
    outputLimitBytes !== finalResponseLimitBytes
  )
    throw new Error('outputLimitBytes and finalResponseLimitBytes conflict.');
  if (
    typeof item.executable !== 'string' ||
    !item.executable.trim() ||
    item.executable.includes('\0')
  )
    throw new Error('executable is required.');
  if (!Array.isArray(item.verify) || item.verify.length === 0)
    throw new Error('At least one verification command is required.');
  if (item.prepare !== undefined && !Array.isArray(item.prepare))
    throw new Error('prepare must be an array.');
  if (!Array.isArray(item.assignments))
    throw new Error('assignments must be an array.');
  const assignments = item.assignments.map((raw): WriteAssignment => {
    const entry = object(raw);
    if (!Array.isArray(entry.owns) || entry.owns.length === 0)
      throw new Error(
        'Each implementer needs a nonempty typed ownership scope.',
      );
    const owns = entry.owns.map((rawScope): OwnedPath => {
      const scope = object(rawScope);
      if (scope.kind !== 'file' && scope.kind !== 'directory')
        throw new Error('Scope kind must be file or directory.');
      return { kind: scope.kind, path: repoPath(scope.path) };
    });
    return { worker: worker(entry.worker), owns };
  });
  preflightParallelWorkers(assignments.map((entry) => entry.worker));
  const scopes = assignments.flatMap((entry) =>
    entry.owns.map((owned) => ({ id: entry.worker.id, owned })),
  );
  for (let i = 0; i < scopes.length; i++)
    for (let j = i + 1; j < scopes.length; j++) {
      if (overlap(scopes[i]!.owned, scopes[j]!.owned))
        throw new Error(
          `Ownership scopes overlap: ${scopes[i]!.id} and ${scopes[j]!.id}.`,
        );
    }
  return {
    runId,
    sourceRepo,
    evidenceRoot,
    baseCommit: item.baseCommit,
    maxConcurrency,
    timeoutMs,
    executable: item.executable,
    outputLimitBytes,
    ...(finalResponseLimitBytes === undefined
      ? {}
      : { finalResponseLimitBytes }),
    prepare: (item.prepare ?? []).map(command),
    verify: item.verify.map(command),
    assignments,
  };
}
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {}
}
async function runBufferedSemanticCommand(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 120000,
  signal?: AbortSignal,
  input?: Buffer,
): Promise<CommandResult> {
  if (signal?.aborted)
    return {
      code: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('cancelled'),
      timedOut: false,
      cancelled: true,
      outputLimitExceeded: false,
    };
  const child = spawn(program, [...args], {
    cwd,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: gitEnv,
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let bytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let cancelled = false;
  const collect =
    (target: Buffer[]) =>
    (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) target.push(chunk);
      else {
        outputLimitExceeded = true;
        killGroup(child.pid);
      }
    };
  child.stdout.on('data', collect(chunks));
  child.stderr.on('data', collect(errors));
  child.on('error', (error) => errors.push(Buffer.from(error.message)));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const abort = (): void => {
    cancelled = true;
    killGroup(child.pid);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);
  const code = await new Promise<number | null>((done) =>
    child.on('close', (value) => done(value)),
  );
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  return {
    code,
    stdout: Buffer.concat(chunks),
    stderr: Buffer.concat(errors),
    timedOut,
    cancelled,
    outputLimitExceeded,
  };
}
async function checked(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  input?: Buffer,
): Promise<Buffer> {
  const result = await runBufferedSemanticCommand(
    program,
    args,
    cwd,
    timeoutMs,
    signal,
    input,
  );
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.cancelled ||
    result.outputLimitExceeded
  )
    throw new Error(
      `${program} ${args.join(' ')} failed: ${result.stderr.toString('utf8').slice(0, 500)}`,
    );
  return result.stdout;
}
async function git(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  input?: Buffer,
): Promise<Buffer> {
  return checked('git', args, cwd, 120000, signal, input);
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}
async function ensureNoSymlinkPath(root: string, path: string): Promise<void> {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    try {
      if ((await lstat(join(root, ...parts.slice(0, i)))).isSymbolicLink())
        throw new Error(`Symlink edit is forbidden: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function changedPaths(cwd: string): Promise<string[]> {
  const raw = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    cwd,
  );
  const entries = raw.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) paths.push(entries[++i]!);
  }
  return [...new Set(paths)];
}
function owned(path: string, scopes: readonly OwnedPath[]): boolean {
  return scopes.some((scope) =>
    scope.kind === 'file'
      ? path === scope.path
      : path.startsWith(`${scope.path}/`),
  );
}
async function actualTarget(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(
        existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
      );
      existing = parent;
    }
  }
}
async function preflight(request: WriteRunRequest): Promise<string> {
  const source = await realpath(request.sourceRepo);
  if (!(await stat(source)).isDirectory())
    throw new Error('sourceRepo must be a directory.');
  const topLevel = (await git(['rev-parse', '--show-toplevel'], source))
    .toString('utf8')
    .trim();
  if ((await realpath(topLevel)) !== source)
    throw new Error('sourceRepo must be the Git top-level directory.');
  const head = (await git(['rev-parse', 'HEAD'], source))
    .toString('utf8')
    .trim();
  if (head !== request.baseCommit)
    throw new Error('Source HEAD does not match baseCommit.');
  if (
    (
      await git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        source,
      )
    ).length
  )
    throw new Error('Source checkout must be clean.');
  const submodules = (await git(['ls-files', '--stage', '-z'], source))
    .toString('utf8')
    .split('\0')
    .filter((line) => line.startsWith('160000 '));
  if (submodules.length) throw new Error('Submodules are not supported.');
  for (const assignment of request.assignments)
    for (const scope of assignment.owns)
      await ensureNoSymlinkPath(source, scope.path);
  const evidence = await actualTarget(request.evidenceRoot);
  if (inside(source, evidence) || inside(evidence, source))
    throw new Error('evidenceRoot must be external to sourceRepo.');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await access(evidence, constants.W_OK | constants.X_OK);
  await resolveCodexExecutable(request.executable);
  return source;
}
async function clone(
  source: string,
  base: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await checked(
    'git',
    ['clone', '--local', '--no-hardlinks', '--no-checkout', source, path],
    dirname(path),
    120000,
    signal,
  );
  await git(['checkout', '--detach', base], path, signal);
}
async function prepare(
  path: string,
  commands: readonly CommandSpec[],
  baseCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const command of commands)
    await checked(
      command.program,
      command.args,
      path,
      command.timeoutMs,
      signal,
    );
  if (
    (await git(['rev-parse', 'HEAD'], path)).toString('utf8').trim() !==
    baseCommit
  )
    throw new Error('Preparation moved HEAD.');
  if (
    (
      await git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        path,
      )
    ).length
  )
    throw new Error('Preparation changed nonignored files.');
}
async function patchFor(
  request: WriteRunRequest,
  assignment: WriteAssignment,
  clonePath: string,
  evidenceDir: string,
  result: WorkerResult,
): Promise<{ result: WorkerResult; patch?: WorkerPatch }> {
  if (result.status !== 'PASS') return { result };
  const head = (await git(['rev-parse', 'HEAD'], clonePath))
    .toString('utf8')
    .trim();
  if (head !== request.baseCommit)
    return {
      result: { ...result, status: 'BLOCKED', summary: 'Worker moved HEAD.' },
    };
  const paths = await changedPaths(clonePath);
  if (!paths.length)
    return {
      result: {
        ...result,
        status: 'ISSUES',
        summary: 'Implementer produced no Git changes.',
      },
    };
  if (paths.length > 200)
    return {
      result: {
        ...result,
        status: 'BLOCKED',
        summary: 'Worker changed too many paths.',
      },
    };
  for (const path of paths) {
    if (!owned(path, assignment.owns))
      return {
        result: {
          ...result,
          status: 'ISSUES',
          summary: `Out-of-scope change: ${path}`,
        },
      };
    await ensureNoSymlinkPath(clonePath, path);
    const old = (
      await git(['ls-files', '--stage', '--', path], clonePath)
    ).toString('utf8');
    if (old.startsWith('120000 '))
      return {
        result: {
          ...result,
          status: 'ISSUES',
          summary: `Symlink edit: ${path}`,
        },
      };
  }
  await git(['add', '-A', '--', ...paths], clonePath);
  const patchBytes = await git(
    ['diff', '--cached', '--binary', '--full-index', request.baseCommit],
    clonePath,
  );
  if (!patchBytes.length || patchBytes.length > 8 * 1024 * 1024)
    return {
      result: {
        ...result,
        status: 'BLOCKED',
        summary: 'Patch is empty or exceeds 8 MiB.',
      },
    };
  const patchPath = join(evidenceDir, 'patch.diff');
  await writeFile(patchPath, patchBytes, { mode: 0o600 });
  const tree = (await git(['write-tree'], clonePath)).toString('utf8').trim();
  const snapshotCommit = (
    await git(
      [
        'commit-tree',
        tree,
        '-p',
        request.baseCommit,
        '-m',
        `Temari worker ${assignment.worker.id}`,
      ],
      clonePath,
    )
  )
    .toString('utf8')
    .trim();
  const patch: WorkerPatch = {
    assignmentId: assignment.worker.id,
    baseCommit: request.baseCommit,
    snapshotCommit,
    changedPaths: paths,
    sha256: createHash('sha256').update(patchBytes).digest('hex'),
    patchPath,
  };
  return {
    result: { ...result, evidencePaths: [...result.evidencePaths, patchPath] },
    patch,
  };
}
/** Shared exact-patch integration boundary. The integration clone must already be prepared. */
export async function integrateWriteWorkerPatches(
  request: WriteRunRequest,
  runPath: string,
  workerReceipt: ParallelWorkerReceipt,
  patchList: readonly WorkerPatch[],
  signal?: AbortSignal,
  onPhase?: (phase: 'integrating' | 'verifying') => Promise<void>,
): Promise<WriteRunReceipt> {
  const source = request.sourceRepo;
  const integrationPath = join(runPath, 'integration');
  const patches = new Map(
    patchList.map((patch) => [patch.assignmentId, patch]),
  );
  const verification: WriteRunReceipt['verification'][number][] = [];
  let status: WriteRunReceipt['status'] = 'BLOCKED';
  let reason: string | null = null;
  let integratedCommit: string | null = null;
  try {
    if (signal?.aborted) throw new Error('Run interrupted.');
    if (workerReceipt.status !== 'PASS') {
      status = workerReceipt.status === 'ISSUES' ? 'ISSUES' : 'BLOCKED';
      reason = workerReceipt.failure?.message ?? 'Required worker failed.';
    } else {
      const sourceHead = (await git(['rev-parse', 'HEAD'], source))
        .toString('utf8')
        .trim();
      if (
        sourceHead !== request.baseCommit ||
        (
          await git(
            ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
            source,
          )
        ).length
      )
        throw new Error(
          'Source checkout moved or became dirty during worker run.',
        );
      await onPhase?.('integrating');
      for (const entry of request.assignments) {
        const patch = patches.get(entry.worker.id);
        if (!patch) {
          if (entry.worker.required)
            throw new Error(
              `Required patch is missing for ${entry.worker.id}.`,
            );
          continue;
        }
        const patchBytes = await readFile(patch.patchPath);
        if (
          createHash('sha256').update(patchBytes).digest('hex') !== patch.sha256
        )
          throw new Error(`Patch digest changed for ${patch.assignmentId}.`);
        await git(
          ['apply', '--check', '--index', '--binary', '-'],
          integrationPath,
          signal,
          patchBytes,
        );
        await git(
          ['apply', '--index', '--binary', '-'],
          integrationPath,
          signal,
          patchBytes,
        );
      }
      const before = await git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        integrationPath,
      );
      const verifiedTree = (await git(['write-tree'], integrationPath))
        .toString('utf8')
        .trim();
      await git(['diff', '--exit-code', '--quiet'], integrationPath);
      if (
        (
          await git(
            ['ls-files', '--others', '--exclude-standard', '-z'],
            integrationPath,
          )
        ).length
      )
        throw new Error('Integration candidate contains untracked files.');
      await onPhase?.('verifying');
      for (const [index, command] of request.verify.entries()) {
        const logPath = join(runPath, `verify-${index}.log`);
        const stdoutPath = join(runPath, `verify-${index}.stdout.log`);
        const stderrPath = join(runPath, `verify-${index}.stderr.log`);
        const output = await runProcessToFiles({
          program: command.program,
          args: command.args,
          cwd: integrationPath,
          timeoutMs: command.timeoutMs ?? 120000,
          signal,
          stdoutPath,
          stderrPath,
          env: gitEnv,
        });
        const diagnosticPaths: string[] = [];
        for (const diagnostic of output.diagnostics) {
          try {
            if ((await lstat(diagnostic.path)).isFile())
              diagnosticPaths.push(diagnostic.path);
          } catch {}
        }
        const evidencePaths = [
          ...(output.stdout.available ? [stdoutPath] : []),
          ...(output.stderr.available ? [stderrPath] : []),
          ...diagnosticPaths,
        ];
        const entry: WriteRunReceipt['verification'][number] = {
          program: command.program,
          args: command.args,
          code: output.code,
          logPath,
          capture: {
            complete: output.captureComplete,
            error: output.error,
            stdout: output.stdout,
            stderr: output.stderr,
            diagnostics: output.diagnostics,
            evidencePaths,
            transcript: null,
          },
        };
        verification.push(entry);
        if (!output.stdout.available || !output.stderr.available)
          throw new WorkerExecutionFailure(
            `Verification command ${index} capture setup failed.`,
            {
              complete: false,
              reason: 'Verification capture setup was incomplete.',
              evidence: evidencePaths.map((path) => ({
                source: 'stream',
                kind: 'verification',
                content: streamEvidenceFile(path, runPath),
              })),
            },
          );
        const assemblyCauses: unknown[] = [];
        let transcript: Awaited<ReturnType<typeof open>> | undefined;
        try {
          transcript = await open(logPath, 'wx', 0o600);
          for (const path of [stdoutPath, stderrPath]) {
            if (path === stderrPath)
              await transcript.writeFile('\n--- stderr ---\n');
            const source = await open(path, 'r');
            try {
              for await (const chunk of source.createReadStream({
                autoClose: false,
              }))
                await transcript.writeFile(chunk);
            } catch (cause) {
              assemblyCauses.push(cause);
            } finally {
              try {
                await source.close();
              } catch (cause) {
                assemblyCauses.push(cause);
              }
            }
            if (assemblyCauses.length) break;
          }
          await transcript.sync();
        } catch (cause) {
          assemblyCauses.push(cause);
        } finally {
          if (transcript) {
            try {
              await transcript.close();
            } catch (cause) {
              assemblyCauses.push(cause);
            }
          }
        }
        let transcriptIdentity: CapturedProcessDiagnostic | null = null;
        try {
          if ((await lstat(logPath)).isFile()) {
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of streamEvidenceFile(logPath, runPath)) {
              bytes += chunk.byteLength;
              hash.update(chunk);
            }
            transcriptIdentity = {
              category: 'verification-transcript',
              path: logPath,
              status: assemblyCauses.length ? 'capture-failed' : 'complete',
              bytes,
              sha256: hash.digest('hex'),
              error: assemblyCauses.length
                ? 'Verification transcript capture failed.'
                : null,
            };
          }
        } catch (cause) {
          assemblyCauses.push(cause);
        }
        const assemblyDiagnostics: CapturedProcessDiagnostic[] = [];
        for (const [causeIndex, cause] of assemblyCauses.entries()) {
          const diagnostic = await retainProcessDiagnostic(
            join(
              runPath,
              `verify-${index}.transcript-failure-${causeIndex}.log`,
            ),
            'verification-transcript',
            cause,
          );
          assemblyDiagnostics.push(diagnostic);
          try {
            if ((await lstat(diagnostic.path)).isFile())
              evidencePaths.push(diagnostic.path);
          } catch {}
        }
        entry.capture = {
          ...entry.capture!,
          complete: output.captureComplete && assemblyCauses.length === 0,
          error: assemblyCauses.length
            ? 'Verification transcript capture failed.'
            : output.error,
          diagnostics: [...output.diagnostics, ...assemblyDiagnostics],
          transcript: transcriptIdentity,
        };
        if (assemblyCauses.length)
          throw new WorkerExecutionFailure(
            `Verification command ${index} transcript capture failed.`,
            {
              complete: false,
              reason: 'Verification transcript capture was incomplete.',
              evidence: [
                ...(transcriptIdentity ? [logPath] : []),
                ...evidencePaths,
              ].map((path) => ({
                source: 'stream',
                kind: 'verification',
                content: streamEvidenceFile(path, runPath),
              })),
            },
          );
        if (
          output.code !== 0 ||
          output.timedOut ||
          output.cancelled ||
          !output.captureComplete ||
          output.error
        )
          throw new WorkerExecutionFailure(
            `Verification command ${index} failed (exit=${output.code}, timeout=${output.timedOut}, capture=${output.captureComplete}).`,
            {
              complete: output.captureComplete,
              reason: output.captureComplete
                ? undefined
                : 'Verification diagnostic capture was incomplete.',
              evidence: [logPath, ...evidencePaths].map((path) => ({
                source: 'stream',
                kind: 'verification',
                content: streamEvidenceFile(path, runPath),
              })),
            },
          );
      }
      const after = await git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        integrationPath,
      );
      const afterHead = (await git(['rev-parse', 'HEAD'], integrationPath))
        .toString('utf8')
        .trim();
      const afterTree = (await git(['write-tree'], integrationPath))
        .toString('utf8')
        .trim();
      if (
        !before.equals(after) ||
        afterHead !== request.baseCommit ||
        afterTree !== verifiedTree
      )
        throw new Error('Verification changed the candidate or HEAD.');
      await git(['diff', '--exit-code', '--quiet'], integrationPath);
      if (
        (
          await git(
            ['ls-files', '--others', '--exclude-standard', '-z'],
            integrationPath,
          )
        ).length
      )
        throw new Error('Verification created untracked files.');
      const finalSourceHead = (await git(['rev-parse', 'HEAD'], source))
        .toString('utf8')
        .trim();
      if (
        finalSourceHead !== request.baseCommit ||
        (
          await git(
            ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
            source,
          )
        ).length
      )
        throw new Error(
          'Source checkout moved or became dirty before integration commit.',
        );
      if (signal?.aborted)
        throw new Error('Run interrupted before integration commit.');
      await git(
        [
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--no-gpg-sign',
          '-m',
          `Temari integrated ${request.runId}`,
        ],
        integrationPath,
        signal,
      );
      integratedCommit = (await git(['rev-parse', 'HEAD'], integrationPath))
        .toString('utf8')
        .trim();
      const parent = (await git(['rev-parse', 'HEAD^'], integrationPath))
        .toString('utf8')
        .trim();
      const committedTree = (
        await git(['rev-parse', 'HEAD^{tree}'], integrationPath)
      )
        .toString('utf8')
        .trim();
      if (parent !== request.baseCommit || committedTree !== verifiedTree)
        throw new Error(
          'Integration commit does not match the verified candidate.',
        );
      status = 'PASS';
    }
  } catch (error) {
    status = 'BLOCKED';
    reason = error instanceof Error ? error.message : String(error);
  }
  const receipt: WriteRunReceipt = {
    schema: 1,
    runId: request.runId,
    baseCommit: request.baseCommit,
    status,
    reason,
    workerReceipt,
    patches: patchList,
    integratedCommit,
    integrationPath,
    verification,
  };
  await writeFile(
    join(runPath, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return receipt;
}

/** Host-owned building blocks; all callers use the same write and scope guards. */
export {
  preflight as preflightWriteRun,
  clone as cloneWriteWorkspace,
  prepare as prepareWriteWorkspace,
  patchFor as captureWriteWorkerPatch,
};

export async function assertWriteCandidate(
  path: string,
  revision: string,
): Promise<void> {
  if (
    (await git(['rev-parse', 'HEAD'], path)).toString('utf8').trim() !==
    revision
  )
    throw new Error('Candidate HEAD changed.');
  if (
    (
      await git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        path,
      )
    ).length
  )
    throw new Error('Candidate working tree changed.');
}

export async function runCodexWriteWorkersRequest(
  value: unknown,
  signal?: AbortSignal,
): Promise<{
  status: string;
  integratedCommit: string | null;
  integrationPath: string;
  receiptPath: string;
}> {
  const request = parseWriteRunRequest(value);
  const source = await preflight(request);
  const executable = await resolveCodexExecutable(request.executable);
  const runPath = join(request.evidenceRoot, request.runId);
  await mkdir(runPath, { mode: 0o700 });
  const integrationPath = join(runPath, 'integration');
  const receiptPath = join(runPath, 'receipt.json');
  let workerReceipt: ParallelWorkerReceipt | null = null;
  const patches = new Map<string, WorkerPatch>();
  const verification: WriteRunReceipt['verification'][number][] = [];
  let status: WriteRunReceipt['status'] = 'BLOCKED';
  let reason: string | null = null;
  let integratedCommit: string | null = null;
  try {
    await clone(source, request.baseCommit, integrationPath, signal);
    await prepare(
      integrationPath,
      request.prepare ?? [],
      request.baseCommit,
      signal,
    );
    const workerPaths = new Map(
      request.assignments.map((entry) => [
        entry.worker.id,
        join(runPath, `worker-${entry.worker.id}`),
      ]),
    );
    for (const entry of request.assignments) {
      const path = workerPaths.get(entry.worker.id)!;
      await clone(source, request.baseCommit, path, signal);
      await prepare(path, request.prepare ?? [], request.baseCommit, signal);
    }
    const plan = reconcilePlan({
      workType: 'feature',
      parallelism: { maxConcurrency: request.maxConcurrency },
    });
    const capabilities: HostCapabilityReport = {
      host: 'codex-exec-write-local',
      available: ['parallelism'],
      missing: [
        'subagents',
        'model_diversity',
        'worktree_isolation',
        'durable_delivery',
        'forge',
      ],
      notes: { parallelism: 'Local isolated Codex processes.' },
      provenance: {
        parallelism: {
          status: 'unproven',
          source: 'real Codex overlap has not been verified',
        },
      },
    };
    workerReceipt = await runParallelWorkers({
      runId: request.runId,
      revision: request.baseCommit,
      plan,
      capabilities,
      assignments: request.assignments.map((entry) => entry.worker),
      handler: async (worker) => {
        const entry = request.assignments.find(
          (item) => item.worker.id === worker.id,
        )!;
        const evidenceDir = join(runPath, `evidence-${worker.id}`);
        const result = await runCodexExecWriteWorker(worker, {
          executable,
          workspaceRoot: workerPaths.get(worker.id)!,
          evidenceDirectory: evidenceDir,
          timeoutMs: request.timeoutMs,
          outputLimitBytes: request.outputLimitBytes,
          finalResponseLimitBytes: request.finalResponseLimitBytes,
          signal,
          baseCommit: request.baseCommit,
          owns: entry.owns,
        });
        const validated = await patchFor(
          request,
          entry,
          workerPaths.get(worker.id)!,
          evidenceDir,
          result,
        );
        if (validated.patch) patches.set(worker.id, validated.patch);
        return validated.result;
      },
    });
    const integrated = await integrateWriteWorkerPatches(
      request,
      runPath,
      workerReceipt,
      [...patches.values()],
      signal,
    );
    status = integrated.status;
    reason = integrated.reason;
    integratedCommit = integrated.integratedCommit;
    verification.push(...integrated.verification);
  } catch (error) {
    status = 'BLOCKED';
    reason = error instanceof Error ? error.message : String(error);
  }
  const receipt: WriteRunReceipt = {
    schema: 1,
    runId: request.runId,
    baseCommit: request.baseCommit,
    status,
    reason,
    workerReceipt,
    patches: request.assignments.flatMap((entry) => {
      const patch = patches.get(entry.worker.id);
      return patch ? [patch] : [];
    }),
    integratedCommit,
    integrationPath,
    verification,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return { status, integratedCommit, integrationPath, receiptPath };
}
async function main(): Promise<void> {
  if (process.argv.length !== 3)
    throw new Error('Usage: run-codex-write-workers.mts <request.json>');
  const value: unknown = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  const controller = new AbortController();
  let interrupted: 'SIGINT' | 'SIGTERM' | null = null;
  const onSignal = (name: 'SIGINT' | 'SIGTERM'): void => {
    if (!interrupted) {
      interrupted = name;
      controller.abort(name);
    }
  };
  const sigint = (): void => onSignal('SIGINT');
  const sigterm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    const result = await runCodexWriteWorkersRequest(value, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode =
      interrupted === 'SIGINT'
        ? 130
        : interrupted === 'SIGTERM'
          ? 143
          : result.status === 'PASS'
            ? 0
            : 1;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}
if (
  process.argv[1] &&
  basename(process.argv[1]) === 'run-codex-write-workers.mts' &&
  fileURLToPath(import.meta.url) === process.argv[1]
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
