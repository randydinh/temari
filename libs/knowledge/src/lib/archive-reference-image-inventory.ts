/** Conservative, metadata-only inventory of simple reference-style Markdown images. */
import assert from 'node:assert/strict';
import { isAbsolute, join, posix } from 'node:path';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import { readArchivedMarkdownForInventory, visibleMarkdown } from './archive-document-links.js';
import { canonical, checkBasis, digest, hash, integer, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveReferenceImageInventoryPlan {
  readonly publicationPath: string;
  readonly paths: readonly string[];
}

export interface ArchiveReferenceImage {
  readonly sourcePath: string;
  readonly sourceOriginalSha256: string;
  readonly sourceRepresentationSha256: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly quoteSha256: string;
  readonly form: 'full' | 'collapsed';
  readonly targetPath: string | null;
  readonly original: { readonly sha256: string; readonly bytes: number } | null;
  readonly gap: null | {
    readonly kind: 'unresolved' | 'missing' | 'outside' | 'external' | 'unsupported';
    readonly reason: string;
  };
}

export interface ArchiveReferenceImageInventoryReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-reference-image-inventory';
  readonly policy: 'simple-reference-markdown-images-v1';
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly selectedPaths: readonly string[];
  readonly references: readonly ArchiveReferenceImage[];
  readonly currentOriginal: 'not-checked';
  readonly visualMeaning: 'not-evaluated';
  readonly coverage: 'simple-reference-markdown-syntax-only';
}

type Gap = ArchiveReferenceImage['gap'];
type Use = {
  start: number;
  quote: string;
  form: 'full' | 'collapsed';
  label: string;
};

function selectedPath(value: unknown): string {
  const path = text(value);
  assert(path.length <= 4096 && !isAbsolute(path) && !path.startsWith('-') &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Canonical source-relative path required');
  assert(/\.(?:md|markdown)$/i.test(path), 'Selected path must be Markdown');
  return path;
}

/** Deliberate subset: JS Unicode lowercase, not full Unicode case folding. */
function label(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function escaped(body: string, at: number): boolean {
  let slashes = 0;
  while (at - slashes > 0 && body[at - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 1;
}

function parse(body: string): { uses: Use[]; definitions: Map<string, string> } {
  const visible = visibleMarkdown(body);
  const definitions = new Map<string, string>();
  const masked = visible.split('');
  let offset = 0;
  for (const line of visible.match(/[^\n]*(?:\n|$)/g) ?? []) {
    // This adapter admits only one-line, unindented or <=3-space definitions,
    // one non-whitespace destination, and labels without nested brackets.
    const match = /^ {0,3}\[([^\[\]\r\n]+)\]:[ \t]*(\S+)[ \t]*\r?\n?$/.exec(line);
    if (match && !escaped(visible, offset + line.indexOf('['))) {
      const key = label(match[1]);
      assert(key && key.length <= 256, 'Reference label outside simple bound');
      assert(!definitions.has(key), 'Duplicate normalized reference definition');
      assert(definitions.size < 256, 'Reference definition budget exceeded');
      definitions.set(key, match[2]);
      for (let at = offset; at < offset + line.length; at++)
        if (masked[at] !== '\n' && masked[at] !== '\r') masked[at] = ' ';
    }
    offset += line.length;
  }
  const uses: Use[] = [];
  const pattern = /!\[([^\[\]\r\n]*)\]\[([^\[\]\r\n]*)\]/g;
  for (const match of masked.join('').matchAll(pattern)) {
    const start = match.index;
    if (escaped(visible, start)) continue;
    assert(uses.length < 256, 'Reference image use budget exceeded');
    assert(Array.from(match[0]).length <= 512, 'Reference image quote too long');
    const collapsed = match[2] === '';
    const key = label(collapsed ? match[1] : match[2]);
    // A syntactically visible but unsupported empty label is an explicit gap.
    uses.push({ start, quote: body.slice(start, start + match[0].length),
      form: collapsed ? 'collapsed' : 'full', label: key });
  }
  return { uses, definitions };
}

function targetPath(sourcePath: string, raw: string): { path: string | null; gap: Gap } {
  if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(raw))
    return { path: null, gap: { kind: 'external', reason: 'external-target' } };
  if (raw.startsWith('/'))
    return { path: null, gap: { kind: 'outside', reason: 'absolute-target' } };
  if (!raw || raw.length > 4096 || /[\s?#%<>\\\u0000-\u001f]/u.test(raw))
    return { path: null, gap: { kind: 'unsupported', reason: 'unsupported-target-form' } };
  const normalized = posix.normalize(posix.join(posix.dirname(sourcePath), raw));
  if (normalized === '..' || normalized.startsWith('../'))
    return { path: null, gap: { kind: 'outside', reason: 'outside-source-root' } };
  if (!normalized || normalized === '.' || normalized.startsWith('-') ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    return { path: null, gap: { kind: 'unsupported', reason: 'invalid-target-path' } };
  if (!/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?|ico)$/i.test(normalized))
    return { path: null, gap: { kind: 'unsupported', reason: 'unsupported-image-extension' } };
  return { path: normalized, gap: null };
}

/** Read only retained Markdown representations and pinned manifest metadata. */
export async function inventoryArchiveReferenceImages(input: ArchiveReferenceImageInventoryPlan): Promise<{
  receipt: ArchiveReferenceImageInventoryReceipt;
  receiptPath: string;
}> {
  assert.deepEqual(Object.keys(input).sort(), ['paths', 'publicationPath']);
  assert(isAbsolute(text(input.publicationPath)));
  assert(Array.isArray(input.paths) && input.paths.length >= 1 && input.paths.length <= 64);
  const paths = input.paths.map(selectedPath);
  assert.equal(new Set(paths).size, paths.length, 'Duplicate selected Markdown path');
  const publicationArtifact = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(publicationArtifact.bytes.toString('utf8'), canonical(publication), 'Publication bytes changed');
  assert.equal(publication.preservation, 'complete-admitted', 'Complete archived source required');
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Current source registration changed');
  await admission();
  const provider = await createArchiveRegistrar({ publications: [input.publicationPath], readScope: 'source-root' });
  const pending: (Omit<ArchiveReferenceImage, 'targetPath' | 'original' | 'gap'> & { raw: string | null })[] = [];
  for (const path of paths) {
    const archived = await readArchivedMarkdownForInventory(provider, publication, path);
    assert(archived, `Selected Markdown text unavailable: ${path}`);
    assert(archived.first.archive);
    const checked = await provider.revalidate(archived.first);
    assert.equal(checked.evidenceId, archived.first.id);
    checkBasis(checked, archived.first);
    assert.equal(checked.state, 'unchanged', 'Selected Markdown evidence changed');
    const points = Array.from(archived.body);
    assert(points.length <= 65536, 'Selected Markdown code point bound exceeded');
    const parsed = parse(archived.body);
    for (const use of parsed.uses) {
      assert(pending.length < 256, 'Reference image use budget exceeded');
      const textStart: number = Array.from(archived.body.slice(0, use.start)).length;
      const textEnd: number = textStart + Array.from(use.quote).length;
      assert.equal(points.slice(textStart, textEnd).join(''), use.quote,
        'Reference quote differs from retained Markdown span');
      pending.push({
        sourcePath: path,
        sourceOriginalSha256: archived.first.sha256,
        sourceRepresentationSha256: archived.first.archive.representationSha256,
        textStart, textEnd, quoteSha256: hash(use.quote), form: use.form,
        raw: parsed.definitions.get(use.label) ?? null,
      });
    }
  }
  const originals = new Map<string, { sha256: string; bytes: number } | null>();
  let offset = 0, exhausted = false, rows = 0;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await transport.invoke('inspect', [
      publication.source.id, publication.generation, '--manifest-sha256',
      publication.manifestSha256, '--offset', String(offset), '--limit', '20',
      '--max-bytes', String(transport.config.maxStdoutBytes),
    ]);
    assert.equal(page['status'], 'complete');
    assert.equal(page['source_id'], publication.source.id);
    assert.equal(page['generation'], publication.generation);
    assert.equal(page['manifest_sha256'], publication.manifestSha256);
    assert.equal(page['integrity'], 'verified');
    const documents = page['documents'];
    assert(Array.isArray(documents) && documents.length <= 20);
    rows += documents.length;
    assert(rows <= 1000, 'Archive manifest row budget exceeded');
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
    if (next === null) { exhausted = true; break; }
    const nextOffset = integer(next, offset + 1, 1000);
    assert.equal(nextOffset, offset + documents.length, 'Archive inventory page skipped records');
    offset = nextOffset;
  }
  assert(exhausted, 'Archive inventory did not reach terminal page');
  const references: ArchiveReferenceImage[] = pending.map(({ raw, ...item }) => {
    if (raw === null) return { ...item, targetPath: null, original: null,
      gap: { kind: 'unresolved', reason: 'no-simple-definition' } };
    const target = targetPath(item.sourcePath, raw);
    if (target.gap) return { ...item, targetPath: target.path, original: null, gap: target.gap };
    assert(target.path);
    if (!originals.has(target.path)) return { ...item, targetPath: target.path, original: null,
      gap: { kind: 'missing', reason: 'not-in-captured-generation' } };
    const original = originals.get(target.path);
    if (!original) return { ...item, targetPath: target.path, original: null,
      gap: { kind: 'unsupported', reason: 'archived-original-unavailable' } };
    return { ...item, targetPath: target.path, original, gap: null };
  });
  await admission();
  assert.equal(hash((await readJsonWithBytes(input.publicationPath)).bytes), hash(publicationArtifact.bytes),
    'Publication changed during reference image inventory');
  const receipt: ArchiveReferenceImageInventoryReceipt = {
    schema: 1, kind: 'temari-archive-reference-image-inventory',
    policy: 'simple-reference-markdown-images-v1', sourceId: publication.source.id,
    generation: publication.generation, manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath, publicationSha256: hash(publicationArtifact.bytes),
    selectedPaths: paths, references, currentOriginal: 'not-checked',
    visualMeaning: 'not-evaluated', coverage: 'simple-reference-markdown-syntax-only',
  };
  const receiptPath = join(publication.task.directory,
    `archive-reference-image-inventory-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
