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
      path > prior && !seen.has(path),
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
  assert(seen.size <= 1000, 'Currentness document budget exceeded');
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
