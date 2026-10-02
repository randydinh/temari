/** Read-only inventory of visible inline Markdown image references in one archive. */
import assert from 'node:assert/strict';
import { isAbsolute, join, posix } from 'node:path';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import {
  readArchivedMarkdownForInventory,
  visibleArchivedMarkdownImages,
} from './archive-document-links.js';
import {
  canonical,
  checkBasis,
  digest,
  hash,
  integer,
  object,
  text,
} from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveVisibleImageInventoryPlan {
  readonly publicationPath: string;
  readonly paths: readonly string[];
}

export interface ArchiveVisibleImageReference {
  readonly sourcePath: string;
  readonly sourceOriginalSha256: string;
  readonly sourceRepresentationSha256: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly quoteSha256: string;
  readonly targetPath: string | null;
  readonly original: { readonly sha256: string; readonly bytes: number } | null;
  readonly gap: null | {
    readonly kind: 'missing' | 'outside' | 'unsupported';
    readonly reason: string;
  };
}

export interface ArchiveVisibleImageInventoryReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-visible-image-inventory';
  readonly policy: 'visible-inline-markdown-images-v1';
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly selectedPaths: readonly string[];
  readonly references: readonly ArchiveVisibleImageReference[];
  readonly currentOriginal: 'not-checked';
  readonly visualMeaning: 'not-evaluated';
  readonly coverage: 'inline-markdown-only';
}

function selectedPath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.startsWith('-') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'Canonical source-relative path required',
  );
  assert(/\.(?:md|markdown)$/i.test(path), 'Selected path must be Markdown');
  return path;
}

function targetPath(
  sourcePath: string,
  raw: string,
): {
  path: string | null;
  gap: ArchiveVisibleImageReference['gap'];
} {
  if (
    !raw ||
    raw.length > 4096 ||
    /[\s?#%<>\\\u0000-\u001f]/u.test(raw) ||
    raw.startsWith('//') ||
    raw.includes(':')
  )
    return {
      path: null,
      gap: { kind: 'unsupported', reason: 'nonlocal-or-modified-target' },
    };
  if (raw.startsWith('/'))
    return { path: null, gap: { kind: 'outside', reason: 'absolute-target' } };
  const normalized = posix.normalize(
    posix.join(posix.dirname(sourcePath), raw),
  );
  if (normalized === '..' || normalized.startsWith('../'))
    return {
      path: null,
      gap: { kind: 'outside', reason: 'outside-source-root' },
    };
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('-') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return {
      path: null,
      gap: { kind: 'unsupported', reason: 'invalid-target-path' },
    };
  if (!/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?|ico)$/i.test(normalized))
    return {
      path: null,
      gap: { kind: 'unsupported', reason: 'unsupported-image-extension' },
    };
  return { path: normalized, gap: null };
}

/** Metadata only. No image bytes are read through the text provider. */
export async function inventoryVisibleArchiveImages(
  input: ArchiveVisibleImageInventoryPlan,
): Promise<{
  receipt: ArchiveVisibleImageInventoryReceipt;
  receiptPath: string;
}> {
  assert.deepEqual(Object.keys(input).sort(), ['paths', 'publicationPath']);
  assert(isAbsolute(text(input.publicationPath)));
  assert(
    Array.isArray(input.paths) &&
      input.paths.length >= 1 &&
      input.paths.length <= 64,
  );
  const paths = input.paths.map(selectedPath);
  assert.equal(
    new Set(paths).size,
    paths.length,
    'Duplicate selected Markdown path',
  );

  const publicationArtifact = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(
    publicationArtifact.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Complete archived source required',
  );
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () =>
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source registration changed',
    );
  await admission();
  const provider = await createArchiveRegistrar({
    publications: [input.publicationPath],
    readScope: 'source-root',
  });

  const visible: {
    sourcePath: string;
    sourceOriginalSha256: string;
    sourceRepresentationSha256: string;
    textStart: number;
    textEnd: number;
    quoteSha256: string;
    destination: string;
  }[] = [];
  for (const path of paths) {
    const archived = await readArchivedMarkdownForInventory(
      provider,
      publication,
      path,
    );
    assert(archived, `Selected Markdown text unavailable: ${path}`);
    assert(archived.first.archive);
    const checked = await provider.revalidate(archived.first);
    assert.equal(checked.evidenceId, archived.first.id);
    checkBasis(checked, archived.first);
    assert.equal(
      checked.state,
      'unchanged',
      'Selected Markdown evidence changed',
    );
    const codePoints = Array.from(archived.body);
    assert(codePoints.length <= 65536);
    for (const image of visibleArchivedMarkdownImages(archived.body)) {
      if (image.escaped) continue;
      assert(visible.length < 256, 'Visible image reference budget exceeded');
      const start: number = Array.from(
        archived.body.slice(0, image.start),
      ).length;
      const quote = Array.from(image.quote);
      const end = start + quote.length;
      assert.equal(
        codePoints.slice(start, end).join(''),
        image.quote,
        'Image quote differs from retained Markdown span',
      );
      visible.push({
        sourcePath: path,
        sourceOriginalSha256: archived.first.sha256,
        sourceRepresentationSha256: archived.first.archive.representationSha256,
        textStart: start,
        textEnd: end,
        quoteSha256: hash(image.quote),
        destination: image.destination,
      });
    }
  }

  const originals = new Map<string, { sha256: string; bytes: number } | null>();
  let offset = 0;
  let exhausted = false;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await transport.invoke('inspect', [
      publication.source.id,
      publication.generation,
      '--manifest-sha256',
      publication.manifestSha256,
      '--offset',
      String(offset),
      '--limit',
      '20',
      '--max-bytes',
      String(transport.config.maxStdoutBytes),
    ]);
    assert.equal(page['status'], 'complete');
    assert.equal(page['source_id'], publication.source.id);
    assert.equal(page['generation'], publication.generation);
    assert.equal(page['manifest_sha256'], publication.manifestSha256);
    assert.equal(page['integrity'], 'verified');
    const documents = page['documents'];
    assert(Array.isArray(documents) && documents.length <= 20);
    for (const value of documents) {
      const document = object(value);
      const path = text(document['path']);
      assert(!originals.has(path), 'Duplicate archived document path');
      const original = document['original'];
      if (original === null) originals.set(path, null);
      else {
        const metadata = object(original);
        originals.set(path, {
          sha256: digest(metadata['sha256']),
          bytes: integer(metadata['bytes'], 0, 8 * 1024 * 1024),
        });
      }
    }
    const next = page['next_offset'];
    if (next === null) {
      exhausted = true;
      break;
    }
    const nextOffset = integer(next, offset + 1, 1000);
    assert.equal(
      nextOffset,
      offset + documents.length,
      'Archive inventory page skipped records',
    );
    offset = nextOffset;
    assert(pageNumber < 49, 'Archive inventory page budget exceeded');
  }
  assert(exhausted, 'Archive inventory did not reach terminal page');

  const references: ArchiveVisibleImageReference[] = visible.map((image) => {
    const target = targetPath(image.sourcePath, image.destination);
    const base = {
      sourcePath: image.sourcePath,
      sourceOriginalSha256: image.sourceOriginalSha256,
      sourceRepresentationSha256: image.sourceRepresentationSha256,
      textStart: image.textStart,
      textEnd: image.textEnd,
      quoteSha256: image.quoteSha256,
      targetPath: target.path,
    };
    if (target.gap) return { ...base, original: null, gap: target.gap };
    assert(target.path);
    if (!originals.has(target.path))
      return {
        ...base,
        original: null,
        gap: { kind: 'missing', reason: 'not-in-captured-generation' },
      };
    const original = originals.get(target.path);
    if (!original)
      return {
        ...base,
        original: null,
        gap: { kind: 'unsupported', reason: 'archived-original-unavailable' },
      };
    return { ...base, original, gap: null };
  });
  await admission();
  assert.equal(
    hash((await readJsonWithBytes(input.publicationPath)).bytes),
    hash(publicationArtifact.bytes),
    'Publication changed during image inventory',
  );
  const receipt: ArchiveVisibleImageInventoryReceipt = {
    schema: 1,
    kind: 'temari-archive-visible-image-inventory',
    policy: 'visible-inline-markdown-images-v1',
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath,
    publicationSha256: hash(publicationArtifact.bytes),
    selectedPaths: paths,
    references,
    currentOriginal: 'not-checked',
    visualMeaning: 'not-evaluated',
    coverage: 'inline-markdown-only',
  };
  const receiptPath = join(
    publication.task.directory,
    `archive-visible-image-inventory-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
