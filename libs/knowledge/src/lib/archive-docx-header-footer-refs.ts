/** Bounded syntax inventory of DOCX header/footer DrawingML references. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { inventoryArchiveDocxMedia } from './archive-docx-media-inventory.js';
import { archiveTransport } from './archive-transport.js';
import { canonical, digest, hash, list, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

const MAX_ORIGINAL = 8 * 1024 * 1024;
const MAX_RESPONSE = 1024 * 1024;

// The base inventory already validates all ZIP members, real expansion and
// CRCs. This worker only reads bounded XML from the same original hash.
const HEADER_FOOTER_WORKER = String.raw`
import hashlib, json, os, sys, zipfile
from xml.parsers import expat

path, expected_sha = sys.argv[1:]
MAX_ORIGINAL = 8 * 1024 * 1024
MAX_XML = 1024 * 1024
MAX_XML_TOTAL = 8 * 1024 * 1024
MAX_DECL = 256
MAX_PARTS = 32
MAX_REFS = 256
MAX_RELS = 1000
W = ('http://schemas.openxmlformats.org/wordprocessingml/2006/main',
     'http://purl.oclc.org/ooxml/wordprocessingml/main')
A = ('http://schemas.openxmlformats.org/drawingml/2006/main',
     'http://purl.oclc.org/ooxml/drawingml/main')
R = ('http://schemas.openxmlformats.org/officeDocument/2006/relationships',
     'http://purl.oclc.org/ooxml/officeDocument/relationships')
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
DOCUMENT = {uri + '}document' for uri in W}
SECT = {uri + '}sectPr' for uri in W}
HEADER_REF = {uri + '}headerReference' for uri in W}
FOOTER_REF = {uri + '}footerReference' for uri in W}
HEADER_ROOT = {uri + '}hdr' for uri in W}
FOOTER_ROOT = {uri + '}ftr' for uri in W}
DRAWING = {uri + '}drawing' for uri in W}
BLIP = {uri + '}blip' for uri in A}
REL = P + '}Relationship'
RELS = P + '}Relationships'
IMAGE_TYPES = {uri + '/image' for uri in R}
HEADER_TYPES = {uri + '/header' for uri in R}
FOOTER_TYPES = {uri + '/footer' for uri in R}
total_xml = 0

def sha():
    if os.stat(path).st_size > MAX_ORIGINAL:
        raise ValueError('original-limit')
    h = hashlib.sha256()
    count = 0
    with open(path, 'rb') as stream:
        while block := stream.read(65536):
            count += len(block)
            if count > MAX_ORIGINAL:
                raise ValueError('original-limit')
            h.update(block)
    return h.hexdigest()

def part_bytes(archive, name, required=False):
    global total_xml
    try:
        info = archive.getinfo(name)
    except KeyError:
        if required:
            raise ValueError('required-xml-missing')
        return None
    if info.file_size > MAX_XML or total_xml + info.file_size > MAX_XML_TOTAL:
        raise ValueError('xml-limit')
    with archive.open(info) as stream:
        data = stream.read(MAX_XML + 1)
        if len(data) > MAX_XML or stream.read(1):
            raise ValueError('xml-part-limit')
    total_xml += len(data)
    if total_xml > MAX_XML_TOTAL:
        raise ValueError('xml-total-limit')
    return data

def parse_xml(data, start, end=None):
    parser = expat.ParserCreate(namespace_separator='}')
    parser.StartElementHandler = start
    if end is not None:
        parser.EndElementHandler = end
    def refuse(*_args):
        raise ValueError('xml-dtd-or-entity-refused')
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.ExternalEntityRefHandler = refuse
    parser.Parse(data, True)

def attr(attrs, namespaces, local):
    return next((attrs[uri + '}' + local] for uri in namespaces
                 if uri + '}' + local in attrs), None)

def id_digest(value):
    return None if value is None else hashlib.sha256(value.encode()).hexdigest()

def relationships(archive, name):
    data = part_bytes(archive, name)
    if data is None:
        return {}
    found = {}
    depth = 0
    def start(tag, attrs):
        nonlocal depth
        depth += 1
        if depth > 128:
            raise ValueError('xml-depth-limit')
        if depth == 1 and tag != RELS:
            raise ValueError('relationships-root-invalid')
        if tag == REL:
            if depth != 2 or len(found) >= MAX_RELS:
                raise ValueError('relationship-placement-or-limit')
            rid = attrs.get('Id')
            if not rid or len(rid) > 256 or rid in found:
                raise ValueError('duplicate-or-invalid-relationship-id')
            target = attrs.get('Target')
            kind = attrs.get('Type')
            mode = attrs.get('TargetMode')
            if any(v is not None and len(v) > 4096
                   for v in (target, kind, mode)):
                raise ValueError('relationship-value-limit')
            found[rid] = {'target': target, 'type': kind, 'mode': mode}
    def end(_tag):
        nonlocal depth
        depth -= 1
    parse_xml(data, start, end)
    return found

def canonical_target(value):
    if (not value or len(value) > 4096 or value.startswith('/')
            or chr(92) in value or any(c in value for c in '%?#:')
            or any(ord(c) <= 31 or ord(c) == 127 for c in value)):
        return None
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts):
        return None
    return 'word/' + value

def checked_internal(rel):
    if rel['mode'] == 'External':
        return None
    if rel['mode'] not in (None, 'Internal'):
        raise ValueError('unsafe-internal-mode')
    target = canonical_target(rel['target'])
    if target is None:
        raise ValueError('unsafe-internal-target')
    return target

def declarations_from_document(data):
    rows = []
    stack = []
    def start(tag, attrs):
        if len(stack) >= 128:
            raise ValueError('xml-depth-limit')
        if not stack and tag not in DOCUMENT:
            raise ValueError('document-root-invalid')
        if stack and stack[-1] in SECT and tag in HEADER_REF | FOOTER_REF:
            if len(rows) >= MAX_DECL:
                raise ValueError('declaration-limit')
            kind = 'header' if tag in HEADER_REF else 'footer'
            rid = attr(attrs, R, 'id')
            if rid is not None and len(rid) > 256:
                raise ValueError('relationship-id-limit')
            variant = attr(attrs, W, 'type')
            if variant not in ('default', 'first', 'even'):
                variant = 'unknown'
            rows.append({'index': len(rows), 'kind': kind,
                         'variant': variant, 'id': rid})
        stack.append(tag)
    def end(_tag):
        stack.pop()
    parse_xml(data, start, end)
    return rows

def image_refs(data, root_kind, remaining):
    rows = []
    stack = []
    drawing_depth = 0
    expected_root = HEADER_ROOT if root_kind == 'header' else FOOTER_ROOT
    def start(tag, attrs):
        nonlocal drawing_depth
        if len(stack) >= 128:
            raise ValueError('xml-depth-limit')
        if not stack and tag not in expected_root:
            raise ValueError('header-footer-root-invalid')
        stack.append(tag)
        if tag in DRAWING:
            drawing_depth += 1
        if drawing_depth and tag in BLIP:
            if len(rows) >= remaining:
                raise ValueError('drawing-reference-limit')
            embed = attr(attrs, R, 'embed')
            link = attr(attrs, R, 'link')
            if any(v is not None and len(v) > 256 for v in (embed, link)):
                raise ValueError('relationship-id-limit')
            rows.append({'index': len(rows), 'embed': embed, 'link': link})
    def end(tag):
        nonlocal drawing_depth
        if tag in DRAWING:
            drawing_depth -= 1
        stack.pop()
    parse_xml(data, start, end)
    return rows

try:
    if sha() != expected_sha:
        raise ValueError('original-sha256-mismatch')
    result_declarations = []
    selected_parts = {}
    with zipfile.ZipFile(path, 'r') as archive:
        doc = part_bytes(archive, 'word/document.xml', True)
        declarations = declarations_from_document(doc)
        document_rels = relationships(archive, 'word/_rels/document.xml.rels')
        for declaration in declarations:
            kind = declaration['kind']
            rid = declaration['id']
            item = {'index': declaration['index'], 'kind': kind,
                    'variant': declaration['variant'],
                    'relationshipIdSha256': id_digest(rid),
                    'partName': None, 'gap': None}
            if not rid:
                item['gap'] = 'missing-relationship-id'
            elif rid not in document_rels:
                item['gap'] = 'missing-relationship'
            else:
                rel = document_rels[rid]
                target = checked_internal(rel)
                if target is None:
                    item['gap'] = 'external-relationship'
                elif rel['type'] not in (HEADER_TYPES if kind == 'header' else FOOTER_TYPES):
                    item['gap'] = 'wrong-relationship-type'
                elif not (target.startswith('word/' + kind)
                          and target.endswith('.xml')
                          and '/' not in target[5:]):
                    item['gap'] = 'wrong-part-location'
                elif target not in archive.namelist():
                    item['gap'] = 'missing-part'
                else:
                    if target not in selected_parts and len(selected_parts) >= MAX_PARTS:
                        raise ValueError('selected-part-limit')
                    selected_parts[target] = kind
                    item['partName'] = target
            result_declarations.append(item)

        result_parts = []
        total_refs = 0
        for part_name, kind in selected_parts.items():
            data = part_bytes(archive, part_name, True)
            part_refs = image_refs(data, kind, MAX_REFS - total_refs)
            total_refs += len(part_refs)
            if total_refs > MAX_REFS:
                raise ValueError('drawing-reference-limit')
            rel_name = 'word/_rels/' + part_name[5:] + '.rels'
            rels = relationships(archive, rel_name)
            resolved = []
            for ref in part_refs:
                embed = ref['embed']
                link = ref['link']
                for referenced_id in (embed, link):
                    if referenced_id in rels:
                        checked_internal(rels[referenced_id])
                item = {'index': ref['index'],
                        'relationshipIdSha256': id_digest(embed or link),
                        'memberName': None, 'gap': None}
                if embed and link:
                    item['gap'] = 'ambiguous-embed-and-link'
                elif link:
                    item['gap'] = 'linked-image-unsupported'
                elif not embed:
                    item['gap'] = 'missing-embed-or-link'
                elif embed not in rels:
                    item['gap'] = 'missing-relationship'
                else:
                    rel = rels[embed]
                    target = checked_internal(rel)
                    if target is None:
                        item['gap'] = 'external-relationship'
                    elif rel['type'] not in IMAGE_TYPES:
                        item['gap'] = 'wrong-relationship-type'
                    elif not target.startswith('word/media/'):
                        item['gap'] = 'non-media-image-target'
                    else:
                        item['memberName'] = target
                resolved.append(item)
            result_parts.append({'name': part_name, 'kind': kind,
                                 'references': resolved})
    if sha() != expected_sha:
        raise ValueError('original-changed-during-parse')
    print(json.dumps({'declarations': result_declarations,
                      'parts': result_parts}, separators=(',', ':')))
except (OSError, ValueError, RuntimeError, EOFError, expat.ExpatError,
        zipfile.BadZipFile, zipfile.LargeZipFile) as error:
    print(type(error).__name__, file=sys.stderr)
    sys.exit(2)
`;

export interface ArchiveDocxHeaderFooterPlan {
  readonly publicationPath: string;
  readonly sourcePath: string;
  readonly recoveredOriginalPath: string;
}

type DeclarationGap = 'missing-relationship-id' | 'missing-relationship' |
  'external-relationship' | 'wrong-relationship-type' |
  'wrong-part-location' | 'missing-part';
type ReferenceGap = 'ambiguous-embed-and-link' | 'linked-image-unsupported' |
  'missing-embed-or-link' | 'missing-relationship' |
  'external-relationship' | 'wrong-relationship-type' |
  'non-media-image-target' | 'missing-package-media';
type MediaMember = { readonly name: string; readonly sha256: string; readonly bytes: number };

export interface ArchiveDocxHeaderFooterReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-docx-header-footer-refs';
  readonly policy: 'declared-header-footer-drawingml-v1';
  readonly workerSha256: string;
  readonly adapterSha256: string;
  readonly baseMediaReceiptSha256: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly sourcePath: string;
  readonly original: { readonly sha256: string; readonly bytes: number };
  readonly declarations: readonly {
    readonly index: number;
    readonly kind: 'header' | 'footer';
    readonly variant: 'default' | 'first' | 'even' | 'unknown';
    readonly relationshipIdSha256: string | null;
    readonly partName: string | null;
    readonly gap: DeclarationGap | null;
  }[];
  readonly parts: readonly {
    readonly name: string;
    readonly kind: 'header' | 'footer';
    readonly references: readonly {
      readonly index: number;
      readonly relationshipIdSha256: string | null;
      readonly member: MediaMember | null;
      readonly gap: ReferenceGap | null;
    }[];
  }[];
  /** Package media not mapped by these selected header/footer parts only. */
  readonly notReferencedBySelectedHeaderFooterParts: readonly MediaMember[];
  readonly currentOriginal: 'not-checked';
  readonly coverage: 'declared-header-footer-drawingml-only';
  readonly visualMeaning: 'not-evaluated';
}

interface WorkerParsed {
  readonly declarations: ArchiveDocxHeaderFooterReceipt['declarations'];
  readonly parts: readonly {
    readonly name: string;
    readonly kind: 'header' | 'footer';
    readonly references: readonly {
      readonly index: number;
      readonly relationshipIdSha256: string | null;
      readonly memberName: string | null;
      readonly gap: Exclude<ReferenceGap, 'missing-package-media'> | null;
    }[];
  }[];
}

function maybeText(value: unknown): string | null {
  return value === null ? null : text(value);
}

async function boundedOriginal(path: string): Promise<{ sha256: string; bytes: number }> {
  assert(isAbsolute(text(path)));
  const entry = await lstat(path);
  assert(entry.isFile() && entry.size <= MAX_ORIGINAL,
    'Bound regular recovered file required');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size <= MAX_ORIGINAL,
      'Bound regular recovered file required');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const block = Buffer.allocUnsafe(65536);
      const result = await handle.read(block, 0, block.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      assert(bytes <= MAX_ORIGINAL, 'Recovered original exceeds bound');
      chunks.push(block.subarray(0, result.bytesRead));
    }
    return { sha256: hash(Buffer.concat(chunks)), bytes };
  } finally {
    await handle.close();
  }
}

function parseWorker(value: unknown): WorkerParsed {
  const raw = object(value);
  const declarations = list(raw['declarations']).map((entry, index) => {
    const row = object(entry);
    assert.equal(row['index'], index);
    const kind = text(row['kind']);
    const variant = text(row['variant']);
    const partName = maybeText(row['partName']);
    const gap = maybeText(row['gap']);
    assert(kind === 'header' || kind === 'footer');
    assert(['default', 'first', 'even', 'unknown'].includes(variant));
    assert(partName === null || /^word\/(header|footer)[^/]*\.xml$/.test(partName));
    assert(gap === null || [
      'missing-relationship-id', 'missing-relationship',
      'external-relationship', 'wrong-relationship-type',
      'wrong-part-location', 'missing-part',
    ].includes(gap));
    const relationshipIdSha256 = maybeText(row['relationshipIdSha256']);
    if (relationshipIdSha256 !== null) digest(relationshipIdSha256);
    return { index, kind: kind as 'header' | 'footer',
      variant: variant as 'default' | 'first' | 'even' | 'unknown',
      relationshipIdSha256, partName, gap: gap as DeclarationGap | null };
  });
  assert(declarations.length <= 256);
  const parts = list(raw['parts']).map((entry) => {
    const row = object(entry);
    const name = text(row['name']);
    const kind = text(row['kind']);
    assert(kind === 'header' || kind === 'footer');
    assert(new RegExp(`^word/${kind}[^/]*\\.xml$`).test(name));
    const references = list(row['references']).map((entry, index) => {
      const ref = object(entry);
      assert.equal(ref['index'], index);
      const relationshipIdSha256 = maybeText(ref['relationshipIdSha256']);
      if (relationshipIdSha256 !== null) digest(relationshipIdSha256);
      const memberName = maybeText(ref['memberName']);
      assert(memberName === null || /^word\/media\/[^/]+(?:\/[^/]+)*$/.test(memberName));
      const gap = maybeText(ref['gap']);
      assert(gap === null || [
        'ambiguous-embed-and-link', 'linked-image-unsupported',
        'missing-embed-or-link', 'missing-relationship',
        'external-relationship', 'wrong-relationship-type',
        'non-media-image-target',
      ].includes(gap));
      return { index, relationshipIdSha256, memberName,
        gap: gap as Exclude<ReferenceGap, 'missing-package-media'> | null };
    });
    return { name, kind: kind as 'header' | 'footer', references };
  });
  assert(parts.length <= 32);
  assert.equal(new Set(parts.map((p) => p.name)).size, parts.length);
  assert(parts.reduce((sum, p) => sum + p.references.length, 0) <= 256);
  return { declarations, parts };
}

/** One explicitly recovered original; no new Registrar operation or hosted call. */
export async function inventoryArchiveDocxHeaderFooterRefs(
  input: ArchiveDocxHeaderFooterPlan,
): Promise<{ receipt: ArchiveDocxHeaderFooterReceipt; receiptPath: string }> {
  assert.deepEqual(Object.keys(input).sort(), [
    'publicationPath', 'recoveredOriginalPath', 'sourcePath',
  ]);
  const modulePath = fileURLToPath(import.meta.url);
  const adapterSha256 = hash(await readFile(modulePath));
  const base = await inventoryArchiveDocxMedia(input);
  const baseMediaReceiptSha256 = hash(canonical(base.receipt));
  assert.equal(hash((await readJsonWithBytes(base.receiptPath)).bytes),
    baseMediaReceiptSha256, 'Base media receipt changed');
  const saved = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(saved.bytes.toString('utf8'), canonical(publication));
  assert.equal(publication.preservation, 'complete-admitted');
  assert.equal(base.receipt.publicationSha256, hash(saved.bytes));
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Current source registration changed',
  );
  await admission();
  const path = input.recoveredOriginalPath;
  assert.deepEqual(await boundedOriginal(path), base.receipt.original,
    'Recovered original changed before XML scan');
  const worker = await promisify(execFile)(publication.transport.python,
    ['-I', '-S', '-c', HEADER_FOOTER_WORKER, path, base.receipt.original.sha256],
    { timeout: 30000, maxBuffer: MAX_RESPONSE, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert(Buffer.byteLength(worker.stdout) <= MAX_RESPONSE, 'Worker response exceeds bound');
  const parsed = parseWorker(JSON.parse(worker.stdout));
  const members = new Map(base.receipt.members.map((m) => [m.name, m]));
  const referenced = new Set<string>();
  const parts = parsed.parts.map((part) => ({
    name: part.name, kind: part.kind,
    references: part.references.map((ref) => {
      const name = ref.memberName;
      const member = name === null ? null : members.get(name) ?? null;
      if (member) referenced.add(member.name);
      const gap = name !== null && member === null
        ? 'missing-package-media' as const : ref.gap;
      return { index: ref.index, relationshipIdSha256: ref.relationshipIdSha256,
        member, gap };
    }),
  }));
  const notReferencedBySelectedHeaderFooterParts = base.receipt.members.filter(
    (m) => !referenced.has(m.name));
  assert.deepEqual(await boundedOriginal(path), base.receipt.original,
    'Recovered original changed during XML scan');
  await admission();
  assert.equal(hash((await readJsonWithBytes(input.publicationPath)).bytes),
    hash(saved.bytes), 'Publication changed during inventory');
  assert.equal(hash((await readJsonWithBytes(base.receiptPath)).bytes),
    baseMediaReceiptSha256, 'Base media receipt changed');
  assert.equal(hash(await readFile(modulePath)), adapterSha256,
    'DOCX header/footer adapter changed during operation');
  const receipt: ArchiveDocxHeaderFooterReceipt = {
    schema: 1, kind: 'temari-archive-docx-header-footer-refs',
    policy: 'declared-header-footer-drawingml-v1',
    workerSha256: hash(HEADER_FOOTER_WORKER), adapterSha256,
    baseMediaReceiptSha256,
    sourceId: publication.source.id, generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath,
    publicationSha256: hash(saved.bytes), sourcePath: base.receipt.sourcePath,
    original: base.receipt.original,
    declarations: parsed.declarations,
    parts, notReferencedBySelectedHeaderFooterParts,
    currentOriginal: 'not-checked',
    coverage: 'declared-header-footer-drawingml-only',
    visualMeaning: 'not-evaluated',
  };
  const receiptPath = join(publication.task.directory,
    `archive-docx-header-footer-refs-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
