import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, integer, object, text } from './codec.js';

export interface ArchiveTransportOptions {
  readonly python: string;
  readonly registrarSource: string;
  readonly workspace: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
}
export class ArchiveFailure extends Error {
  constructor(
    readonly kind: 'scope-refused' | 'unavailable' | 'unknown' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}
export const protocolFile = 'docs/design/source-archive-contract-v1.json';
export async function archiveTransport(options: ArchiveTransportOptions) {
  for (const path of [
    options.python,
    options.registrarSource,
    options.workspace,
  ])
    assert(isAbsolute(path), 'Absolute archive paths required');
  const timeoutMs = integer(options.timeoutMs ?? 30000, 1, 60000);
  const maxStdoutBytes = integer(
    options.maxStdoutBytes ?? 1_048_576,
    1024,
    1_048_576,
  );
  const config = {
    python: options.python,
    registrarSource: options.registrarSource,
    workspace: options.workspace,
    timeoutMs,
    maxStdoutBytes,
  };
  async function implementationDigest() {
    const paths: string[] = [];
    const adapterExtension = fileURLToPath(import.meta.url).endsWith('.ts')
      ? '.ts'
      : '.js';
    async function walk(path: string): Promise<void> {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (entry.name === '__pycache__') continue;
        assert(!entry.isSymbolicLink(), 'Implementation symlink refused');
        if (entry.isDirectory()) await walk(join(path, entry.name));
        else paths.push(join(path, entry.name));
      }
    }
    await walk(join(config.registrarSource, 'src'));
    paths.push(
      ...['pyproject.toml', 'uv.lock', protocolFile].map((p) =>
        join(config.registrarSource, p),
      ),
      config.python,
    );
    for (const name of [
      'archive-transport',
      'archive-intake',
      'archive-registrar',
      'archive-graph',
      'durable',
      'codec',
    ])
      paths.push(
        fileURLToPath(new URL(`./${name}${adapterExtension}`, import.meta.url)),
      );
    return hash(
      canonical(
        await Promise.all(paths.map(async (p) => [p, hash(await readFile(p))])),
      ),
    );
  }
  const implementation = await implementationDigest();
  const protocolSha256 = hash(
    await readFile(join(config.registrarSource, protocolFile)),
  );
  async function invoke(
    operation:
      | 'capture'
      | 'inspect'
      | 'read'
      | 'discover'
      | 'list'
      | 'graph-read'
      | 'graph-projection'
      | 'graph-publish'
      | 'graph-retract',
    args: string[],
    responseBytes = maxStdoutBytes,
  ): Promise<Record<string, unknown>> {
    assert.equal(
      await implementationDigest(),
      implementation,
      'Archive implementation changed',
    );
    assert.equal(
      await realpath(config.workspace),
      config.workspace,
      'Workspace changed',
    );
    const db = join(config.workspace, 'registry.sqlite3');
    assert.equal(await realpath(db), db, 'Registry symlink refused');
    assert((await lstat(db)).isFile(), 'Existing Registrar registry required');
    // This profile has no configured alternate retrieval provider or policy interpretation.
    for (const name of ['retrieval-provider.json', 'evidence-policy.json']) {
      try {
        await lstat(join(config.workspace, name));
        throw new ArchiveFailure(
          'unsupported',
          'Configured provider/policy is outside archive profile',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const argv = [
      '-B',
      '-m',
      'knowledge_agent.cli',
      operation === 'list' ? 'sources' : 'archive',
      '--workspace',
      config.workspace,
      operation,
      ...args,
    ];
    const result = await new Promise<{ code: number; stdout: Buffer }>(
      (resolve, reject) => {
        execFile(
          config.python,
          argv,
          {
            cwd: config.registrarSource,
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: Math.min(maxStdoutBytes, responseBytes + 4096),
            encoding: 'buffer',
            env: {
              PATH: '/usr/bin:/bin',
              PYTHONPATH: join(config.registrarSource, 'src'),
              PYTHONNOUSERSITE: '1',
              PYTHONDONTWRITEBYTECODE: '1',
              PYTHONIOENCODING: 'utf-8',
            },
          },
          (error, stdout) => {
            if (
              error &&
              (typeof error.code !== 'number' || ![0, 2].includes(error.code))
            )
              reject(
                new ArchiveFailure(
                  'unavailable',
                  'Registrar process failed, timed out, or exceeded output bound',
                ),
              );
            else
              resolve({
                code: typeof error?.code === 'number' ? error.code : 0,
                stdout,
              });
          },
        );
      },
    );
    assert.equal(
      await implementationDigest(),
      implementation,
      'Archive implementation changed during command',
    );
    assert(
      result.stdout.length <= responseBytes + 1,
      'Registrar response exceeds bound',
    );
    const resultObject = object(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(result.stdout),
      ),
    );
    if (operation !== 'list') {
      assert.equal(resultObject['schema'], 1, 'Unsupported Registrar protocol');
      if (result.code !== 0 || resultObject['status'] === 'invalid') {
        // Never pass provider-controlled paths/identifiers from error messages to a reader.
        const raw =
          typeof resultObject['error'] === 'string'
            ? resultObject['error']
            : '';
        if (/disabled|admission|configuration|excluded|scope/i.test(raw))
          throw new ArchiveFailure(
            'scope-refused',
            'Registrar archive access refused by current admission',
          );
        if (
          /blob|corrupt|integrity|mismatch|manifest|representation.*invalid|unsupported archive representation/i.test(
            raw,
          )
        )
          throw new ArchiveFailure(
            'unavailable',
            'Registrar retained archive integrity verification failed',
          );
        if (/representation unavailable/i.test(raw))
          throw new ArchiveFailure(
            'unsupported',
            'Archived text representation unavailable; inspect capture capability gaps',
          );
        throw new ArchiveFailure(
          'unavailable',
          'Registrar archive operation refused; retained archive or requested capability unavailable',
        );
      }
      if (operation !== 'graph-read' && operation !== 'graph-projection')
        assert(
          ['complete', 'partial'].includes(text(resultObject['status'])),
          'Invalid Registrar status',
        );
    } else assert.equal(result.code, 0);
    return resultObject;
  }
  return { config, implementation, protocolSha256, invoke };
}
