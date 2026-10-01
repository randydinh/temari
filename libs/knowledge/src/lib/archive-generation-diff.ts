/** An explicit comparison of two immutable, admitted Registrar generations. */
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
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
  type ArchivePublication,
} from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveGenerationDiffOptions {
  readonly beforePublicationPath: string;
  readonly afterPublicationPath: string;
}

export interface ArchiveGenerationDiffPin {
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly generation: string;
  readonly manifestSha256: string;
}

export interface ArchiveGenerationDiffReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-generation-diff';
  readonly policy: 'pinned-retained-original-sha256-v1';
  readonly sourceId: string;
  readonly before: ArchiveGenerationDiffPin;
  readonly after: ArchiveGenerationDiffPin;
  readonly added: readonly {
    readonly path: string;
    readonly afterSha256: string;
  }[];
  readonly removed: readonly {
    readonly path: string;
    readonly beforeSha256: string;
  }[];
  readonly changed: readonly {
    readonly path: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[];
  readonly unchanged: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly unchanged: number;
  };
  readonly currentOriginal: 'not-checked';
}

async function pinnedPublication(path: string) {
  assert(
    typeof path === 'string' && isAbsolute(path),
    'Absolute publication path required',
  );
  const bytes = await readJsonWithBytes(path);
  const publication = await loadArchivePublication(path);
  assert.equal(
    bytes.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed during validation',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Only complete-admitted generations may be compared',
  );
  return { path, sha256: hash(bytes.bytes), publication };
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
    'Invalid archived relative path',
  );
  return path;
}

async function retainedOriginals(
  publication: ArchivePublication,
  transport: Awaited<ReturnType<typeof archiveTransport>>,
): Promise<Map<string, string>> {
  const originals = new Map<string, string>();
  const allPaths = new Set<string>();
  const statuses = new Map<string, number>();
  const expectedTotal = Object.values(publication.counts).reduce(
    (total, count) => total + integer(count, 0, 1000),
    0,
  );
  assert(expectedTotal <= 1000, 'Archive document budget exceeded');
  let offset = 0;
  for (;;) {
    const page = await transport.invoke('inspect', [
      publication.source.id,
      publication.generation,
      '--manifest-sha256',
      publication.manifestSha256,
      '--offset',
      String(offset),
      '--limit',
      '100',
      '--max-bytes',
      '1048576',
    ]);
    snapshot(page, publication);
    assert.equal(page['status'], 'complete');
    assert.equal(page['request_key'], publication.captureRequestKey);
    assert.equal(
      digest(page['request_fingerprint']),
      publication.captureFingerprint,
    );
    assert.equal(page['preservation'], publication.preservation);
    assert.equal(canonical(page['counts']), canonical(publication.counts));
    const documents = list(page['documents']);
    assert(
      documents.length <= 100 && offset + documents.length <= expectedTotal,
      'Archive inspect page exceeds document budget',
    );
    for (const raw of documents) {
      const item = object(raw);
      const path = relativePath(item['path']);
      assert(!allPaths.has(path), 'Duplicate archived document path');
      allPaths.add(path);
      const status = text(item['status']);
      assert(
        ['captured', 'excluded', 'unsupported'].includes(status),
        'Incomplete archived document encountered',
      );
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (status === 'captured') {
        const original = object(item['original']);
        originals.set(path, digest(original['sha256']));
        integer(original['bytes'], 0, 8 * 1024 * 1024);
      } else {
        assert.equal(
          item['original'],
          null,
          'Noncaptured archived document has an original',
        );
      }
    }
    const next = page['next_offset'];
    if (next === null) {
      assert.equal(
        offset + documents.length,
        expectedTotal,
        'Archive inspect ended before all documents were checked',
      );
      break;
    }
    assert(documents.length > 0, 'Archive inspect made no progress');
    assert.equal(
      integer(next, offset + 1, 1000),
      offset + documents.length,
      'Archive inspect skipped or repeated documents',
    );
    offset = next as number;
  }
  for (const [status, count] of Object.entries(publication.counts))
    assert.equal(
      statuses.get(status) ?? 0,
      count,
      `Archived ${status} count changed`,
    );
  return originals;
}

/** Compare retained original bytes by metadata only; never recapture or read live files. */
export async function diffArchiveGenerations(
  options: ArchiveGenerationDiffOptions,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveGenerationDiffReceipt;
}> {
  assert.deepEqual(Object.keys(options).sort(), [
    'afterPublicationPath',
    'beforePublicationPath',
  ]);
  assert.notEqual(
    options.beforePublicationPath,
    options.afterPublicationPath,
    'Two distinct publication paths required',
  );
  const [beforePin, afterPin] = await Promise.all([
    pinnedPublication(options.beforePublicationPath),
    pinnedPublication(options.afterPublicationPath),
  ]);
  const before = beforePin.publication;
  const after = afterPin.publication;
  assert.equal(
    canonical(before.source),
    canonical(after.source),
    'One registered source required',
  );
  assert.equal(
    before.registration,
    after.registration,
    'Publication registrations differ',
  );
  assert.equal(
    canonical(before.transport),
    canonical(after.transport),
    'One Registrar workspace and transport required',
  );
  assert.equal(
    before.implementation,
    after.implementation,
    'Publication implementations differ',
  );
  assert.equal(
    before.protocolSha256,
    after.protocolSha256,
    'Publication protocols differ',
  );
  assert.notEqual(
    before.generation,
    after.generation,
    'Two distinct archive generations required',
  );
  const transport = await archiveTransport(before.transport);
  assert.equal(
    transport.implementation,
    before.implementation,
    'Publication implementation changed',
  );
  assert.equal(
    transport.protocolSha256,
    before.protocolSha256,
    'Publication protocol changed',
  );
  assert.equal(
    await registrationFor(transport, before.source),
    before.registration,
    'Current source admission changed',
  );
  const oldOriginals = await retainedOriginals(before, transport);
  const newOriginals = await retainedOriginals(after, transport);
  assert.equal(
    await registrationFor(transport, before.source),
    before.registration,
    'Current source admission changed during comparison',
  );
  const added: { path: string; afterSha256: string }[] = [];
  const removed: { path: string; beforeSha256: string }[] = [];
  const changed: { path: string; beforeSha256: string; afterSha256: string }[] =
    [];
  const unchanged: { path: string; sha256: string }[] = [];
  for (const path of [
    ...new Set([...oldOriginals.keys(), ...newOriginals.keys()]),
  ].sort()) {
    const oldSha = oldOriginals.get(path);
    const newSha = newOriginals.get(path);
    if (oldSha === undefined) added.push({ path, afterSha256: newSha! });
    else if (newSha === undefined) removed.push({ path, beforeSha256: oldSha });
    else if (oldSha === newSha) unchanged.push({ path, sha256: oldSha });
    else changed.push({ path, beforeSha256: oldSha, afterSha256: newSha });
  }
  const pin = (value: typeof beforePin): ArchiveGenerationDiffPin => ({
    publicationPath: value.path,
    publicationSha256: value.sha256,
    generation: value.publication.generation,
    manifestSha256: value.publication.manifestSha256,
  });
  const receipt: ArchiveGenerationDiffReceipt = {
    schema: 1,
    kind: 'temari-archive-generation-diff',
    policy: 'pinned-retained-original-sha256-v1',
    sourceId: before.source.id,
    before: pin(beforePin),
    after: pin(afterPin),
    added,
    removed,
    changed,
    unchanged,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
    currentOriginal: 'not-checked',
  };
  // A publication may contain 1000 long paths. Refuse oversized receipts
  // instead of publishing a truncated comparison as if it were complete.
  assert(
    Buffer.byteLength(canonical(receipt)) <= 1_048_576,
    'Generation diff receipt exceeds durable artifact budget',
  );
  const [finalBefore, finalAfter] = await Promise.all([
    pinnedPublication(beforePin.path),
    pinnedPublication(afterPin.path),
  ]);
  assert.equal(
    finalBefore.sha256,
    beforePin.sha256,
    'Before publication changed during comparison',
  );
  assert.equal(
    finalAfter.sha256,
    afterPin.sha256,
    'After publication changed during comparison',
  );
  const receiptPath = join(
    after.task.directory,
    `archive-generation-diff-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
