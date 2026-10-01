/** Bounded point-in-time comparison of one pinned archive with its local source. */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import {
  canonical,
  digest,
  hash,
  integer,
  list,
  object,
  text,
} from './codec.js';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveCurrentnessInput {
  readonly publicationPath: string;
}

type Original = { readonly sha256: string; readonly bytes: number };
type Pair = {
  readonly path: string;
  readonly archived: Original;
  readonly current: Original;
};
type Unavailable = {
  readonly path: string;
  readonly reason: string;
  readonly archived?: Original;
  readonly current?: { readonly bytes: number };
};

export interface ArchiveCurrentnessReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-currentness-audit';
  readonly status: 'complete' | 'partial';
  readonly policy: 'pinned-point-in-time-local-originals-v1';
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly observedAt: string;
  readonly consistency: 'declared-selection-not-atomic';
  readonly evidence: 'point-in-time-local-observation';
  readonly added: readonly {
    readonly path: string;
    readonly current: Original;
  }[];
  readonly removed: readonly {
    readonly path: string;
    readonly archived: Original;
  }[];
  readonly changed: readonly Pair[];
  readonly unchanged: readonly Pair[];
  readonly unavailable: readonly Unavailable[];
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly unavailable: number;
  };
  readonly currentOriginal: 'observed-point-in-time';
}

export type ArchiveCurrentnessPagedReceipt = Omit<
  ArchiveCurrentnessReceipt,
  'policy'
> & {
  readonly policy: 'pinned-point-in-time-local-originals-paged-v1';
  readonly auditId: string;
};

function relativePath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'Invalid currentness path',
  );
  return path;
}

/** Match Python's Unicode scalar ordering for Registrar relative paths. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (character) => character.codePointAt(0)!);
  const right = Array.from(b, (character) => character.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function original(value: unknown): Original {
  const item = object(value);
  assert.deepEqual(Object.keys(item).sort(), ['bytes', 'sha256']);
  return {
    sha256: digest(item['sha256']),
    bytes: integer(item['bytes'], 0, 8 * 1024 * 1024),
  };
}

function readRows<T>(
  raw: unknown,
  seen: Set<string>,
  parse: (row: Record<string, unknown>, path: string) => T,
): T[] {
  const rows = list(raw);
  assert(rows.length <= 1000, 'Currentness category exceeds document budget');
  const result: T[] = [];
  let prior = '';
  for (const value of rows) {
    const row = object(value);
    const path = relativePath(row['path']);
    assert(
      compareCodePoints(path, prior) > 0 && !seen.has(path),
      'Currentness paths are duplicated or unsorted',
    );
    prior = path;
    seen.add(path);
    result.push(parse(row, path));
  }
  return result;
}

/** Audit one complete archived capture against the currently admitted local root. */
export async function auditArchiveCurrentness(
  input: ArchiveCurrentnessInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveCurrentnessReceipt;
}> {
  assert.deepEqual(Object.keys(input), ['publicationPath']);
  assert(
    typeof input.publicationPath === 'string' &&
      isAbsolute(input.publicationPath),
  );
  const before = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(
    before.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Complete archive required',
  );
  const publicationSha256 = hash(before.bytes);
  const transport = await archiveTransport(publication.transport);
  assert.equal(
    transport.implementation,
    publication.implementation,
    'Archive implementation changed',
  );
  assert.equal(
    transport.protocolSha256,
    publication.protocolSha256,
    'Archive protocol changed',
  );
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed',
  );
  const response = await transport.invoke('audit-current', [
    publication.source.id,
    publication.generation,
    '--manifest-sha256',
    publication.manifestSha256,
    '--max-bytes',
    '1048576',
  ]);
  assert.equal(response['kind'], 'archive-currentness-audit');
  assert.equal(response['source_id'], publication.source.id);
  assert.equal(response['generation'], publication.generation);
  assert.equal(digest(response['manifest_sha256']), publication.manifestSha256);
  assert.equal(response['consistency'], 'declared-selection-not-atomic');
  assert.equal(response['evidence'], 'point-in-time-local-observation');
  const observedAt = text(response['observed_at']);
  assert(
    Number.isFinite(Date.parse(observedAt)) && observedAt.length <= 64,
    'Invalid observation time',
  );
  const seen = new Set<string>();
  const added = readRows(response['added'], seen, (row, path) => {
    assert.deepEqual(Object.keys(row).sort(), ['current', 'path']);
    return { path, current: original(row['current']) };
  });
  const removed = readRows(response['removed'], seen, (row, path) => {
    assert.deepEqual(Object.keys(row).sort(), ['archived', 'path']);
    return { path, archived: original(row['archived']) };
  });
  const readPair = (row: Record<string, unknown>, path: string): Pair => {
    assert.deepEqual(Object.keys(row).sort(), ['archived', 'current', 'path']);
    return {
      path,
      archived: original(row['archived']),
      current: original(row['current']),
    };
  };
  const changed = readRows(response['changed'], seen, readPair);
  const unchanged = readRows(response['unchanged'], seen, readPair);
  for (const item of changed)
    assert.notEqual(item.archived.sha256, item.current.sha256);
  for (const item of unchanged) assert.deepEqual(item.archived, item.current);
  const unavailable = readRows(
    response['unavailable'],
    seen,
    (row, path): Unavailable => {
      assert.deepEqual(
        Object.keys(row).sort(),
        row['archived'] === undefined
          ? row['current'] === undefined
            ? ['path', 'reason']
            : ['current', 'path', 'reason']
          : row['current'] === undefined
            ? ['archived', 'path', 'reason']
            : ['archived', 'current', 'path', 'reason'],
      );
      const reason = text(row['reason']);
      assert(reason.length <= 128, 'Invalid currentness gap reason');
      const archived =
        row['archived'] === undefined
          ? {}
          : { archived: original(row['archived']) };
      let currentPart: { current?: { bytes: number } } = {};
      if (row['current'] !== undefined) {
        const current = object(row['current']);
        assert.deepEqual(Object.keys(current), ['bytes']);
        currentPart = {
          current: {
            bytes: integer(current['bytes'], 0, Number.MAX_SAFE_INTEGER),
          },
        };
      }
      return { path, reason, ...archived, ...currentPart };
    },
  );
  assert(seen.size <= 2000, 'Currentness document budget exceeded');
  const status = text(response['status']);
  assert(status === 'complete' || status === 'partial');
  assert.equal(
    status === 'partial',
    unavailable.length > 0,
    'Currentness status does not match unknown files',
  );
  const receipt: ArchiveCurrentnessReceipt = {
    schema: 1,
    kind: 'temari-archive-currentness-audit',
    status,
    policy: 'pinned-point-in-time-local-originals-v1',
    publicationPath: input.publicationPath,
    publicationSha256,
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    observedAt,
    consistency: 'declared-selection-not-atomic',
    evidence: 'point-in-time-local-observation',
    added,
    removed,
    changed,
    unchanged,
    unavailable,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      unavailable: unavailable.length,
    },
    currentOriginal: 'observed-point-in-time',
  };
  assert(
    Buffer.byteLength(canonical(receipt)) <= 1_048_576,
    'Currentness receipt exceeds durable artifact budget',
  );
  const final = await readJsonWithBytes(input.publicationPath);
  assert.equal(
    hash(final.bytes),
    publicationSha256,
    'Publication changed during audit',
  );
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed during audit',
  );
  const receiptPath = join(
    publication.task.directory,
    `archive-currentness-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}

/** Page one stored Registrar observation; source bytes are scanned only at audit-start. */
export async function auditArchiveCurrentnessPaged(
  input: ArchiveCurrentnessInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveCurrentnessPagedReceipt;
}> {
  assert.deepEqual(Object.keys(input), ['publicationPath']);
  assert(
    typeof input.publicationPath === 'string' &&
      isAbsolute(input.publicationPath),
  );
  const pageLimit = 200;
  const initial = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(
    initial.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Complete archive required',
  );
  const publicationSha256 = hash(initial.bytes);
  const transport = await archiveTransport(publication.transport);
  assert.equal(
    transport.implementation,
    publication.implementation,
    'Archive implementation changed',
  );
  assert.equal(
    transport.protocolSha256,
    publication.protocolSha256,
    'Archive protocol changed',
  );
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed',
  );
  const pinArgs = [
    publication.source.id,
    publication.generation,
    '--manifest-sha256',
    publication.manifestSha256,
  ];
  const start = await transport.invoke('audit-start', pinArgs);
  assert.equal(start['kind'], 'archive-currentness-audit-start');
  assert.equal(start['source_id'], publication.source.id);
  assert.equal(start['generation'], publication.generation);
  assert.equal(digest(start['manifest_sha256']), publication.manifestSha256);
  assert.equal(start['consistency'], 'declared-selection-not-atomic');
  assert.equal(start['evidence'], 'point-in-time-local-observation');
  const auditId = digest(start['audit_id']);
  const observedAt = text(start['observed_at']);
  assert(
    Number.isFinite(Date.parse(observedAt)) && observedAt.length <= 64,
    'Invalid observation time',
  );
  const status = text(start['status']);
  assert(status === 'complete' || status === 'partial');
  const total = integer(start['total'], 0, 2000);
  const rawCounts = object(start['counts']);
  const categories = [
    'added',
    'removed',
    'changed',
    'unchanged',
    'unavailable',
  ] as const;
  assert.deepEqual(Object.keys(rawCounts).sort(), [...categories].sort());
  const counts = {
    added: integer(rawCounts['added'], 0, 1000),
    removed: integer(rawCounts['removed'], 0, 1000),
    changed: integer(rawCounts['changed'], 0, 1000),
    unchanged: integer(rawCounts['unchanged'], 0, 1000),
    unavailable: integer(rawCounts['unavailable'], 0, 1000),
  };
  assert.equal(
    Object.values(counts).reduce((sum, n) => sum + n, 0),
    total,
  );
  assert.equal(status === 'partial', counts.unavailable > 0);
  const rawRows: Record<
    (typeof categories)[number],
    Record<string, unknown>[]
  > = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    unavailable: [],
  };
  let cursor: string | null = null;
  let offset = 0;
  let lastPath = '';
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < Math.max(1, total); pageNumber++) {
    const args = [
      publication.source.id,
      publication.generation,
      auditId,
      '--manifest-sha256',
      publication.manifestSha256,
      '--limit',
      String(pageLimit),
      '--max-bytes',
      String(transport.config.maxStdoutBytes),
    ];
    if (cursor !== null) args.push('--cursor', cursor);
    const page = await transport.invoke('audit-page', args);
    assert.equal(page['kind'], 'archive-currentness-audit-page');
    assert.equal(page['source_id'], publication.source.id);
    assert.equal(page['generation'], publication.generation);
    assert.equal(digest(page['manifest_sha256']), publication.manifestSha256);
    assert.equal(digest(page['audit_id']), auditId);
    assert.equal(page['status'], status);
    assert.equal(page['total'], total);
    assert.equal(canonical(page['counts']), canonical(counts));
    assert.equal(page['observed_at'], observedAt);
    assert.equal(page['consistency'], 'declared-selection-not-atomic');
    assert.equal(page['evidence'], 'point-in-time-local-observation');
    assert.equal(page['offset'], offset, 'Audit page skipped or repeated rows');
    const rows = list(page['rows']);
    assert(
      rows.length <= pageLimit && offset + rows.length <= total,
      'Audit page exceeds record budget',
    );
    for (const item of rows) {
      const row = object(item);
      const category = text(row['kind']);
      assert(
        categories.includes(category as (typeof categories)[number]),
        'Unknown audit category',
      );
      const path = relativePath(row['path']);
      assert(
        compareCodePoints(path, lastPath) > 0,
        'Audit page paths are duplicated or unsorted',
      );
      lastPath = path;
      const { kind: _kind, ...entry } = row;
      rawRows[category as (typeof categories)[number]].push(entry);
    }
    offset += rows.length;
    const next = page['next_cursor'];
    if (next === null) {
      assert.equal(offset, total, 'Audit pages ended before all rows');
      break;
    }
    assert(rows.length > 0 && offset < total, 'Audit page made no progress');
    cursor = text(next);
    assert(
      cursor.length <= 2048 && !seenCursors.has(cursor),
      'Audit cursor repeated or exceeded bound',
    );
    seenCursors.add(cursor);
  }
  assert.equal(offset, total, 'Audit page budget exhausted');
  const seen = new Set<string>();
  const added = readRows(rawRows.added, seen, (row, path) => {
    assert.deepEqual(Object.keys(row).sort(), ['current', 'path']);
    return { path, current: original(row['current']) };
  });
  const removed = readRows(rawRows.removed, seen, (row, path) => {
    assert.deepEqual(Object.keys(row).sort(), ['archived', 'path']);
    return { path, archived: original(row['archived']) };
  });
  const pair = (row: Record<string, unknown>, path: string): Pair => {
    assert.deepEqual(Object.keys(row).sort(), ['archived', 'current', 'path']);
    return {
      path,
      archived: original(row['archived']),
      current: original(row['current']),
    };
  };
  const changed = readRows(rawRows.changed, seen, pair);
  const unchanged = readRows(rawRows.unchanged, seen, pair);
  for (const row of changed)
    assert.notEqual(row.archived.sha256, row.current.sha256);
  for (const row of unchanged) assert.deepEqual(row.archived, row.current);
  const unavailable = readRows(
    rawRows.unavailable,
    seen,
    (row, path): Unavailable => {
      const reason = text(row['reason']);
      assert(reason.length <= 128, 'Invalid currentness gap reason');
      const keys = [
        'path',
        'reason',
        ...(row['archived'] === undefined ? [] : ['archived']),
        ...(row['current'] === undefined ? [] : ['current']),
      ].sort();
      assert.deepEqual(Object.keys(row).sort(), keys);
      const archived =
        row['archived'] === undefined
          ? {}
          : { archived: original(row['archived']) };
      let current: { current?: { bytes: number } } = {};
      if (row['current'] !== undefined) {
        const value = object(row['current']);
        assert.deepEqual(Object.keys(value), ['bytes']);
        current = {
          current: {
            bytes: integer(value['bytes'], 0, Number.MAX_SAFE_INTEGER),
          },
        };
      }
      return { path, reason, ...archived, ...current };
    },
  );
  assert.deepEqual(
    {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      unavailable: unavailable.length,
    },
    counts,
  );
  const receipt: ArchiveCurrentnessPagedReceipt = {
    schema: 1,
    kind: 'temari-archive-currentness-audit',
    status,
    policy: 'pinned-point-in-time-local-originals-paged-v1',
    publicationPath: input.publicationPath,
    publicationSha256,
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    auditId,
    observedAt,
    consistency: 'declared-selection-not-atomic',
    evidence: 'point-in-time-local-observation',
    added,
    removed,
    changed,
    unchanged,
    unavailable,
    counts,
    currentOriginal: 'observed-point-in-time',
  };
  assert(
    Buffer.byteLength(canonical(receipt)) <= 8 * 1_048_576,
    'Paged audit receipt exceeds durable artifact budget',
  );
  const final = await readJsonWithBytes(input.publicationPath);
  assert.equal(
    hash(final.bytes),
    publicationSha256,
    'Publication changed during audit',
  );
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed during audit',
  );
  const receiptPath = join(
    publication.task.directory,
    `archive-currentness-paged-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt, 8 * 1_048_576);
  return { receiptPath, receipt };
}
