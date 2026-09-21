import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { bounded, canonical, frozenCopy, sha256, text } from './data.js';
import { canonicalDirectory } from './files.js';
import {
  assessmentData,
  assessmentPolicy,
  fields,
  parseAssessment,
  parseProposal,
  parseReview,
  proposalData,
  proposalPolicy,
  reviewData,
  reviewPolicy,
} from './judgment-policy.js';
import type { ConversationDraftDependencies, JudgmentRole } from './types.js';

export interface CommandJudgmentRole {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly behaviorRevision: string;
  readonly service: {
    readonly id: string;
    readonly configurationRevision: string;
  };
  readonly timeoutMs: number;
}

export interface CommandJudgmentConfiguration {
  readonly instance: string;
  readonly roles: Readonly<Record<JudgmentRole, CommandJudgmentRole>>;
}

const version = 1;
const bridgeRevision = 1;
const roles = ['assess', 'propose', 'review'] as const;
const policies = {
  assess: assessmentPolicy,
  propose: proposalPolicy,
  review: reviewPolicy,
};
const executionPolicy = {
  attempts: 1,
  tools: false,
  context: 'fresh',
  responseRepair: false,
};
const limits = {
  inputBytes: 32 * 1024 * 1024,
  stdoutBytes: 1024 * 1024,
  stderrBytes: 64 * 1024,
  resultBytes: 256 * 1024,
  terminationGraceMs: 100,
};

function failure(
  role: JudgmentRole,
  category: string,
  requestId?: string,
): Error {
  return new Error(
    `Command judgment ${role}: ${category}${requestId ? ` (${requestId})` : ''}`,
  );
}

function absolute(path: string): void {
  text(path);
  assert(!path.includes('\0') && isAbsolute(path) && resolve(path) === path);
}

function snapshot(
  configuration: CommandJudgmentConfiguration,
): CommandJudgmentConfiguration {
  try {
    const config = frozenCopy(configuration);
    fields(config, ['instance', 'roles']);
    text(config.instance);
    fields(config.roles, roles);
    for (const role of roles) {
      const command = config.roles[role];
      fields(command, [
        'executable',
        'args',
        'cwd',
        'environment',
        'artifacts',
        'behaviorRevision',
        'service',
        'timeoutMs',
      ]);
      absolute(command.executable);
      absolute(command.cwd);
      assert(Array.isArray(command.args));
      assert(
        command.args.every(
          (arg) => typeof arg === 'string' && !arg.includes('\0'),
        ),
      );
      text(command.behaviorRevision);
      fields(command.service, ['id', 'configurationRevision']);
      text(command.service.id);
      text(command.service.configurationRevision);
      assert(
        Number.isSafeInteger(command.timeoutMs) &&
          command.timeoutMs >= 1 &&
          command.timeoutMs <= 300_000,
      );
      assert(
        command.environment !== null &&
          typeof command.environment === 'object' &&
          !Array.isArray(command.environment),
      );
      for (const [name, value] of Object.entries(command.environment)) {
        assert(name.length > 0 && !/[=\0]/.test(name));
        assert(typeof value === 'string' && !value.includes('\0'));
      }
      assert(
        command.artifacts !== null &&
          typeof command.artifacts === 'object' &&
          !Array.isArray(command.artifacts),
      );
      assert(Object.hasOwn(command.artifacts, command.executable));
      for (const [path, digest] of Object.entries(command.artifacts)) {
        absolute(path);
        assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
      }
    }
    return config;
  } catch {
    throw new Error('Command judgments: invalid configuration');
  }
}

async function ready(
  role: JudgmentRole,
  command: CommandJudgmentRole,
): Promise<void> {
  try {
    assert(process.platform !== 'win32');
    await canonicalDirectory(command.cwd);
    await access(command.executable, constants.X_OK);
    for (const [path, expected] of Object.entries(command.artifacts)) {
      assert.equal(await realpath(path), path);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        assert((await file.stat()).isFile());
        const digest = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false }))
          digest.update(chunk);
        assert.equal(digest.digest('hex'), expected);
      } finally {
        await file.close();
      }
    }
  } catch {
    throw failure(role, 'unavailable or changed artifacts');
  }
}

function exchange(
  command: CommandJudgmentRole,
  role: JudgmentRole,
  requestId: string,
  body: string,
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    let state: 'running' | 'terminating' | 'settled' = 'running';
    const deadline = setTimeout(() => fail('timeout'), command.timeoutMs);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.executable, [...command.args], {
        shell: false,
        detached: true,
        cwd: command.cwd,
        env: { NODE_V8_COVERAGE: undefined, ...command.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      clearTimeout(deadline);
      state = 'settled';
      reject(failure(role, 'launch failure', requestId));
      return;
    }
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    function signalGroup(signal: NodeJS.Signals): void {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* The group may already have exited. */
        }
      }
    }

    function fail(category: string): void {
      if (state !== 'running') return;
      state = 'terminating';
      clearTimeout(deadline);
      chunks.length = 0;
      signalGroup('SIGTERM');
      setTimeout(() => {
        signalGroup('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        state = 'settled';
        reject(failure(role, category, requestId));
      }, limits.terminationGraceMs);
    }

    child.on('error', () => fail('launch failure'));
    child.stdin.on('error', () => fail('stdin failure'));
    child.stdout.on('error', () => fail('stdout failure'));
    child.stderr.on('error', () => fail('stderr failure'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (state !== 'running') return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.stdoutBytes) fail('stdout limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (state !== 'running') return;
      stderrBytes += chunk.length;
      if (stderrBytes > limits.stderrBytes) fail('stderr limit');
    });
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal !== null) fail('unsuccessful exit');
    });
    child.on('close', (code, signal) => {
      if (state !== 'running') return;
      if (
        code !== 0 ||
        signal !== null ||
        !child.stdin.writableFinished ||
        !child.stdout.readableEnded ||
        !child.stderr.readableEnded
      ) {
        fail('incomplete exchange');
        return;
      }
      state = 'settled';
      clearTimeout(deadline);
      resolveResult(Buffer.concat(chunks));
    });
    try {
      child.stdin.end(body);
    } catch {
      fail('stdin failure');
    }
  });
}

export function createCommandJudgments(
  configuration: CommandJudgmentConfiguration,
): Omit<ConversationDraftDependencies, 'provider'> {
  const config = snapshot(configuration);
  const identity = (role: JudgmentRole) => ({
    id: `command-${sha256(config.instance)}-${role}`,
    revision: sha256(
      canonical({
        bridgeRevision,
        version,
        instance: config.instance,
        role,
        command: config.roles[role],
        policy: policies[role],
        executionPolicy,
        limits,
      }),
    ),
  });
  const bindings = {
    assess: identity('assess'),
    propose: identity('propose'),
    review: identity('review'),
  };

  async function invoke<T>(
    role: JudgmentRole,
    project: () => unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const command = config.roles[role];
    const requestId = randomUUID();
    let body: string;
    let requestDigest: string;
    try {
      const { instructions, responseShape } = policies[role];
      const data = fields(project(), ['trusted', 'untrusted']);
      const request = {
        version,
        role,
        bindingRevision: bindings[role].revision,
        service: command.service,
        instructions,
        responseShape,
        ...data,
        executionPolicy,
        limits: { ...limits, timeoutMs: command.timeoutMs },
      };
      requestDigest = sha256(bounded(request, limits.inputBytes, 'request'));
      body = bounded(
        { ...request, requestId, requestDigest },
        limits.inputBytes,
        'request',
      );
    } catch {
      throw failure(role, 'invalid or oversized input', requestId);
    }
    await ready(role, command);
    const output = await exchange(command, role, requestId, body);
    try {
      const response: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(output),
      );
      const r = fields(response, [
        'version',
        'role',
        'bindingRevision',
        'service',
        'requestId',
        'requestDigest',
        'status',
        'result',
      ]);
      assert.equal(r['version'], version);
      assert.equal(r['role'], role);
      assert.equal(r['bindingRevision'], bindings[role].revision);
      assert.equal(r['requestId'], requestId);
      assert.equal(r['requestDigest'], requestDigest);
      assert.equal(r['status'], 'completed');
      assert.equal(canonical(r['service']), canonical(command.service));
      bounded(r['result'], limits.resultBytes, 'result');
      return parse(r['result']);
    } catch {
      throw failure(role, 'invalid response', requestId);
    }
  }

  return Object.freeze({
    assessor: Object.freeze({
      ...bindings.assess,
      assess: (
        input: Parameters<
          ConversationDraftDependencies['assessor']['assess']
        >[0],
      ) => invoke('assess', () => assessmentData(input), parseAssessment),
    }),
    writer: Object.freeze({
      ...bindings.propose,
      propose: (
        input: Parameters<
          ConversationDraftDependencies['writer']['propose']
        >[0],
      ) => invoke('propose', () => proposalData(input), parseProposal),
    }),
    reviewer: Object.freeze({
      ...bindings.review,
      review: (
        input: Parameters<
          ConversationDraftDependencies['reviewer']['review']
        >[0],
      ) =>
        invoke(
          'review',
          () => reviewData(input),
          (value) => {
            const review = parseReview(value);
            assert.equal(review.candidateSha256, input.candidate.sha256);
            return review;
          },
        ),
    }),
    checkReady: async (requested) => {
      for (const role of requested) {
        assert(roles.includes(role), 'Unknown judgment role');
        await ready(role, config.roles[role]);
      }
    },
  } satisfies Omit<ConversationDraftDependencies, 'provider'>);
}
