import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  InvestigationTask,
  KnowledgeGap,
  KnowledgeSource,
} from '@temari/contracts';
import {
  canonical,
  digest,
  hash,
  integer,
  knowledgeGap,
  list,
  object,
  source,
  text,
} from './codec.js';
import {
  archiveTransport,
  type ArchiveTransportOptions,
} from './archive-transport.js';
import { publishJson, readJson } from './durable.js';

export interface ArchiveIntakeOptions {
  readonly task: InvestigationTask;
  readonly source: KnowledgeSource;
  readonly readScope: 'source-root';
  readonly transport: ArchiveTransportOptions;
  readonly requestKey: string;
  readonly limits?: {
    readonly entries?: number;
    readonly file_bytes?: number;
    readonly total_bytes?: number;
    readonly text_bytes?: number;
  };
}
export interface ArchivePublication {
  readonly schema: 1;
  readonly kind: 'temari-archive-publication';
  readonly task: InvestigationTask;
  readonly source: KnowledgeSource;
  readonly readScope: 'source-root';
  readonly transport: Required<ArchiveTransportOptions>;
  readonly implementation: string;
  readonly protocolSha256: string;
  readonly registration: string;
  readonly binding: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly captureRequestKey: string;
  readonly captureFingerprint: string;
  readonly preservation: 'complete-admitted' | 'incomplete';
  readonly counts: Record<string, number>;
  readonly capabilities: Record<string, unknown>;
  readonly gaps: readonly KnowledgeGap[];
  readonly currentOriginal: 'not-checked';
}
export function generation(value: unknown): string {
  const result = text(value);
  assert(/^[a-f0-9]{32}$/.test(result), 'Invalid archive generation');
  return result;
}
export function historical(r: Record<string, unknown>): void {
  assert.equal(r['evidence'], 'archived-snapshot');
  assert.equal(r['current_original'], 'not-checked');
}
export function snapshot(
  r: Record<string, unknown>,
  p: Pick<ArchivePublication, 'source' | 'generation' | 'manifestSha256'>,
): void {
  assert.equal(r['source_id'], p.source.id);
  assert.equal(generation(r['generation']), p.generation);
  assert.equal(digest(r['manifest_sha256']), p.manifestSha256);
  historical(r);
  assert.equal(r['integrity'], 'verified');
}
export async function registrationFor(
  transport: Awaited<ReturnType<typeof archiveTransport>>,
  selected: KnowledgeSource,
): Promise<string> {
  source(selected);
  const rows = list((await transport.invoke('list', []))['sources']).map(
    object,
  );
  const row = rows.find((r) => r['id'] === selected.id);
  assert(row, 'Admitted registration unavailable');
  assert.equal(row['enabled'], true, 'Admitted source disabled');
  assert.equal(
    pathToFileURL(text(row['root'])).href,
    selected.locator,
    'Admitted source locator mismatch',
  );
  assert(
    !['testmo', 'shortcut', 'notion'].includes(String(row['kind'])),
    'Local registration required',
  );
  assert(typeof row['recursive'] === 'boolean');
  return canonical({
    source: selected,
    root: row['root'],
    kind: row['kind'] ?? 'local',
    recursive: row['recursive'],
    exclude: list(row['exclude']).map(text),
    enabled: true,
  });
}
export function omission(reason: unknown, subject: string): KnowledgeGap {
  const detail = text(reason);
  assert(detail.length <= 512);
  return { kind: 'unsupported', subject, detail };
}
export function validatePublication(
  value: unknown,
): asserts value is ArchivePublication {
  const p = object(value);
  assert.equal(p['schema'], 1);
  assert.equal(p['kind'], 'temari-archive-publication');
  assert.equal(p['readScope'], 'source-root');
  source(p['source']);
  generation(p['generation']);
  for (const k of [
    'implementation',
    'protocolSha256',
    'manifestSha256',
    'captureFingerprint',
    'binding',
  ])
    digest(p[k]);
  assert(/^temari-archive-v1:[a-f0-9]{64}$/.test(text(p['captureRequestKey'])));
  assert.equal(p['currentOriginal'], 'not-checked');
  assert(['complete-admitted', 'incomplete'].includes(text(p['preservation'])));
  text(p['registration']);
  object(p['capabilities']);
  for (const n of Object.values(object(p['counts']))) integer(n, 0, 1000);
  const t = object(p['task']);
  text(t['id']);
  text(t['authorityRef']);
  text(t['directory']);
  const c = object(p['transport']);
  for (const k of ['python', 'registrarSource', 'workspace']) text(c[k]);
  integer(c['timeoutMs'], 1, 60000);
  integer(c['maxStdoutBytes'], 1024, 1_048_576);
  assert(list(p['gaps']).length <= 64);
  list(p['gaps']).forEach(knowledgeGap);
  assert(
    Buffer.byteLength(canonical(value)) <= 65536,
    'Publication exceeds bound',
  );
}
export async function loadArchivePublication(
  path: string,
): Promise<ArchivePublication> {
  const value = await readJson(path);
  validatePublication(value);
  assert.equal(dirname(path), value.task.directory);
  assert.equal(basename(path), `archive-publication-${value.binding}.json`);
  return value;
}
export class ArchivePersistenceError extends Error {
  constructor(
    readonly attemptPath: string,
    cause: unknown,
  ) {
    super(
      'Archive intake persistence failed; capture may have committed. Replay the same request key.',
      { cause },
    );
  }
}
export interface ArchiveIntakeOutcome {
  readonly status: 'published' | 'blocked';
  readonly publicationPath: string | null;
  readonly preservation: ArchivePublication['preservation'] | null;
  readonly gaps: readonly KnowledgeGap[];
  readonly attemptPath: string;
  readonly resultPath: string;
}
/** Operator-only. Does not register, refresh, or copy any source bytes into Temari. */
export async function captureArchive(
  options: ArchiveIntakeOptions,
): Promise<ArchiveIntakeOutcome> {
  // Copy caller input so an asynchronous caller cannot change admission mid-capture.
  const o = JSON.parse(canonical(options)) as ArchiveIntakeOptions;
  text(o.task.id);
  text(o.task.authorityRef);
  source(o.source);
  assert.equal(o.readScope, 'source-root');
  assert(/^[A-Za-z0-9_.:-]{1,128}$/.test(o.requestKey));
  const attempt = randomUUID(),
    attemptPath = join(o.task.directory, `archive-attempt-${attempt}.json`),
    resultPath = join(o.task.directory, `archive-result-${attempt}.json`);
  await publishJson(attemptPath, {
    schema: 1,
    kind: 'temari-archive-attempt',
    options: o,
    state: 'started',
  });
  let publicationPath: string | null = null;
  try {
    const transport = await archiveTransport(o.transport);
    const limits = {
      entries: 1000,
      file_bytes: 8 * 1024 * 1024,
      total_bytes: 64 * 1024 * 1024,
      text_bytes: 8 * 1024 * 1024,
      ...o.limits,
    };
    assert(Object.keys(limits).length === 4);
    for (const [key, max] of Object.entries({
      entries: 1000,
      file_bytes: 8 * 1024 * 1024,
      total_bytes: 64 * 1024 * 1024,
      text_bytes: 8 * 1024 * 1024,
    }))
      integer(limits[key as keyof typeof limits], 1, max);
    const captureRequestKey = `temari-archive-v1:${hash(canonical({ task: o.task, key: o.requestKey }))}`;
    // Key is task-scoped locally; changing the selected source under that key collides.
    const bindingId = hash(captureRequestKey);
    const registration = await registrationFor(transport, o.source);
    const binding = {
      schema: 1,
      task: o.task,
      source: o.source,
      readScope: o.readScope,
      limits,
      captureRequestKey,
      transport: transport.config,
      implementation: transport.implementation,
      protocolSha256: transport.protocolSha256,
      registration,
    };
    await publishJson(
      join(o.task.directory, `archive-binding-${bindingId}.json`),
      binding,
    );
    const r = await transport.invoke('capture', [
      o.source.id,
      '--request-key',
      captureRequestKey,
      '--limits',
      canonical(limits),
    ]);
    assert.equal(r['status'], 'complete');
    assert.equal(r['source_id'], o.source.id);
    assert.equal(r['request_key'], captureRequestKey);
    assert(typeof r['replayed'] === 'boolean');
    historical(r);
    const pin = {
      source: o.source,
      generation: generation(r['generation']),
      manifestSha256: digest(r['manifest_sha256']),
    };
    const gaps: KnowledgeGap[] = [];
    let capabilities: Record<string, unknown> = {},
      offset = 0;
    do {
      const inspected = await transport.invoke('inspect', [
        o.source.id,
        pin.generation,
        '--manifest-sha256',
        pin.manifestSha256,
        '--offset',
        String(offset),
        '--limit',
        '100',
        '--max-bytes',
        '1048576',
      ]);
      snapshot(inspected, pin);
      assert.equal(inspected['request_key'], captureRequestKey);
      assert.equal(inspected['request_fingerprint'], r['request_fingerprint']);
      assert.equal(inspected['preservation'], r['preservation']);
      assert.equal(canonical(inspected['counts']), canonical(r['counts']));
      const rawCapabilities = object(inspected['capabilities']);
      capabilities = {};
      for (const [key, expected] of Object.entries({
        retrieval: 'exact-lexical',
        visual: 'unsupported',
        ocr: 'unsupported',
        asset_inventory: 'partial-or-unknown',
        structural_navigation: 'unsupported',
      })) {
        assert.equal(
          rawCapabilities[key],
          expected,
          'Unsupported archive capability contract',
        );
        capabilities[key] = expected;
      }
      for (const raw of list(inspected['documents'])) {
        const d = object(raw);
        for (const reason of list(d['gaps'])) {
          const gap = omission(reason, o.source.id);
          if (!gaps.some((g) => canonical(g) === canonical(gap)))
            gaps.push(gap);
        }
        if (
          d['status'] === 'unavailable' &&
          !gaps.some((g) => g.kind === 'unavailable')
        )
          gaps.push({
            kind: 'unavailable',
            subject: o.source.id,
            detail: 'Original preservation incomplete',
          });
      }
      assert(gaps.length <= 64, 'Capability receipt exceeds bound');
      if (inspected['next_offset'] === null) break;
      offset = integer(inspected['next_offset'], offset + 1, 1000);
    } while (true);
    const p: ArchivePublication = {
      schema: 1,
      kind: 'temari-archive-publication',
      task: o.task,
      readScope: o.readScope,
      transport: transport.config,
      implementation: transport.implementation,
      protocolSha256: transport.protocolSha256,
      registration,
      binding: bindingId,
      ...pin,
      captureRequestKey,
      captureFingerprint: digest(r['request_fingerprint']),
      preservation: r['preservation'] as ArchivePublication['preservation'],
      counts: object(r['counts']) as Record<string, number>,
      capabilities,
      gaps,
      currentOriginal: 'not-checked',
    };
    if (
      p.preservation === 'incomplete' &&
      !gaps.some((g) => g.kind === 'unavailable')
    )
      gaps.push({
        kind: 'unavailable',
        subject: o.source.id,
        detail: 'Original preservation incomplete',
      });
    validatePublication(p);
    publicationPath = join(
      o.task.directory,
      `archive-publication-${bindingId}.json`,
    );
    await publishJson(publicationPath, p);
    const outcome: ArchiveIntakeOutcome = {
      status: 'published',
      publicationPath,
      preservation: p.preservation,
      gaps,
      attemptPath,
      resultPath,
    };
    await publishJson(resultPath, outcome);
    return outcome;
  } catch (error) {
    const outcome: ArchiveIntakeOutcome = {
      status: 'blocked',
      publicationPath: null,
      preservation: null,
      gaps: [
        {
          kind: 'unknown',
          subject: 'archive-intake',
          detail:
            'Capture or immutable publication refused; replay requires identical admission, key and settings.',
        },
      ],
      attemptPath,
      resultPath,
    };
    try {
      await publishJson(resultPath, {
        ...outcome,
        error: String(error).slice(0, 2048),
      });
    } catch (cause) {
      throw new ArchivePersistenceError(attemptPath, cause);
    }
    if (
      publicationPath !== null ||
      [
        'EACCES',
        'EPERM',
        'EIO',
        'ENOSPC',
        'EROFS',
        'EMFILE',
        'ENFILE',
        'ENOENT',
        'ENOTDIR',
        'ELOOP',
      ].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw new ArchivePersistenceError(attemptPath, error);
    return outcome;
  }
}
