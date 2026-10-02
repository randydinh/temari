/** Metadata-only inventory of simple img declarations in one recovered archived HTML original. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
} from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import {
  canonical,
  digest,
  hash,
  integer,
  list,
  object,
  text,
} from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

const MAX_HTML_BYTES = 64 * 1024;
const MAX_TAG_POINTS = 1024;
const MAX_IMAGES = 256;

export interface ArchiveHtmlImageInventoryPlan {
  readonly publicationPath: string;
  readonly sourcePath: string;
  readonly recoveredOriginalPath: string;
}

export interface ArchiveHtmlImage {
  readonly textStart: number;
  readonly textEnd: number;
  readonly quoteSha256: string;
  readonly targetPath: string | null;
  readonly original: { readonly sha256: string; readonly bytes: number } | null;
  readonly gap: null | {
    readonly kind:
      'missing' | 'outside' | 'external' | 'unsupported' | 'malformed';
    readonly reason: string;
  };
}

export interface ArchiveHtmlImageInventoryReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-html-image-inventory';
  readonly policy: 'recovered-simple-html-img-v1';
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly sourcePath: string;
  readonly sourceOriginal: { readonly sha256: string; readonly bytes: number };
  readonly images: readonly ArchiveHtmlImage[];
  readonly currentOriginal: 'not-checked';
  readonly visualMeaning: 'not-evaluated';
  readonly coverage: 'local-only-simple-single-line-html-img-declarations-only';
}

type Gap = ArchiveHtmlImage['gap'];
type Candidate = { start: number; quote: string; raw: string | null; gap: Gap };

function sourcePath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.startsWith('-') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..') &&
      /\.(?:html|htm)$/i.test(path),
    'Canonical source-relative HTML path required',
  );
  return path;
}

async function recoveredBytes(path: string): Promise<Buffer> {
  assert(isAbsolute(text(path)), 'Absolute recovered original path required');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(
      stat.isFile() && stat.size <= MAX_HTML_BYTES,
      'Bound regular recovered HTML file required',
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const block = Buffer.allocUnsafe(8192);
      const result = await handle.read(block, 0, block.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      assert(
        bytes <= MAX_HTML_BYTES,
        'Recovered HTML original exceeds byte bound',
      );
      chunks.push(block.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

function targetPath(
  source: string,
  raw: string,
): { path: string | null; gap: Gap } {
  if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/u.test(raw))
    return { path: null, gap: { kind: 'external', reason: 'external-target' } };
  if (raw.startsWith('/'))
    return { path: null, gap: { kind: 'outside', reason: 'absolute-target' } };
  if (!raw || raw.length > 4096 || /[\s?#%<>&\\\u0000-\u001f]/u.test(raw))
    return {
      path: null,
      gap: { kind: 'unsupported', reason: 'unsupported-target-form' },
    };
  const normalized = posix.normalize(posix.join(posix.dirname(source), raw));
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

function attributes(quote: string): { raw: string | null; gap: Gap } {
  let body = quote.slice(4, -1);
  if (/\/\s*$/u.test(body)) body = body.replace(/\/\s*$/u, '');
  let at = 0;
  let raw: string | null = null;
  const seen = new Set<string>();
  while (at < body.length) {
    const space = /^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '';
    at += space.length;
    if (at === body.length) break;
    if (!space)
      return {
        raw: null,
        gap: { kind: 'malformed', reason: 'invalid-attribute-spacing' },
      };
    const name = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(body.slice(at))?.[0];
    if (!name)
      return {
        raw: null,
        gap: { kind: 'malformed', reason: 'invalid-attribute' },
      };
    at += name.length;
    const key = name.toLowerCase();
    if (key === 'src' && seen.has(key))
      throw new Error('Duplicate HTML img src attribute');
    seen.add(key);
    const pad = /^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '';
    let quotation: string | null = null;
    let value: string | null = null;
    if (body[at + pad.length] === '=') {
      at += pad.length + 1;
      at += (/^[ \t\r]*/u.exec(body.slice(at))?.[0] ?? '').length;
      quotation = body[at] ?? null;
      if (quotation !== '"' && quotation !== "'")
        return {
          raw: null,
          gap: { kind: 'unsupported', reason: 'unquoted-attribute' },
        };
      const end = body.indexOf(quotation, ++at);
      if (end < 0)
        return {
          raw: null,
          gap: { kind: 'malformed', reason: 'unterminated-attribute' },
        };
      value = body.slice(at, end);
      at = end + 1;
    }
    if (key === 'src') {
      if (quotation !== '"' || value === null)
        return {
          raw: null,
          gap: { kind: 'unsupported', reason: 'src-must-be-double-quoted' },
        };
      raw = value;
    }
  }
  if (seen.has('srcset'))
    return {
      raw: null,
      gap: { kind: 'unsupported', reason: 'srcset-selection-unsupported' },
    };
  if (raw === null)
    return {
      raw: null,
      gap: { kind: 'malformed', reason: 'src-attribute-missing' },
    };
  return { raw, gap: null };
}

/** A tag terminates at the first unquoted > before either line separator. */
function tagEnd(body: string, start: number): number | null {
  let quotation: string | null = null;
  for (
    let at = start;
    at < body.length && body[at] !== '\n' && body[at] !== '\r';
    at++
  ) {
    if (quotation) {
      if (body[at] === quotation) quotation = null;
    } else if (body[at] === '"' || body[at] === "'") quotation = body[at];
    else if (body[at] === '>') return at + 1;
  }
  return null;
}

/** Lex only enough HTML to avoid counting attributes, comments, and inert blocks as img declarations. */
function candidates(body: string): Candidate[] {
  const found: Candidate[] = [];
  let at = 0;
  while (at < body.length) {
    const start = body.indexOf('<', at);
    if (start < 0) break;
    if (body.startsWith('<!--', start)) {
      const close = body.indexOf('-->', start + 4);
      assert(close >= 0, 'Unterminated HTML comment');
      at = close + 3;
      continue;
    }
    if (/^<!doctype\b/i.test(body.slice(start, start + 10))) {
      const close = tagEnd(body, start + 2);
      assert(
        close && !body.slice(start, close).includes('['),
        'Unsupported HTML doctype',
      );
      at = close;
      continue;
    }
    if (body.startsWith('<!', start) || body.startsWith('<?', start))
      throw new Error('Unsupported HTML declaration');
    const opener = /^<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[ \t\r\n/>])/u.exec(
      body.slice(start),
    );
    if (!opener) {
      at = start + 1;
      continue;
    }
    const name = opener[1].toLowerCase();
    const close = tagEnd(body, start + opener[0].length);
    if (!close) {
      throw new Error(
        name === 'img'
          ? 'Multiline or unterminated HTML img tag unsupported'
          : 'Unterminated HTML tag',
      );
    }
    if (!opener[0].startsWith('</') && name === 'base')
      throw new Error('HTML base element unsupported');
    if (
      !opener[0].startsWith('</') &&
      [
        'xmp',
        'iframe',
        'noembed',
        'noframes',
        'plaintext',
        'noscript',
      ].includes(name)
    )
      throw new Error(`Unsupported HTML raw-text container ${name}`);
    if (
      !opener[0].startsWith('</') &&
      (name === 'script' ||
        name === 'style' ||
        name === 'template' ||
        name === 'textarea' ||
        name === 'title')
    ) {
      const closing = new RegExp(`</${name}[ \\t\\r]*>`, 'gi');
      closing.lastIndex = close;
      const match = closing.exec(body);
      assert(match, `Unterminated inert HTML ${name} block`);
      if (name === 'template') {
        const nested = /<template(?=[ \t\r\n/>])/gi;
        nested.lastIndex = close;
        const inner = nested.exec(body);
        assert(
          !inner || inner.index >= match.index,
          'Nested HTML template unsupported',
        );
      }
      at = closing.lastIndex;
      continue;
    }
    if (name === 'img' && !opener[0].startsWith('</')) {
      const quote = body.slice(start, close);
      assert(
        Array.from(quote).length <= MAX_TAG_POINTS,
        'HTML img tag length budget exceeded',
      );
      assert(found.length < MAX_IMAGES, 'HTML img tag count budget exceeded');
      found.push({ start, quote, ...attributes(quote) });
    }
    at = close;
  }
  return found;
}

/** Verify one explicitly recovered original against a complete pinned manifest. */
export async function inventoryArchiveHtmlImages(
  input: ArchiveHtmlImageInventoryPlan,
): Promise<{
  receipt: ArchiveHtmlImageInventoryReceipt;
  receiptPath: string;
}> {
  assert.deepEqual(Object.keys(input).sort(), [
    'publicationPath',
    'recoveredOriginalPath',
    'sourcePath',
  ]);
  assert(isAbsolute(text(input.publicationPath)));
  const selected = sourcePath(input.sourcePath);
  const saved = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(
    saved.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Complete archive required',
  );
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => {
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source registration changed',
    );
    const rows = list((await transport.invoke('list', []))['sources']).map(
      object,
    );
    const matches = rows.filter((row) => row['id'] === publication.source.id);
    assert.equal(matches.length, 1, 'Current source sharing unavailable');
    assert.equal(
      matches[0]['sharing'],
      'local-only',
      'Current source must be local-only',
    );
  };
  await admission();

  const originals = new Map<string, { sha256: string; bytes: number } | null>();
  let offset = 0,
    exhausted = false,
    rows = 0;
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
    snapshot(page, publication);
    assert.equal(page['status'], 'complete');
    assert.equal(page['request_key'], publication.captureRequestKey);
    assert.equal(page['request_fingerprint'], publication.captureFingerprint);
    assert.equal(page['preservation'], publication.preservation);
    assert.equal(canonical(page['counts']), canonical(publication.counts));
    const docs = list(page['documents']);
    assert(docs.length <= 20);
    rows += docs.length;
    assert(rows <= 1000, 'Archive manifest row budget exceeded');
    for (const value of docs) {
      const document = object(value);
      const path = text(document['path']);
      assert(!originals.has(path), 'Duplicate archived document path');
      if (document['original'] === null) originals.set(path, null);
      else {
        assert.equal(
          document['status'],
          'captured',
          'Archived original unavailable',
        );
        const original = object(document['original']);
        originals.set(path, {
          sha256: digest(original['sha256']),
          bytes: integer(original['bytes'], 0, 8 * 1024 * 1024),
        });
      }
    }
    if (page['next_offset'] === null) {
      exhausted = true;
      break;
    }
    const next = integer(page['next_offset'], offset + 1, 1000);
    assert.equal(
      next,
      offset + docs.length,
      'Archive inventory skipped records',
    );
    offset = next;
  }
  assert(exhausted, 'Archive inventory did not reach terminal page');
  const sourceOriginal = originals.get(selected);
  assert(
    sourceOriginal && sourceOriginal.bytes <= MAX_HTML_BYTES,
    'Selected HTML original missing or over byte bound',
  );
  const bytes = await recoveredBytes(input.recoveredOriginalPath);
  assert.deepEqual(
    { sha256: hash(bytes), bytes: bytes.length },
    sourceOriginal,
    'Recovered HTML differs from pinned original',
  );
  assert(
    !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    'HTML UTF-8 BOM unsupported for exact code-point spans',
  );
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(!body.includes('\0'), 'NUL in recovered HTML unsupported');
  const points = Array.from(body);
  const images: ArchiveHtmlImage[] = [];
  for (const candidate of candidates(body)) {
    const textStart: number = Array.from(body.slice(0, candidate.start)).length;
    const textEnd: number = textStart + Array.from(candidate.quote).length;
    assert.equal(
      points.slice(textStart, textEnd).join(''),
      candidate.quote,
      'HTML img quote differs from recovered original span',
    );
    const base = { textStart, textEnd, quoteSha256: hash(candidate.quote) };
    if (candidate.gap) {
      images.push({
        ...base,
        targetPath: null,
        original: null,
        gap: candidate.gap,
      });
      continue;
    }
    assert(candidate.raw !== null);
    const target = targetPath(selected, candidate.raw);
    if (target.gap) {
      images.push({
        ...base,
        targetPath: target.path,
        original: null,
        gap: target.gap,
      });
      continue;
    }
    assert(target.path);
    if (!originals.has(target.path)) {
      images.push({
        ...base,
        targetPath: target.path,
        original: null,
        gap: { kind: 'missing', reason: 'not-in-captured-generation' },
      });
      continue;
    }
    const original = originals.get(target.path);
    if (!original) {
      images.push({
        ...base,
        targetPath: target.path,
        original: null,
        gap: { kind: 'unsupported', reason: 'archived-original-unavailable' },
      });
      continue;
    }
    images.push({ ...base, targetPath: target.path, original, gap: null });
  }
  const finalBytes = await recoveredBytes(input.recoveredOriginalPath);
  assert.deepEqual(
    { sha256: hash(finalBytes), bytes: finalBytes.length },
    sourceOriginal,
    'Recovered HTML changed during inventory',
  );
  await admission();
  assert.equal(
    hash((await readJsonWithBytes(input.publicationPath)).bytes),
    hash(saved.bytes),
    'Publication changed during HTML inventory',
  );
  const receipt: ArchiveHtmlImageInventoryReceipt = {
    schema: 1,
    kind: 'temari-archive-html-image-inventory',
    policy: 'recovered-simple-html-img-v1',
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath,
    publicationSha256: hash(saved.bytes),
    sourcePath: selected,
    sourceOriginal,
    images,
    currentOriginal: 'not-checked',
    visualMeaning: 'not-evaluated',
    coverage: 'local-only-simple-single-line-html-img-declarations-only',
  };
  const receiptPath = join(
    publication.task.directory,
    `archive-html-image-inventory-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
