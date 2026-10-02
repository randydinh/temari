/** Conservative, metadata-only inventory of simple raw-HTML img tags in archived Markdown. */
import assert from 'node:assert/strict';
import { isAbsolute, join, posix } from 'node:path';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import { readArchivedMarkdownForInventory, visibleMarkdown } from './archive-document-links.js';
import { canonical, checkBasis, digest, hash, integer, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveMarkdownHtmlImageInventoryPlan {
  readonly publicationPath: string;
  readonly paths: readonly string[];
}

export interface ArchiveMarkdownHtmlImage {
  readonly sourcePath: string;
  readonly sourceOriginalSha256: string;
  readonly sourceRepresentationSha256: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly quoteSha256: string;
  readonly targetPath: string | null;
  readonly original: { readonly sha256: string; readonly bytes: number } | null;
  readonly gap: null | {
    readonly kind: 'missing' | 'outside' | 'external' | 'unsupported' | 'malformed';
    readonly reason: string;
  };
}

export interface ArchiveMarkdownHtmlImageInventoryReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-markdown-html-image-inventory';
  readonly policy: 'simple-markdown-html-img-v1';
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly selectedPaths: readonly string[];
  readonly images: readonly ArchiveMarkdownHtmlImage[];
  readonly currentOriginal: 'not-checked';
  readonly visualMeaning: 'not-evaluated';
  readonly coverage: 'simple-single-line-markdown-html-img-syntax-only';
}

type Gap = ArchiveMarkdownHtmlImage['gap'];
type Candidate = { start: number; quote: string; raw: string | null; gap: Gap };

function selectedPath(value: unknown): string {
  const path = text(value);
  assert(path.length <= 4096 && !isAbsolute(path) && !path.startsWith('-') &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Canonical source-relative path required');
  assert(/\.(?:md|markdown)$/i.test(path), 'Selected path must be Markdown');
  return path;
}

function targetPath(sourcePath: string, raw: string): { path: string | null; gap: Gap } {
  if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(raw))
    return { path: null, gap: { kind: 'external', reason: 'external-target' } };
  if (raw.startsWith('/'))
    return { path: null, gap: { kind: 'outside', reason: 'absolute-target' } };
  if (!raw || raw.length > 4096 || /[\s?#%<>&\\\u0000-\u001f]/u.test(raw))
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

function attributes(quote: string): { raw: string | null; gap: Gap } {
  if (!quote.endsWith('>'))
    return { raw: null, gap: { kind: 'malformed', reason: 'unterminated-tag' } };
  if (Array.from(quote).length > 1024)
    throw new Error('HTML img tag length budget exceeded');
  let body = quote.slice(4, -1);
  if (/\/\s*$/u.test(body)) body = body.replace(/\/\s*$/u, '');
  let at = 0;
  const seen = new Set<string>();
  let raw: string | null = null;
  while (at < body.length) {
    const space = /^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '';
    at += space.length;
    if (at === body.length) break;
    if (!space) return { raw: null, gap: { kind: 'malformed', reason: 'invalid-attribute-spacing' } };
    const name = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(body.slice(at))?.[0];
    if (!name) return { raw: null, gap: { kind: 'malformed', reason: 'invalid-attribute' } };
    at += name.length;
    const key = name.toLowerCase();
    const pad = /^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '';
    let value: string | null = null;
    let quotation: string | null = null;
    if (body[at + pad.length] === '=') {
      at += pad.length + 1;
      at += (/^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '').length;
      quotation = body[at] ?? null;
      if (quotation !== '"' && quotation !== "'")
        return { raw: null, gap: { kind: 'unsupported', reason: 'unquoted-attribute' } };
      const end = body.indexOf(quotation, ++at);
      if (end < 0) return { raw: null, gap: { kind: 'malformed', reason: 'unterminated-attribute' } };
      value = body.slice(at, end);
      at = end + 1;
    }
    if (seen.has(key) && key === 'src') throw new Error('Duplicate HTML img src attribute');
    seen.add(key);
    if (key === 'src') {
      if (quotation !== '"' || value === null)
        return { raw: null, gap: { kind: 'unsupported', reason: 'src-must-be-double-quoted' } };
      raw = value;
    }
  }
  if (seen.has('srcset'))
    return { raw: null, gap: { kind: 'unsupported', reason: 'srcset-selection-unsupported' } };
  if (raw === null) return { raw: null, gap: { kind: 'malformed', reason: 'src-attribute-missing' } };
  return { raw, gap: null };
}

/** First mask candidates as inert same-length text, then reuse Markdown visibility masking. */
function candidates(body: string): Candidate[] {
  const spans: { start: number; end: number; quote: string }[] = [];
  const masked = body.split('');
  const pattern = /<img(?=[ \t\r/>])/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const start = match.index;
    const lineEnd = body.indexOf('\n', start);
    const limit = lineEnd < 0 ? body.length : lineEnd;
    let quotation: string | null = null;
    let end = limit;
    for (let at = start + match[0].length; at < limit; at++) {
      if (quotation) {
        if (body[at] === quotation) quotation = null;
      } else if (body[at] === '"' || body[at] === "'") quotation = body[at];
      else if (body[at] === '>') { end = at + 1; break; }
    }
    const quote = body.slice(start, end);
    spans.push({ start, end, quote });
    for (let at = start; at < end; at++) if (masked[at] !== '\r') masked[at] = 'x';
    pattern.lastIndex = end;
  }
  const visible = visibleMarkdown(masked.join(''));
  const found: Candidate[] = [];
  for (const span of spans) {
    if (visible[span.start] === ' ') continue;
    let slashes = 0;
    while (span.start - slashes > 0 && body[span.start - slashes - 1] === '\\') slashes++;
    if (slashes % 2 === 1) continue;
    const lineStart = body.lastIndexOf('\n', span.start - 1) + 1;
    const lineEnd = body.indexOf('\n', span.start);
    const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
    if (/<!(?:\[|doctype\b)|<\?/iu.test(line)) continue;
    if (body.lastIndexOf('<![CDATA[', span.start) > body.lastIndexOf(']]>', span.start)) continue;
    if (body.lastIndexOf('<?', span.start) > body.lastIndexOf('?>', span.start)) continue;
    const declarationStart = body.toLowerCase().lastIndexOf('<!doctype', span.start);
    if (declarationStart >= 0) {
      const declarationPrefix = body.slice(declarationStart, span.start);
      if (!declarationPrefix.includes('>') ||
          (declarationPrefix.includes('[') && !declarationPrefix.includes(']>'))) continue;
    }
    assert(found.length < 256, 'HTML img tag count budget exceeded');
    assert(Array.from(span.quote).length <= 1024, 'HTML img tag length budget exceeded');
    const parsed = attributes(span.quote);
    found.push({ start: span.start, quote: span.quote, ...parsed });
  }
  return found;
}

/** Read retained Markdown text and pinned manifest metadata only. */
export async function inventoryArchiveMarkdownHtmlImages(input: ArchiveMarkdownHtmlImageInventoryPlan): Promise<{
  receipt: ArchiveMarkdownHtmlImageInventoryReceipt;
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
  const pending: (Omit<ArchiveMarkdownHtmlImage, 'targetPath' | 'original' | 'gap'> &
    { raw: string | null; gap: Gap })[] = [];
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
    for (const image of candidates(archived.body)) {
      assert(pending.length < 256, 'HTML img tag count budget exceeded');
      const textStart: number = Array.from(archived.body.slice(0, image.start)).length;
      const textEnd: number = textStart + Array.from(image.quote).length;
      assert.equal(points.slice(textStart, textEnd).join(''), image.quote,
        'HTML img quote differs from retained Markdown span');
      pending.push({ sourcePath: path, sourceOriginalSha256: archived.first.sha256,
        sourceRepresentationSha256: archived.first.archive.representationSha256,
        textStart, textEnd, quoteSha256: hash(image.quote), raw: image.raw, gap: image.gap });
    }
  }
  const originals = new Map<string, { sha256: string; bytes: number } | null>();
  let offset = 0, exhausted = false, rows = 0;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await transport.invoke('inspect', [publication.source.id, publication.generation,
      '--manifest-sha256', publication.manifestSha256, '--offset', String(offset),
      '--limit', '20', '--max-bytes', String(transport.config.maxStdoutBytes)]);
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
        originals.set(path, { sha256: digest(metadata['sha256']),
          bytes: integer(metadata['bytes'], 0, 8 * 1024 * 1024) });
      }
    }
    const next = page['next_offset'];
    if (next === null) { exhausted = true; break; }
    const nextOffset = integer(next, offset + 1, 1000);
    assert.equal(nextOffset, offset + documents.length, 'Archive inventory page skipped records');
    offset = nextOffset;
  }
  assert(exhausted, 'Archive inventory did not reach terminal page');
  const images: ArchiveMarkdownHtmlImage[] = pending.map(({ raw, gap, ...item }) => {
    if (gap) return { ...item, targetPath: null, original: null, gap };
    assert(raw !== null);
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
    'Publication changed during HTML image inventory');
  const receipt: ArchiveMarkdownHtmlImageInventoryReceipt = {
    schema: 1, kind: 'temari-archive-markdown-html-image-inventory',
    policy: 'simple-markdown-html-img-v1', sourceId: publication.source.id,
    generation: publication.generation, manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath, publicationSha256: hash(publicationArtifact.bytes),
    selectedPaths: paths, images, currentOriginal: 'not-checked',
    visualMeaning: 'not-evaluated', coverage: 'simple-single-line-markdown-html-img-syntax-only',
  };
  const receiptPath = join(publication.task.directory,
    `archive-markdown-html-image-inventory-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
