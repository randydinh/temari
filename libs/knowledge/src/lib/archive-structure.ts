/** Operator-side import of structural candidates into a pinned Registrar graph. */
import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeEvidence, KnowledgeProvider } from '@temari/contracts';
import { canonical, hash, integer, object, text } from './codec.js';
import { loadArchivePublication } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson } from './durable.js';

export interface ArchiveStructurePlan {
  readonly publicationPath: string;
  readonly artifactPath: string;
  readonly kind: 'nx' | 'graft';
  /** Only these archive-relative paths may contribute an edge. */
  readonly paths: readonly string[];
  readonly maxEdges: number;
}

interface CandidateNode {
  id: string;
  path: string;
  label: string;
  line?: number;
  endLine?: number;
  kind?: string;
  bodyHash?: string;
}
interface CandidateEdge {
  source: string;
  target: string;
  predicate: string;
  provenance: 'extracted' | 'inferred' | 'ambiguous';
  nxType?: 'static' | 'dynamic' | 'implicit';
}
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

function relativePath(raw: unknown): string {
  const path = text(raw);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0'),
  );
  assert(
    !path.startsWith('-') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
  return path;
}
function rows(value: unknown, max: number): unknown[] {
  assert(
    Array.isArray(value) && value.length <= max,
    'Structure artifact exceeds bound',
  );
  return value;
}

function candidates(
  kind: ArchiveStructurePlan['kind'],
  value: unknown,
): { nodes: Map<string, CandidateNode>; edges: CandidateEdge[] } {
  const root = object(value);
  const nodes = new Map<string, CandidateNode>();
  const edges: CandidateEdge[] = [];
  if (kind === 'graft') {
    assert.equal(object(root['meta'])['version'], 1);
    for (const raw of rows(root['nodes'], 50_000)) {
      const node = object(raw);
      const id = text(node['id']);
      const path = relativePath(node['path']);
      const name = text(node['name']);
      if (id.length > 4096 || name.length > 512 || nodes.has(id)) continue;
      const span = /^L([0-9]+)(?:-L([0-9]+))?$/.exec(
        String(node['span'] ?? ''),
      );
      nodes.set(id, {
        id,
        path,
        label: name,
        kind: typeof node['kind'] === 'string' ? node['kind'] : undefined,
        bodyHash:
          typeof node['body_hash'] === 'string' ? node['body_hash'] : undefined,
        ...(span ? { line: Number(span[1]) } : {}),
        ...(span ? { endLine: Number(span[2] ?? span[1]) } : {}),
      });
    }
    for (const raw of rows(root['edges'], 100_000)) {
      const edge = object(raw);
      const predicate = text(edge['relation']);
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(predicate)) continue;
      const confidence = edge['confidence'];
      edges.push({
        source: text(edge['source']),
        target: text(edge['target']),
        predicate,
        provenance:
          confidence === 'extracted'
            ? 'extracted'
            : confidence === 'ambiguous'
              ? 'ambiguous'
              : 'inferred',
      });
    }
  } else {
    const graph = object(root['graph']);
    for (const [id, raw] of Object.entries(object(graph['nodes']))) {
      const data = object(object(raw)['data']);
      const projectRoot = data['root'];
      if (typeof projectRoot !== 'string') continue;
      const metadata = data['metadata'];
      const js =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)['js']
          : undefined;
      const packageName =
        js && typeof js === 'object' && !Array.isArray(js)
          ? (js as Record<string, unknown>)['packageName']
          : undefined;
      // Project metadata is the evidence for a project edge. A missing metadata
      // file stays a gap; a dependency is never anchored to an arbitrary source.
      for (const filename of ['project.json', 'package.json']) {
        const path = relativePath(
          projectRoot === '.' || !projectRoot
            ? filename
            : `${projectRoot}/${filename}`,
        );
        nodes.set(`${id}:${filename}`, {
          id: `${id}:${filename}`,
          path,
          label:
            filename === 'package.json' &&
            typeof packageName === 'string' &&
            packageName.length <= 512
              ? packageName
              : id,
        });
      }
    }
    for (const [source, raw] of Object.entries(object(graph['dependencies']))) {
      for (const item of rows(raw, 10_000)) {
        const edge = object(item);
        if (edge['source'] !== source) continue;
        const target = text(edge['target']);
        const nxType = edge['type'];
        if (
          nxType !== 'static' &&
          nxType !== 'dynamic' &&
          nxType !== 'implicit'
        )
          continue;
        edges.push({
          source,
          target,
          predicate: 'depends-on',
          provenance: 'extracted',
          nxType,
        });
      }
    }
  }
  return { nodes, edges };
}

function findAnchor(
  body: string,
  label: string,
  line?: number,
): { start: number; quote: string } | null {
  const lines = body.split('\n');
  if (
    line !== undefined &&
    Number.isSafeInteger(line) &&
    line >= 1 &&
    line <= lines.length
  ) {
    // Graft's source span narrows repeated symbol names to the declaration line.
    const offset = lines
      .slice(0, line - 1)
      .reduce((n, part) => n + Array.from(part).length + 1, 0);
    const index = lines[line - 1].indexOf(label);
    if (index >= 0)
      return {
        start: offset + Array.from(lines[line - 1].slice(0, index)).length,
        quote: label,
      };
    return null;
  }
  const index = body.indexOf(label);
  return index < 0
    ? null
    : { start: Array.from(body.slice(0, index)).length, quote: label };
}

function spanBody(body: string, node: CandidateNode): string | null {
  if (!node.line || !node.endLine || node.endLine < node.line) return null;
  const lines = body.split('\n');
  // Graft fingerprints file nodes over the complete source bytes, including
  // the final newline. Its file span names every line in that same text.
  if (node.kind === 'file')
    return node.line === 1 && node.endLine === lines.length ? body : null;
  if (node.endLine > lines.length) return null;
  return lines.slice(node.line - 1, node.endLine).join('\n');
}

/** Keep offsets stable while hiding Swift comments from call checks. */
function swiftCode(body: string): string | null {
  // A lexical scanner cannot faithfully parse Swift interpolation, raw or
  // multiline strings. Omit calls from any file with a string delimiter.
  if (body.includes('"')) return null;
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' = 'code';
  let blockDepth = 0;
  while (i < body.length) {
    const pair = body.slice(i, i + 2);
    const char = body[i];
    if (state === 'code') {
      if (pair === '//') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (pair === '/*') {
        state = 'block';
        blockDepth = 1;
        out += '  ';
        i += 2;
        continue;
      }
      out += char;
      i++;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (pair === '/*') {
        blockDepth++;
        out += '  ';
        i += 2;
        continue;
      }
      if (pair === '*/') {
        blockDepth--;
        out += '  ';
        i += 2;
        if (!blockDepth) state = 'code';
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
  }
  // A slash can be a Swift regex literal or an operator. Refuse this subset
  // until expression parsing can distinguish it from a real call.
  return (state === 'code' || state === 'line') &&
    !out.includes('/') &&
    !out.includes('#') &&
    !/[^\x00-\x7f]/.test(out)
    ? out
    : null;
}

function jsonFieldValueSpan(
  body: string,
  field: string,
): { value: string; start: number } | null {
  const endString = (start: number): number => {
    let escaped = false;
    for (let i = start + 1; i < body.length; i++) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (body[i] === '\\') {
        escaped = true;
        continue;
      }
      if (body[i] === '"') return i;
    }
    return -1;
  };
  const endContainer = (start: number): number => {
    const stack: string[] = [];
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (c === '"') {
        i = endString(i);
        if (i < 0) return -1;
        continue;
      }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const open = stack.pop();
        if ((c === '}' && open !== '{') || (c === ']' && open !== '['))
          return -1;
        if (!stack.length) return i;
      }
    }
    return -1;
  };
  const found: { value: string; start: number }[] = [];
  const stack: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      const end = endString(i);
      if (end < 0) return null;
      const raw = body.slice(i, end + 1);
      const tail = body.slice(end + 1).match(/^\s*:/);
      if (
        stack.length === 1 &&
        stack[0] === '{' &&
        tail &&
        JSON.parse(raw) === field
      ) {
        const start =
          end +
          1 +
          tail[0].length +
          (body.slice(end + 1 + tail[0].length).match(/^\s*/)?.[0].length ?? 0);
        if (body[start] !== '{' && body[start] !== '[') return null;
        const stop = endContainer(start);
        if (stop < 0) return null;
        found.push({ value: body.slice(start, stop + 1), start });
      }
      i = end;
      continue;
    }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  return found.length === 1 ? found[0] : null;
}

function jsonMemberString(
  span: { value: string; start: number },
  name: string,
  role: 'key' | 'array-value',
): { start: number; quote: string } | null {
  const found: { start: number; quote: string }[] = [];
  const body = span.value;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '{' || char === '[') {
      depth++;
      continue;
    }
    if (char === '}' || char === ']') {
      depth--;
      continue;
    }
    if (char !== '"') continue;
    const start = i;
    i++;
    let escaped = false;
    for (; i < body.length; i++) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (body[i] === '\\') {
        escaped = true;
        continue;
      }
      if (body[i] === '"') break;
    }
    if (i >= body.length) return null;
    const raw = body.slice(start, i + 1);
    const next = body.slice(i + 1).match(/^\s*([^\s])/);
    const isKey = next?.[1] === ':';
    if (depth !== 1 || (role === 'key') !== isKey) continue;
    if (JSON.parse(raw) !== name) continue;
    const plain = raw.slice(1, -1) === name;
    found.push({
      start: span.start + start + (plain ? 1 : 0),
      quote: plain ? name : raw,
    });
  }
  return found.length === 1 ? found[0] : null;
}

/** Full bounded archive reads establish the exact coordinate space before publish. */
async function archivedAnchor(
  provider: KnowledgeProvider,
  publication: Awaited<ReturnType<typeof loadArchivePublication>>,
  node: CandidateNode,
  textCache: Map<string, { body: string; first: KnowledgeEvidence } | null>,
): Promise<Anchor | null> {
  if (!textCache.has(node.path)) {
    let continuation: string | null = null;
    let body = '';
    let first: KnowledgeEvidence | null = null;
    do {
      const read = await provider.read({
        document: { source: publication.source, path: node.path },
        expectedSha256: first?.sha256 ?? null,
        maxCodePoints: 8000,
        maxBytes: 65536,
        continuation,
      });
      if (!read.ok) {
        textCache.set(node.path, null);
        return null;
      }
      if (!first) first = read.value.evidence;
      body += read.value.evidence.excerpt;
      if (Array.from(body).length > 65536) {
        textCache.set(node.path, null);
        return null;
      }
      continuation = read.value.next;
    } while (continuation);
    textCache.set(node.path, first ? { body, first } : null);
  }
  const cached = textCache.get(node.path);
  if (!cached) return null;
  const { body, first } = cached;
  if (
    !first?.archive ||
    !first.excerpt ||
    first.archive.omissions.length ||
    first.representation.method !== 'utf-8-text'
  )
    return null;
  // A file node is named for its path, which need not occur in its contents.
  // Cite a short excerpt from that exact archived file instead.
  const found =
    node.kind === 'file'
      ? (() => {
          const characters = Array.from(body);
          const start = characters.findIndex((char) => !/\s/u.test(char));
          if (start < 0) return null;
          const endOfLine = characters.findIndex(
            (char, index) => index >= start && char === '\n',
          );
          const end = Math.min(
            start + 64,
            endOfLine < 0 ? characters.length : endOfLine,
          );
          return end > start
            ? { start, quote: characters.slice(start, end).join('') }
            : null;
        })()
      : findAnchor(body, node.label, node.line);
  if (!found) return null;
  return {
    source_id: publication.source.id,
    generation: publication.generation,
    manifest_sha256: publication.manifestSha256,
    path: node.path,
    original_sha256: first.sha256,
    representation_sha256: first.archive.representationSha256,
    text_start: found.start,
    text_end: found.start + Array.from(found.quote).length,
    quote: found.quote,
    quote_sha256: hash(found.quote),
  };
}

export async function publishArchiveStructure(plan: ArchiveStructurePlan) {
  assert(isAbsolute(plan.publicationPath) && isAbsolute(plan.artifactPath));
  assert(plan.kind === 'nx' || plan.kind === 'graft');
  integer(plan.maxEdges, 1, 500);
  assert(plan.paths.length >= 1 && plan.paths.length <= 200);
  const allowed = new Set(plan.paths.map(relativePath));
  assert.equal(allowed.size, plan.paths.length);
  const publication = await loadArchivePublication(plan.publicationPath);
  const sourceRoot = fileURLToPath(publication.source.locator);
  assert.equal(await realpath(sourceRoot), sourceRoot, 'Source root changed');
  const artifactStat = await lstat(plan.artifactPath);
  assert(
    artifactStat.isFile() &&
      !artifactStat.isSymbolicLink() &&
      artifactStat.size <= 8 * 1024 * 1024,
  );
  const artifactBytes = await readFile(plan.artifactPath);
  const parsed = candidates(
    plan.kind,
    JSON.parse(artifactBytes.toString('utf8')),
  );
  const provider = await createArchiveRegistrar({
    publications: [plan.publicationPath],
    readScope: 'source-root',
  });
  const anchors = new Map<string, Anchor>();
  const sourceTexts = new Map<string, string>();
  const textCache = new Map<
    string,
    { body: string; first: KnowledgeEvidence } | null
  >();
  const unavailable = new Set<string>();
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const nodeFor = (id: string): CandidateNode | undefined => {
    if (plan.kind === 'graft') return parsed.nodes.get(id);
    return (
      parsed.nodes.get(`${id}:project.json`) ??
      parsed.nodes.get(`${id}:package.json`)
    );
  };
  const resolve = async (
    id: string,
    nxFile: 'package.json' | 'project.json' | null = null,
  ): Promise<{ node: CandidateNode; anchor: Anchor } | null> => {
    const candidates =
      plan.kind === 'graft'
        ? [parsed.nodes.get(id)].filter((n): n is CandidateNode => !!n)
        : (nxFile ? [nxFile] : ['package.json', 'project.json'])
            .map((suffix) => parsed.nodes.get(`${id}:${suffix}`))
            .filter((n): n is CandidateNode => !!n);
    for (const node of candidates) {
      if (!allowed.has(node.path)) continue;
      if (anchors.has(node.id)) return { node, anchor: anchors.get(node.id)! };
      if (unavailable.has(node.id)) continue;
      // The file used to build structure must still equal the retained original.
      // This prevents attaching a checkout's current symbol to an older archive.
      let current: Buffer;
      try {
        const path = join(sourceRoot, node.path);
        assert.equal(
          await realpath(path),
          path,
          'Structure source escaped admission',
        );
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 8 * 1024 * 1024
        )
          continue;
        current = await readFile(path);
      } catch {
        continue;
      }
      const anchor = await archivedAnchor(
        provider,
        publication,
        node,
        textCache,
      );
      if (!anchor || hash(current) !== anchor.original_sha256) {
        unavailable.add(node.id);
        continue;
      }
      if (plan.kind === 'nx') {
        try {
          if (
            object(JSON.parse(current.toString('utf8')))['name'] !== node.label
          ) {
            unavailable.add(node.id);
            continue;
          }
        } catch {
          unavailable.add(node.id);
          continue;
        }
      }
      anchors.set(node.id, anchor);
      sourceTexts.set(node.path, current.toString('utf8'));
      return { node, anchor };
    }
    return null;
  };
  const graphNodes = new Map<string, Record<string, unknown>>();
  const assertions: Record<string, unknown>[] = [];
  const cite = (
    basis: Anchor,
    body: string,
    index: number,
    quote: string,
  ): Anchor => ({
    ...basis,
    text_start: Array.from(body.slice(0, index)).length,
    text_end:
      Array.from(body.slice(0, index)).length + Array.from(quote).length,
    quote,
    quote_sha256: hash(quote),
  });
  const edgeSupport = (
    edge: CandidateEdge,
    source: { node: CandidateNode; anchor: Anchor },
    target: { node: CandidateNode; anchor: Anchor },
  ): Anchor[] | null => {
    const sourceNode = source.node,
      targetNode = target.node;
    const sourceText = sourceTexts.get(sourceNode.path);
    const targetText = sourceTexts.get(targetNode.path);
    if (!sourceText || !targetText) return null;
    if (plan.kind === 'nx') {
      try {
        const selected = object(JSON.parse(sourceText));
        if (
          edge.nxType === 'implicit' &&
          !(
            sourceNode.path.endsWith('/project.json') ||
            sourceNode.path === 'project.json'
          )
        )
          return null;
        if (
          edge.nxType !== 'implicit' &&
          !(
            sourceNode.path.endsWith('/package.json') ||
            sourceNode.path === 'package.json'
          )
        )
          return null;
        if (
          sourceNode.path.endsWith('/project.json') ||
          sourceNode.path === 'project.json'
        ) {
          const dependencies = selected['implicitDependencies'];
          if (
            !Array.isArray(dependencies) ||
            !dependencies.includes(edge.target) ||
            dependencies.some(
              (value) => typeof value === 'string' && value.startsWith('!'),
            )
          )
            return null;
          const field = jsonFieldValueSpan(sourceText, 'implicitDependencies');
          const member = field
            ? jsonMemberString(field, edge.target, 'array-value')
            : null;
          return !field || !member || !Array.isArray(JSON.parse(field.value))
            ? null
            : [
                cite(source.anchor, sourceText, member.start, member.quote),
                target.anchor,
              ];
        }
        if (!(
          targetNode.path.endsWith('/package.json') ||
          targetNode.path === 'package.json'
        ))
          return null;
        const packageName = text(object(JSON.parse(targetText))['name']);
        const declared = [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies',
        ].flatMap((field) => {
          const dependencies = selected[field];
          if (!(
            dependencies !== null &&
            typeof dependencies === 'object' &&
            !Array.isArray(dependencies) &&
            Object.hasOwn(dependencies, packageName)
          ))
            return [];
          const span = jsonFieldValueSpan(sourceText, field);
          if (
            !span ||
            !Object.hasOwn(object(JSON.parse(span.value)), packageName)
          )
            return [];
          const member = jsonMemberString(span, packageName, 'key');
          return member ? [member] : [];
        });
        return declared.length !== 1
          ? null
          : [
              cite(
                source.anchor,
                sourceText,
                declared[0].start,
                declared[0].quote,
              ),
              target.anchor,
            ];
      } catch {
        return null;
      }
    }
    // Graft nodes are accepted only when their AST span fingerprints still
    // match the exact retained source. A name occurrence establishes a
    // candidate call name, not a resolved callee identity.
    const sourceSpan = spanBody(sourceText, sourceNode);
    const targetSpan = spanBody(targetText, targetNode);
    if (
      !sourceSpan ||
      !targetSpan ||
      hash(sourceSpan) !== sourceNode.bodyHash ||
      hash(targetSpan) !== targetNode.bodyHash
    )
      return null;
    if (edge.predicate === 'calls') {
      if (
        !sourceNode.path.endsWith('.swift') ||
        !targetNode.path.endsWith('.swift')
      )
        return null;
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(targetNode.label) ||
        targetNode.label === 'init' ||
        targetNode.label === 'deinit'
      )
        return null;
      const code = swiftCode(sourceText);
      if (!code) return null;
      const lines = code.split('\n');
      const body = lines
        .slice(sourceNode.line! - 1, sourceNode.endLine)
        .join('\n');
      const escaped = targetNode.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![A-Za-z0-9_$@])${escaped}\\s*\\(`, 'g');
      const match = [...body.matchAll(pattern)].find(
        (candidate) =>
          !/\b(?:func|subscript|macro|case)\s*$/.test(
            body.slice(0, candidate.index),
          ),
      );
      if (!match) return null;
      const prefix =
        lines.slice(0, sourceNode.line! - 1).join('\n') +
        (sourceNode.line! > 1 ? '\n' : '');
      const index = prefix.length + match.index;
      return [
        cite(source.anchor, sourceText, index, targetNode.label),
        target.anchor,
      ];
    }
    if (edge.predicate === 'contains')
      return sourceNode.kind === 'file' &&
        sourceNode.path === targetNode.path &&
        !!sourceNode.line &&
        !!sourceNode.endLine &&
        !!targetNode.line &&
        !!targetNode.endLine &&
        sourceNode.line <= targetNode.line &&
        sourceNode.endLine >= targetNode.endLine
        ? [source.anchor, target.anchor]
        : null;
    return null;
  };
  for (let edgeIndex = 0; edgeIndex < parsed.edges.length; edgeIndex++) {
    if (assertions.length >= plan.maxEdges) {
      skipped['edge-budget'] = parsed.edges.length - edgeIndex;
      break;
    }
    const edge = parsed.edges[edgeIndex];
    if (edge.source === edge.target) {
      skip('self-edge');
      continue;
    }
    if (!nodeFor(edge.source) || !nodeFor(edge.target)) {
      skip('unresolved-node');
      continue;
    }
    const source = await resolve(
      edge.source,
      plan.kind === 'nx'
        ? edge.nxType === 'implicit'
          ? 'project.json'
          : 'package.json'
        : null,
    );
    const target = await resolve(edge.target);
    if (!source || !target) {
      skip('unanchored-or-stale');
      continue;
    }
    const support = edgeSupport(edge, source, target);
    if (!support) {
      skip('unverified-relation');
      continue;
    }
    const idFor = (node: CandidateNode, anchor: Anchor) =>
      hash(
        canonical([
          publication.generation,
          node.id,
          node.path,
          anchor.original_sha256,
        ]),
      ).slice(0, 32);
    const a = idFor(source.node, source.anchor),
      b = idFor(target.node, target.anchor);
    for (const [id, item] of [
      [a, source],
      [b, target],
    ] as const)
      graphNodes.set(id, {
        id,
        kind: 'mention',
        label: item.node.label,
        provenance: 'extracted',
        anchors: [item.anchor],
      });
    assertions.push({
      id: hash(canonical([a, edge.predicate, b])).slice(0, 32),
      kind: 'relationship',
      subject: a,
      predicate:
        plan.kind === 'graft' && edge.predicate === 'calls'
          ? 'call-name-candidate'
          : edge.predicate,
      object: b,
      support,
      contrary: [],
      provenance: edge.provenance,
      lifecycle: 'active',
      supersedes: [],
    });
  }
  assert(
    assertions.length > 0,
    'No structure edges could be anchored to this archive',
  );
  const draft = {
    schema: 1,
    revision_set: {
      schema: 1,
      selections: [
        {
          source_id: publication.source.id,
          generation: publication.generation,
          manifest_sha256: publication.manifestSha256,
        },
      ],
    },
    parent: null,
    nodes: [...graphNodes.values()],
    assertions,
  };
  const draftPath = join(
    publication.task.directory,
    `archive-structure-draft-${hash(canonical(draft))}.json`,
  );
  await publishJson(draftPath, draft);
  const transport = await archiveTransport(publication.transport);
  const published = await transport.invoke('graph-publish', [draftPath]);
  assert.equal(published['status'], 'complete');
  const graphId = text(published['graph_id']);
  assert(/^[0-9a-f]{64}$/.test(graphId));
  const receipt = {
    schema: 1,
    kind: 'temari-archive-structure-publication',
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    artifactSha256: hash(artifactBytes),
    adapter: plan.kind,
    graphId,
    nodeCount: graphNodes.size,
    relationshipCount: assertions.length,
    skipped,
  };
  const receiptPath = join(
    publication.task.directory,
    `archive-structure-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return {
    graphId,
    receiptPath,
    draftPath,
    relationshipCount: assertions.length,
    skipped,
  };
}
