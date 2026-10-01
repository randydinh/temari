import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  KnowledgeCheck,
  KnowledgeDiscoveryRequest,
  KnowledgeDocument,
  KnowledgeEvidence,
  KnowledgeGap,
  KnowledgeProvider,
  KnowledgeReadRequest,
  KnowledgeResult,
  KnowledgeSource,
} from '@temari/contracts';
import {
  canonical,
  digest,
  evidence,
  evidenceId,
  hash,
  integer,
  list,
  object,
  strings,
  text,
} from './codec.js';

export interface LocalRegistrarOptions {
  readonly python: string;
  readonly registrarSource: string;
  readonly preparation: string;
  readonly readScope: 'source-root';
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly onCommand?: (event: {
    readonly operation: string;
    readonly argv: readonly string[];
    readonly exitCode: number;
  }) => void;
}
class Refused extends Error {}
class Unsupported extends Error {}
class SourceUnavailable extends Error {}
const detail = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
function failure<T>(error: unknown, subject: string): KnowledgeResult<T> {
  const kind =
    error instanceof Refused
      ? 'scope-refused'
      : error instanceof Unsupported
        ? 'unsupported'
        : error instanceof SourceUnavailable
          ? 'unavailable'
          : 'unknown';
  return { ok: false, gap: { kind, subject, detail: detail(error) } };
}
export async function createLocalRegistrar(
  options: LocalRegistrarOptions,
): Promise<KnowledgeProvider> {
  if (options.readScope !== 'source-root')
    throw new Unsupported(
      'Registrar requires whole source-root admission; document-only access is unsupported',
    );
  assert(
    isAbsolute(options.python) &&
      isAbsolute(options.registrarSource) &&
      isAbsolute(options.preparation),
    'Absolute provider paths required',
  );
  const preparationPath = await realpath(options.preparation);
  const preparationStat = await lstat(preparationPath);
  assert(preparationStat.isFile() && preparationStat.size < 65536);
  const preparationBytes = await readFile(preparationPath);
  const setup = object(JSON.parse(preparationBytes.toString('utf8')));
  assert.equal(setup['kind'], 'temari-knowledge-isolated');
  assert.equal(setup['schema'], 1);
  const base = dirname(preparationPath);
  const state = join(base, 'state');
  const root = join(base, 'sources');
  assert.equal(text(setup['state']), state);
  assert.equal(text(setup['root']), root);
  const source: KnowledgeSource = {
    provider: text(setup['instance']),
    id: text(setup['sourceId']),
    locator: pathToFileURL(root).href,
  };
  const timeout = integer(options.timeoutMs ?? 15000, 1, 60000);
  const maxBuffer = integer(
    options.maxStdoutBytes ?? 1_048_576,
    1024,
    1_048_576,
  );
  async function implementationDigest(): Promise<string> {
    const files: string[] = [];
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
        else files.push(join(path, entry.name));
      }
    }
    await walk(join(options.registrarSource, 'src'));
    files.push(
      join(options.registrarSource, 'pyproject.toml'),
      join(options.registrarSource, 'uv.lock'),
      options.python,
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL(`./codec${adapterExtension}`, import.meta.url)),
    );
    const entries = await Promise.all(
      files.map(async (path) => [path, hash(await readFile(path))]),
    );
    return `registrar-source+adapter+python-binary:${hash(canonical(entries))}`;
  }
  const implementation = await implementationDigest();
  let registrationConfiguration: string | undefined;
  const identity = {
    instance: source.provider,
    implementation,
    configuration: '',
  };
  async function pin(): Promise<void> {
    assert.equal(
      await implementationDigest(),
      implementation,
      'Provider implementation changed',
    );
    assert.equal(
      hash(await readFile(preparationPath)),
      hash(preparationBytes),
      'Preparation changed',
    );
  }
  async function invoke(
    operation: 'list' | 'inventory' | 'discover' | 'read',
    args: string[],
  ): Promise<Record<string, unknown>> {
    await pin();
    const argv = [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      state,
      operation,
      ...args,
    ];
    const result = await new Promise<{ code: number; stdout: string }>(
      (resolveResult, reject) => {
        execFile(
          options.python,
          argv,
          {
            timeout,
            maxBuffer,
            encoding: 'utf8',
            env: {
              PYTHONPATH: join(options.registrarSource, 'src'),
              PYTHONDONTWRITEBYTECODE: '1',
              PATH: '/usr/bin:/bin',
              LANG: 'en_US.UTF-8',
            },
          },
          (error, stdout) => {
            const code = error === null ? 0 : error.code;
            if ((code === 0 || code === 2) && !error?.killed)
              resolveResult({ code, stdout });
            else reject(error ?? new Error('CLI failed'));
          },
        );
      },
    );
    options.onCommand?.({ operation, argv, exitCode: result.code });
    await pin();
    const payload = object(JSON.parse(result.stdout));
    if (payload['status'] === 'invalid')
      throw new Error(`Registrar invalid response: ${text(payload['error'])}`);
    return payload;
  }
  function admit(value: KnowledgeSource): void {
    if (canonical(value) !== canonical(source))
      throw new Refused(
        'Source is outside explicitly admitted registered root',
      );
  }
  async function preflight(): Promise<Record<string, unknown>> {
    for (const path of [base, state, root])
      assert.equal(await realpath(path), path, 'Prepared paths changed');
    for (const path of [state, root, join(state, 'registry.sqlite3')])
      assert(!(await lstat(path)).isSymbolicLink(), 'Symlink state refused');
    for (const name of ['cache', 'writer.lock']) {
      try {
        assert(
          !(await lstat(join(state, name))).isSymbolicLink(),
          'Symlink state refused',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    for (const name of ['retrieval-provider.json', 'evidence-policy.json']) {
      try {
        await lstat(join(state, name));
        throw new Unsupported(
          'Configured providers/policies are outside this isolated profile',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const rows = list((await invoke('list', []))['sources']).map(object);
    const registration = rows.find((r) => r['id'] === source.id);
    assert(registration, 'Prepared registration missing');
    if (registration['root'] !== root || registration['kind'] === 'testmo')
      throw new Refused('Registered root/kind differs from admission');
    assert.equal(registration['enabled'], true, 'Source disabled');
    text(registration['generation']);
    const configuration = canonical({
      root: registration['root'],
      kind: registration['kind'] ?? 'local',
      recursive: registration['recursive'],
      exclude: registration['exclude'],
      enabled: registration['enabled'],
    });
    if (registrationConfiguration !== undefined)
      assert.equal(
        configuration,
        registrationConfiguration,
        'Registration configuration changed',
      );
    else registrationConfiguration = configuration;
    return registration;
  }
  function pathFor(document: KnowledgeDocument): string {
    admit(document.source);
    const path = document.path;
    if (
      !path ||
      isAbsolute(path) ||
      path.includes('\0') ||
      path.split(/[\\/]/).some((p) => p === '..' || p === '.' || p === '') ||
      path.startsWith('-')
    )
      throw new Refused('Invalid source-relative path');
    if (!['.md', '.markdown', '.txt'].includes(extname(path).toLowerCase()))
      throw new Unsupported('Only UTF-8 text documents are supported');
    const full = resolve(root, path);
    if (relative(root, full).startsWith('..'))
      throw new Refused('Path escapes source root');
    return full;
  }
  async function bytes(document: KnowledgeDocument): Promise<Buffer> {
    const full = pathFor(document);
    assert.equal(await realpath(root), root, 'Source root changed');
    let current = root;
    let file;
    try {
      for (const part of relative(root, full).split('/')) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new Refused('Source symlink refused');
      }
      file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (
        ['ENOENT', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')
      )
        throw new SourceUnavailable(
          `Admitted source file unavailable: ${document.path}`,
        );
      throw e;
    }
    try {
      const before = await file.stat();
      assert(
        before.isFile() && before.size <= 8 * 1024 * 1024,
        'Unsupported source size/type',
      );
      const raw = await file.readFile();
      const after = await file.stat();
      const named = await lstat(full);
      assert(
        before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          after.ino === named.ino &&
          after.dev === named.dev,
        'Source changed during observation',
      );
      return raw;
    } finally {
      await file.close();
    }
  }
  function token(
    operation: string,
    requestKey: string,
    value: unknown,
  ): string {
    return Buffer.from(
      canonical({
        operation,
        configuration: identity.configuration,
        requestKey,
        value,
      }),
    ).toString('base64url');
  }
  function untoken(
    raw: string,
    operation: string,
    requestKey: string,
  ): Record<string, unknown> {
    assert(raw.length <= 8192, 'Oversize continuation');
    const envelope = object(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
    assert(
      envelope['operation'] === operation &&
        envelope['configuration'] === identity.configuration &&
        envelope['requestKey'] === requestKey,
      'Continuation scope/request mismatch',
    );
    return object(envelope['value']);
  }
  function gaps(raw: unknown): KnowledgeGap[] {
    return list(raw).map((item) => {
      const r = object(item);
      return {
        kind: 'unknown',
        subject:
          typeof r['source_id'] === 'string' && r['source_id']
            ? r['source_id']
            : source.id,
        detail: `${text(r['reason'])} (${integer(r['count'])})`,
      };
    });
  }
  async function readPage(
    request: KnowledgeReadRequest,
    exactOffset?: number,
  ): Promise<KnowledgeResult<import('@temari/contracts').KnowledgeRead>> {
    try {
      pathFor(request.document);
      const maxChars = integer(request.maxCodePoints, 1, 8000);
      integer(request.maxBytes, 1024, 65536);
      if (request.expectedSha256 !== null) digest(request.expectedSha256);
      const key = canonical({ document: request.document });
      const cursor =
        request.continuation === null
          ? null
          : untoken(request.continuation, 'read', key);
      if (cursor && request.expectedSha256 !== null)
        assert.equal(
          digest(cursor['sha256']),
          request.expectedSha256,
          'Continuation revision mismatch',
        );
      const registration = await preflight();
      const generation = text(
        cursor ? cursor['generation'] : registration['generation'],
      );
      const expected = cursor
        ? digest(cursor['sha256'])
        : request.expectedSha256;
      const offset = cursor ? integer(cursor['offset']) : (exactOffset ?? 0);
      const sourceBytes = await bytes(request.document);
      const sourceText = Array.from(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          sourceBytes,
        ),
      );
      const args = [
        source.id,
        request.document.path,
        '--offset',
        String(offset),
        '--max-chars',
        String(maxChars),
        '--max-bytes',
        String(request.maxBytes),
        '--expected-generation',
        generation,
      ];
      if (expected !== null) args.push('--expected-sha256', expected);
      const raw = await invoke('read', args);
      assert.equal(raw['schema'], 1);
      assert.equal(raw['operation'], 'read');
      assert(['partial', 'complete'].includes(text(raw['status'])));
      assert.equal(raw['source_id'], source.id);
      assert.equal(raw['path'], request.document.path);
      const sha256 = digest(raw['sha256']);
      if (expected !== null) assert.equal(sha256, expected);
      assert.equal(raw['generation'], generation);
      assert.equal(raw['offset'], offset);
      const record = object(raw['record']);
      assert.equal(record['support'], 'source-bytes-and-spans-verified');
      const citations = list(record['citations']);
      assert.equal(citations.length, 1);
      const cite = object(citations[0]);
      assert.equal(cite['source_id'], source.id);
      assert.equal(cite['path'], request.document.path);
      assert.equal(cite['sha256'], sha256);
      assert.equal(cite['absolute_path'], pathFor(request.document));
      assert.equal(cite['quote'], record['body']);
      assert.equal(cite['extraction'], 'utf-8-text');
      const body = text(record['body']);
      const start = integer(cite['text_start']);
      const end = integer(cite['text_end'], start + 1);
      assert.equal(start, offset);
      assert.equal(Array.from(body).length, end - start);
      assert(end - start <= maxChars);
      const total = integer(raw['total_chars'], end, 8 * 1024 * 1024);
      assert.equal(
        hash(sourceBytes),
        sha256,
        'CLI/source byte identity mismatch',
      );
      assert.equal(
        total,
        sourceText.length,
        'CLI/source codepoint length mismatch',
      );
      assert.equal(
        body,
        sourceText.slice(start, end).join(''),
        'CLI citation differs from exact source-byte codepoint slice',
      );
      const next =
        raw['next_offset'] === null
          ? null
          : integer(raw['next_offset'], end, total);
      assert.equal(next, end < total ? end : null);
      assert.equal(raw['status'], next === null ? 'complete' : 'partial');
      const value = {
        document: request.document,
        sha256,
        representation: {
          method: 'utf-8-text',
          signature: digest(cite['extractor_signature']),
        },
        span: { unit: 'unicode-codepoint' as const, start, end },
        excerpt: body,
      };
      const item = { id: evidenceId(value), ...value };
      assert.equal(
        hash(await bytes(request.document)),
        sha256,
        'Source changed during read',
      );
      assert.equal(
        canonical(await preflight()),
        canonical(registration),
        'Registration changed during read',
      );
      return {
        ok: true,
        value: {
          evidence: item,
          snapshot: digest(raw['snapshot']),
          totalCodePoints: total,
          next:
            next === null
              ? null
              : token('read', key, { offset: next, generation, sha256 }),
        },
      };
    } catch (e) {
      return failure(e, request.document.path);
    }
  }
  await preflight();
  identity.configuration = hash(
    canonical({
      source,
      state,
      python: options.python,
      implementation,
      preparation: hash(preparationBytes),
      registrationConfiguration,
      timeout,
      maxBuffer,
      readScope: options.readScope,
      runtimeDependencies: 'installed-environment-not-attested',
    }),
  );
  return {
    identity,
    async discover(request: KnowledgeDiscoveryRequest) {
      try {
        if (!request.scope.length)
          throw new Refused('Explicit nonempty source scope required');
        request.scope.forEach(admit);
        integer(request.limit, 1, 50);
        integer(request.maxBytes, 1024, 65536);
        text(request.query);
        const key = canonical({ scope: request.scope, query: request.query });
        const cursor =
          request.continuation === null
            ? null
            : untoken(request.continuation, 'discover', key);
        const before = await preflight();
        const args = [
          request.query,
          '--source',
          source.id,
          '--mode',
          'exact',
          '--limit',
          String(request.limit),
          '--max-bytes',
          String(request.maxBytes),
        ];
        if (cursor) args.push('--cursor', text(cursor['cursor']));
        const raw = await invoke('discover', args);
        assert.equal(raw['schema'], 1);
        assert.equal(raw['operation'], 'discover');
        assert.equal(raw['query'], request.query);
        assert(['partial', 'complete'].includes(text(raw['status'])));
        const documents = list(raw['documents']).map((item) => {
          const d = object(item);
          assert.equal(d['source_id'], source.id);
          const doc = { source, path: text(d['path']) };
          pathFor(doc);
          return {
            document: doc,
            sha256: digest(d['sha256']),
            applicability: text(d['applicability']),
            conflicts: strings(d['declared_conflicts']),
          };
        });
        const c = object(raw['coverage']);
        const matched = integer(c['matched']);
        const consumed = integer(c['consumed']);
        const remaining = integer(c['remaining']);
        assert.equal(integer(c['returned']), documents.length);
        assert.equal(consumed + remaining, matched);
        assert.equal(c['enumeration_exhausted'], remaining === 0);
        assert.equal(c['semantic_recall'], 'not-evaluated');
        if (cursor)
          assert(
            consumed > integer(cursor['consumed']),
            'Discovery did not advance',
          );
        assert.equal(raw['next_cursor'] === null, remaining === 0);
        const snapshot = digest(raw['snapshot']);
        if (cursor) assert.equal(snapshot, cursor['snapshot']);
        const sources = list(raw['sources']).map((item) => {
          const r = object(item);
          assert.equal(r['id'], source.id);
          return {
            source,
            generation: text(r['generation']),
            scannedAt:
              r['last_scan_at'] === null ? null : text(r['last_scan_at']),
            observation: `${text(r['scan_status'])}; membership from last scan, semantic recall not evaluated`,
          };
        });
        assert.equal(
          canonical(await preflight()),
          canonical(before),
          'Registration changed during discovery',
        );
        return {
          ok: true,
          value: {
            snapshot,
            documents,
            sources,
            coverage: {
              indexed: integer(c['indexed_documents']),
              matched,
              returned: documents.length,
              consumed,
              remaining,
              exhausted: remaining === 0,
              semanticRecall: 'not-evaluated',
            },
            gaps: gaps(raw['gaps']),
            next:
              raw['next_cursor'] === null
                ? null
                : token('discover', key, {
                    cursor: text(raw['next_cursor']),
                    consumed,
                    snapshot,
                  }),
          },
        };
      } catch (e) {
        return failure(e, 'discovery');
      }
    },
    read: readPage,
    async revalidate(item: KnowledgeEvidence): Promise<KnowledgeCheck> {
      const baseCheck = {
        evidenceId: item.id,
        checkedAt: new Date().toISOString(),
      };
      try {
        evidence(item);
        pathFor(item.document);
        await preflight();
        const actual = hash(await bytes(item.document));
        if (actual !== item.sha256)
          return {
            ...baseCheck,
            state: 'changed',
            detail: `Observed byte hash ${actual}`,
          };
        const result = await readPage(
          {
            document: item.document,
            expectedSha256: item.sha256,
            maxCodePoints: item.span.end - item.span.start,
            maxBytes: 65536,
            continuation: null,
          },
          item.span.start,
        );
        if (!result.ok)
          return { ...baseCheck, state: 'unknown', detail: result.gap.detail };
        if (
          canonical(result.value.evidence.representation) !==
          canonical(item.representation)
        )
          return {
            ...baseCheck,
            state: 'changed',
            detail: 'Verified representation changed',
          };
        assert.equal(
          result.value.evidence.id,
          item.id,
          'Saved excerpt/span could not be reproduced',
        );
        return {
          ...baseCheck,
          state: 'unchanged',
          detail: 'Bytes, representation and exact codepoint span re-read',
        };
      } catch (e) {
        return {
          ...baseCheck,
          state: e instanceof SourceUnavailable ? 'unavailable' : 'unknown',
          detail: detail(e),
        };
      }
    },
  };
}
