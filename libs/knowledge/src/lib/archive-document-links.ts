/** Deterministic, operator-run Markdown links grounded in one retained archive. */
import assert from 'node:assert/strict';
import { isAbsolute, posix, join } from 'node:path';
import type { KnowledgeEvidence, KnowledgeProvider } from '@temari/contracts';
import { canonical, hash, integer, text } from './codec.js';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson } from './durable.js';

export interface ArchiveDocumentLinksPlan {
  readonly publicationPath: string;
  /** Source-relative Markdown documents that may contribute an endpoint. */
  readonly paths: readonly string[];
  readonly maxEdges: number;
}

type Publication = Awaited<ReturnType<typeof loadArchivePublication>>;
type Anchor = {
  source_id: string;
  generation: string;
  manifest_sha256: string;
  path: string;
  original_sha256: string;
  representation_sha256: string;
  text_start: number;
  text_end: number;
  quote: string;
  quote_sha256: string;
};
type ArchivedText = { body: string; first: KnowledgeEvidence; anchor: Anchor };
type Candidate = { start: number; quote: string; destination: string; image: boolean; escaped: boolean };

function relativePath(value: unknown): string {
  const path = text(value);
  assert(path.length <= 4096 && !isAbsolute(path) && !path.startsWith('-') &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Canonical source-relative path required');
  return path;
}

function markdown(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function nontextOmissions(evidence: KnowledgeEvidence): string[] | null {
  const reasons = evidence.archive?.omissions.map((gap) => gap.detail) ?? [];
  return reasons.every((reason) =>
    reason === 'visual-evidence-unavailable' || reason === 'asset-inventory-partial')
    ? reasons : null;
}

/** Entire UTF-8 representation is checked; no live original is consulted. */
async function archivedText(provider: KnowledgeProvider, publication: Publication, path: string): Promise<ArchivedText | null> {
  let continuation: string | null = null;
  let first: KnowledgeEvidence | null = null;
  let body = '';
  let total: number | null = null;
  do {
    const page = await provider.read({
      document: { source: publication.source, path },
      expectedSha256: first?.sha256 ?? null,
      maxCodePoints: 8000,
      maxBytes: 65536,
      continuation,
    });
    if (!page.ok) {
      if (page.gap.kind === 'scope-refused') throw new Error('Source admission refused during link publication');
      return null;
    }
    const evidence = page.value.evidence;
    if (!first) first = evidence;
    if (!evidence.archive || evidence.representation.method !== 'utf-8-text' ||
      nontextOmissions(evidence) === null ||
      evidence.sha256 !== first.sha256 ||
      evidence.archive.representationSha256 !== first.archive?.representationSha256 ||
      evidence.span.start !== Array.from(body).length ||
      (total !== null && total !== page.value.totalCodePoints)) return null;
    total = page.value.totalCodePoints;
    if (total > 65536) return null;
    body += evidence.excerpt;
    continuation = page.value.next;
  } while (continuation);
  if (!first?.archive || !body || Array.from(body).length !== total ||
    hash(body) !== first.archive.representationSha256) return null;
  const chars = Array.from(body);
  const start = chars.findIndex((c) => !/\s/u.test(c));
  if (start < 0) return null;
  const endOfLine = chars.findIndex((c, i) => i >= start && c === '\n');
  const end = Math.min(start + 64, endOfLine < 0 ? chars.length : endOfLine);
  if (end <= start) return null;
  const quote = chars.slice(start, end).join('');
  const anchor: Anchor = {
    source_id: publication.source.id,
    generation: publication.generation,
    manifest_sha256: publication.manifestSha256,
    path,
    original_sha256: first.sha256,
    representation_sha256: first.archive.representationSha256,
    text_start: start,
    text_end: end,
    quote,
    quote_sha256: hash(quote),
  };
  return { body, first, anchor };
}

/** Mask comments, frontmatter and code without changing UTF-16 indices. */
export function visibleMarkdown(body: string): string {
  const blank = (part: string) => part.replace(/[^\r\n]/g, ' ');
  const multilineHtml = new Set([
    'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd',
    'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'head', 'header', 'html', 'iframe', 'li', 'main', 'nav',
    'noframes', 'ol', 'pre', 'script', 'section', 'style', 'summary',
    'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'title',
    'tr', 'ul',
  ]);
  const exactBacktickClose = (line: string, run: string, from: number): number => {
    let at = line.indexOf(run, from);
    while (at >= 0) {
      if (line[at - 1] !== '`' && line[at + run.length] !== '`') return at;
      at = line.indexOf(run, at + run.length);
    }
    return -1;
  };
  const fenceLine = (line: string) => {
    let rest = line.replace(/\r?\n$/, '');
    // A fence may be nested in blockquote and list containers. Strip only
    // their visible prefixes; preserve the original line for anchor offsets.
    for (let depth = 0; depth < 16; depth++) {
      const prefix = /^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(rest);
      if (!prefix) break;
      rest = rest.slice(prefix[0].length);
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rest);
    return marker ? { marker: marker[1][0], size: marker[1].length,
      tail: marker[2] } : null;
  };
  const lines = body.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fenced: { marker: string; size: number } | null = null;
  let frontmatter = /^---\s*\r?\n/.test(body);
  let comment = false;
  let inlineRun: string | null = null;
  let htmlBlock: string | null = null;
  return lines.map((line, index) => {
    if (frontmatter) {
      if (index > 0 && /^\s*(?:---|\.\.\.)\s*$/.test(line.trimEnd())) frontmatter = false;
      return blank(line);
    }
    const fence = fenceLine(line);
    if (fenced) {
      if (fence && fence.marker === fenced.marker && fence.size >= fenced.size &&
        /^\s*$/.test(fence.tail)) fenced = null;
      return blank(line);
    }
    if (fence) {
      fenced = { marker: fence.marker, size: fence.size };
      inlineRun = null;
      return blank(line);
    }
    if (htmlBlock) {
      if (new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line)) htmlBlock = null;
      return blank(line);
    }
    // Markdown block containers can precede code indentation. Preserve the
    // original line so every later offset remains an exact retained-text offset.
    let afterContainers = line;
    for (let depth = 0; depth < 16; depth++) {
      const prefix = /^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(afterContainers);
      if (!prefix) break;
      afterContainers = afterContainers.slice(prefix[0].length);
    }
    if (/^(?: {4}|\t)/.test(afterContainers)) return blank(line);
    const blockStart = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/.exec(afterContainers);
    if (blockStart && multilineHtml.has(blockStart[1].toLowerCase()) &&
      !/\/\s*>$/.test(blockStart[0]) &&
      !new RegExp(`</${blockStart[1]}\\s*>`, 'i').test(afterContainers)) {
      htmlBlock = blockStart[1];
      return blank(line);
    }
    // HTML can reinterpret Markdown syntax; this adapter leaves such lines out.
    if (/<\/?[A-Za-z][^>\n]*>/.test(line)) return blank(line);
    let output = '';
    for (let i = 0; i < line.length;) {
      if (inlineRun) {
        const close = exactBacktickClose(line, inlineRun, i);
        if (close < 0) { output += blank(line.slice(i)); break; }
        output += blank(line.slice(i, close + inlineRun.length));
        i = close + inlineRun.length;
        inlineRun = null;
      } else if (comment) {
        const close = line.indexOf('-->', i);
        if (close < 0) { output += blank(line.slice(i)); break; }
        output += blank(line.slice(i, close + 3));
        i = close + 3;
        comment = false;
      } else if (line.startsWith('<!--', i)) {
        comment = true;
      } else if (line[i] === '`') {
        let end = i;
        while (line[end] === '`') end++;
        const run = line.slice(i, end);
        const close = exactBacktickClose(line, run, end);
        if (close < 0) { inlineRun = run; output += blank(line.slice(i)); break; }
        else { output += blank(line.slice(i, close + run.length)); i = close + run.length; }
      } else { output += line[i]; i++; }
    }
    return output;
  }).join('');
}

function links(body: string): Candidate[] {
  const visible = visibleMarkdown(body);
  const found: Candidate[] = [];
  const masked = visible.split('');
  // Mask a complete image before matching ordinary links. Nested alt text may
  // contain link-shaped text, but Markdown treats it as image content.
  for (let i = 0; i < visible.length; i++) {
    if (!visible.startsWith('![', i)) continue;
    let depth = 1;
    let j = i + 2;
    for (; j < visible.length && visible[j] !== '\n'; j++) {
      if (visible[j] === '[' && visible[j - 1] !== '\\') depth++;
      else if (visible[j] === ']' && visible[j - 1] !== '\\' && --depth === 0) break;
    }
    let end = j;
    if (depth === 0 && visible[j + 1] === '(') {
      let parentheses = 1;
      end = j + 2;
      for (; end < visible.length && visible[end] !== '\n'; end++) {
        if (visible[end] === '(') parentheses++;
        else if (visible[end] === ')' && --parentheses === 0) { end++; break; }
      }
      let slashCount = 0;
      while (i > slashCount && visible[i - slashCount - 1] === '\\') slashCount++;
      if (parentheses === 0) found.push({ start: i,
        quote: body.slice(i, end), destination: body.slice(j + 2, end - 1),
        image: true, escaped: slashCount % 2 === 1 });
    }
    while (end < visible.length && visible[end] !== '\n' && depth !== 0) end++;
    for (let k = i; k < end; k++) if (masked[k] !== '\r' && masked[k] !== '\n') masked[k] = ' ';
    i = end - 1;
  }
  const pattern = /\[([^\[\]\r\n]*)\]\(([^()\r\n]*)\)/g;
  for (const match of masked.join('').matchAll(pattern)) {
    const start = match.index;
    const preceding = start > 0 ? visible[start - 1] : '';
    found.push({
      start,
      quote: body.slice(start, start + match[0].length),
      destination: match[2],
      image: false,
      escaped: preceding === '\\',
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Exact visible inline images; source text and alt text stay with the caller. */
export function visibleArchivedMarkdownImages(body: string): readonly {
  start: number;
  quote: string;
  destination: string;
  escaped: boolean;
}[] {
  return links(body).filter((item) => item.image).map(
    ({ start, quote, destination, escaped }) =>
      ({ start, quote, destination, escaped }),
  );
}

/** Full retained UTF-8 text under the same 65,536-codepoint link boundary. */
export async function readArchivedMarkdownForInventory(
  provider: KnowledgeProvider,
  publication: Publication,
  path: string,
): Promise<{ body: string; first: KnowledgeEvidence } | null> {
  const result = await archivedText(provider, publication, path);
  return result && { body: result.body, first: result.first };
}

function destination(source: string, raw: string): string | null {
  if (!raw || raw.length > 4096 || /[\s?#%<>\\\u0000-\u001f]/u.test(raw) ||
    raw.startsWith('/') || raw.startsWith('//') || raw.includes(':')) return null;
  const path = raw.startsWith('./') ? raw.slice(2) : raw;
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !markdown(path)) return null;
  const resolved = posix.join(posix.dirname(source), path);
  return resolved === posix.normalize(resolved) ? resolved : null;
}

function span(basis: Anchor, body: string, start: number, quote: string): Anchor {
  const textStart = Array.from(body.slice(0, start)).length;
  return { ...basis, text_start: textStart,
    text_end: textStart + Array.from(quote).length,
    quote, quote_sha256: hash(quote) };
}

/** Re-extract one operator-selected link from retained text, never from supplied evidence. */
export async function extractReviewedArchiveDocumentLink(input: {
  readonly publicationPath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly codePointOffset: number;
  readonly allowedPaths: readonly string[];
}) {
  assert(isAbsolute(input.publicationPath), 'Absolute publication path required');
  const sourcePath = relativePath(input.sourcePath);
  const targetPath = relativePath(input.targetPath);
  assert(markdown(sourcePath) && markdown(targetPath) && sourcePath !== targetPath,
    'Distinct Markdown endpoints required');
  assert(Array.isArray(input.allowedPaths) && input.allowedPaths.length >= 2 &&
    input.allowedPaths.length <= 200, 'Explicit endpoint allowlist required');
  const allowed = input.allowedPaths.map(relativePath);
  assert.equal(new Set(allowed).size, allowed.length, 'Duplicate allowed path');
  assert(allowed.includes(sourcePath) && allowed.includes(targetPath),
    'Link endpoint outside allowed paths');
  integer(input.codePointOffset, 0, 65536);
  const publication = await loadArchivePublication(input.publicationPath);
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Source registration changed');
  await admission();
  const provider = await createArchiveRegistrar({
    publications: [input.publicationPath], readScope: 'source-root',
  });
  const source = await archivedText(provider, publication, sourcePath);
  const target = await archivedText(provider, publication, targetPath);
  assert(source && target, 'Both retained Markdown endpoints must have complete text');
  const candidate = links(source.body).find((item) =>
    Array.from(source.body.slice(0, item.start)).length === input.codePointOffset);
  assert(candidate && !candidate.image && !candidate.escaped &&
    Array.from(candidate.quote).length <= 512 &&
    destination(sourcePath, candidate.destination) === targetPath,
  'Offset must identify an exact visible inline Markdown link to the allowed target');
  const nodeId = (path: string, item: ArchivedText) =>
    hash(canonical([publication.source.id, publication.generation, path,
      item.anchor.original_sha256, item.anchor.representation_sha256])).slice(0, 32);
  const cite = span(source.anchor, source.body, candidate.start, candidate.quote);
  const sourceId = nodeId(sourcePath, source), targetId = nodeId(targetPath, target);
  const node = (id: string, path: string, item: ArchivedText) => ({
    id, kind: 'mention' as const,
    label: path.length <= 512 ? path : posix.basename(path).slice(0, 512),
    provenance: 'extracted' as const, anchors: [item.anchor],
  });
  const assertion = {
    id: hash(canonical([sourceId, 'links-to', targetId, cite.text_start,
      cite.quote_sha256])).slice(0, 32),
    kind: 'relationship' as const, subject: sourceId, predicate: 'links-to',
    object: targetId, support: [cite, target.anchor], contrary: [],
    provenance: 'extracted' as const, lifecycle: 'active' as const,
    supersedes: [],
  };
  await admission();
  assert.equal(canonical(await loadArchivePublication(input.publicationPath)),
    canonical(publication), 'Publication changed during link extraction');
  return { source: publication.source, nodes: [
    node(sourceId, sourcePath, source), node(targetId, targetPath, target),
  ], assertion };
}

export async function publishArchiveDocumentLinks(plan: ArchiveDocumentLinksPlan) {
  assert(isAbsolute(plan.publicationPath), 'Absolute publication path required');
  integer(plan.maxEdges, 1, 500);
  assert(Array.isArray(plan.paths) && plan.paths.length >= 1 && plan.paths.length <= 200);
  const paths = plan.paths.map(relativePath);
  assert.equal(new Set(paths).size, paths.length, 'Duplicate path');
  const allowed = new Set(paths);
  const publication = await loadArchivePublication(plan.publicationPath);
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Source registration changed');
  await admission();
  const provider = await createArchiveRegistrar({
    publications: [plan.publicationPath], readScope: 'source-root',
  });
  const cached = new Map<string, ArchivedText | null>();
  const get = async (path: string): Promise<ArchivedText | null> => {
    if (!cached.has(path)) cached.set(path, await archivedText(provider, publication, path));
    return cached.get(path) ?? null;
  };
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const omissions = new Set<string>();
  const nodes = new Map<string, Record<string, unknown>>();
  const assertions: Record<string, unknown>[] = [];
  const nodeId = (path: string, item: ArchivedText) =>
    hash(canonical([publication.source.id, publication.generation, path,
      item.anchor.original_sha256, item.anchor.representation_sha256])).slice(0, 32);
  for (const path of paths) {
    if (!markdown(path)) { skip('non-markdown-source'); continue; }
    const source = await get(path);
    if (!source) { skip('source-text-unavailable'); continue; }
    source.first.archive?.omissions.forEach((gap) => omissions.add(gap.detail));
    for (const candidate of links(source.body)) {
      if (assertions.length >= plan.maxEdges) { skip('edge-budget'); continue; }
      if (candidate.image) { skip('image'); continue; }
      if (candidate.escaped) { skip('escaped-link'); continue; }
      if (Array.from(candidate.quote).length > 512) { skip('link-too-long'); continue; }
      const targetPath = destination(path, candidate.destination);
      if (!targetPath) { skip('unsupported-destination'); continue; }
      if (targetPath === path) { skip('self-link'); continue; }
      if (!allowed.has(targetPath)) { skip('outside-allowed-paths'); continue; }
      const target = await get(targetPath);
      if (!target) { skip('target-text-unavailable'); continue; }
      target.first.archive?.omissions.forEach((gap) => omissions.add(gap.detail));
      const a = nodeId(path, source), b = nodeId(targetPath, target);
      const cite = span(source.anchor, source.body, candidate.start, candidate.quote);
      for (const [id, item, label] of [
        [a, source, path], [b, target, targetPath],
      ] as const) nodes.set(id, { id, kind: 'mention',
        label: label.length <= 512 ? label : posix.basename(label).slice(0, 512),
        provenance: 'extracted', anchors: [item.anchor] });
      assertions.push({
        id: hash(canonical([a, 'links-to', b, cite.text_start, cite.quote_sha256])).slice(0, 32),
        kind: 'relationship', subject: a, predicate: 'links-to', object: b,
        support: [cite, target.anchor], contrary: [], provenance: 'extracted',
        lifecycle: 'active', supersedes: [],
      });
    }
  }
  await admission();
  assert.equal(canonical(await loadArchivePublication(plan.publicationPath)), canonical(publication),
    'Publication changed during link extraction');
  const draft = assertions.length ? {
    schema: 1,
    revision_set: { schema: 1, selections: [{
      source_id: publication.source.id, generation: publication.generation,
      manifest_sha256: publication.manifestSha256,
    }] },
    parent: null,
    nodes: [...nodes.values()], assertions,
  } : null;
  const draftPath = draft ? join(publication.task.directory,
    `archive-document-links-draft-${hash(canonical(draft))}.json`) : null;
  if (draftPath && draft) await publishJson(draftPath, draft);
  let graphId: string | null = null;
  if (draftPath) {
    const published = await transport.invoke('graph-publish', [draftPath]);
    assert.equal(published['status'], 'complete');
    graphId = text(published['graph_id']);
    assert(/^[0-9a-f]{64}$/.test(graphId));
  }
  const receipt = {
    schema: 1, kind: 'temari-archive-document-links-publication',
    policy: 'pinned-markdown-inline-links-v1',
    status: graphId ? 'published' : 'no-anchored-links',
    sourceId: publication.source.id, generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    selectedPathsSha256: hash(canonical(paths)),
    graphId, nodeCount: nodes.size, relationshipCount: assertions.length,
    skipped, knownNontextOmissions: [...omissions].sort(),
    currentOriginal: 'not-checked', nativeGraphify: 'unavailable',
  };
  const receiptPath = join(publication.task.directory,
    `archive-document-links-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { graphId, draftPath, receiptPath,
    relationshipCount: assertions.length, skipped,
    status: receipt.status };
}
