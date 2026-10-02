/** Declared main-document DrawingML image references in one pinned DOCX. */
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
const MAX_REFERENCES = 256;
const MAX_RELATIONSHIPS = 1000;

// The base media adapter validates every ZIP member, actual expansion, CRC,
// duplicate member and path. This worker reads only two bounded XML parts from
// that exact original, and refuses DTD/entity declarations at the XML parser.
const DRAWING_REFS_WORKER = String.raw`
import hashlib, json, os, sys, zipfile
from xml.parsers import expat

path, expected_sha = sys.argv[1:]
MAX_ORIGINAL = 8 * 1024 * 1024
MAX_XML = 1024 * 1024
MAX_REFS = 256
MAX_RELS = 1000
W = {'http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing',
     'http://purl.oclc.org/ooxml/wordprocessingml/main}drawing'}
DOCUMENT = {'http://schemas.openxmlformats.org/wordprocessingml/2006/main}document',
            'http://purl.oclc.org/ooxml/wordprocessingml/main}document'}
A = {'http://schemas.openxmlformats.org/drawingml/2006/main}blip',
     'http://purl.oclc.org/ooxml/drawingml/main}blip'}
EMBED = ('http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed',
         'http://purl.oclc.org/ooxml/officeDocument/relationships}embed')
LINK = ('http://schemas.openxmlformats.org/officeDocument/2006/relationships}link',
        'http://purl.oclc.org/ooxml/officeDocument/relationships}link')
REL = 'http://schemas.openxmlformats.org/package/2006/relationships}Relationship'
RELS = 'http://schemas.openxmlformats.org/package/2006/relationships}Relationships'

def sha(path):
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

def xml_part(archive, name, required):
    try:
        info = archive.getinfo(name)
    except KeyError:
        if required:
            raise ValueError('document-xml-missing')
        return None
    if info.file_size > MAX_XML:
        raise ValueError('xml-part-limit')
    with archive.open(info) as stream:
        data = stream.read(MAX_XML + 1)
        if len(data) > MAX_XML or stream.read(1):
            raise ValueError('xml-part-limit')
    return data

def parser_for(start, end=None):
    parser = expat.ParserCreate(namespace_separator='}')
    parser.StartElementHandler = start
    if end is not None:
        parser.EndElementHandler = end
    def refuse(*_args):
        raise ValueError('xml-dtd-or-entity-refused')
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.ExternalEntityRefHandler = refuse
    return parser

try:
    if sha(path) != expected_sha:
        raise ValueError('original-sha256-mismatch')
    references = []
    relationships = []
    seen_ids = set()
    with zipfile.ZipFile(path, 'r') as archive:
        doc = xml_part(archive, 'word/document.xml', True)
        drawing_depth = 0
        depth = 0
        def start_doc(name, attrs):
            global depth, drawing_depth
            depth += 1
            if depth > 128:
                raise ValueError('xml-depth-limit')
            if depth == 1 and name not in DOCUMENT:
                raise ValueError('document-root-invalid')
            if name in W:
                drawing_depth += 1
            if drawing_depth and name in A:
                embed = next((attrs[key] for key in EMBED if key in attrs), None)
                link = next((attrs[key] for key in LINK if key in attrs), None)
                if len(references) >= MAX_REFS:
                    raise ValueError('reference-limit')
                if any(value is not None and len(value) > 256 for value in (embed, link)):
                    raise ValueError('relationship-id-limit')
                references.append({'embed': embed, 'link': link})
        def end_doc(name):
            global depth, drawing_depth
            if name in W:
                drawing_depth -= 1
            depth -= 1
        parser_for(start_doc, end_doc).Parse(doc, True)

        rels = xml_part(archive, 'word/_rels/document.xml.rels', False)
        if rels is not None:
            rel_depth = 0
            def start_rel(name, attrs):
                global rel_depth
                rel_depth += 1
                if rel_depth > 128:
                    raise ValueError('xml-depth-limit')
                if rel_depth == 1 and name != RELS:
                    raise ValueError('relationships-root-invalid')
                if name == REL:
                    if rel_depth != 2:
                        raise ValueError('relationship-placement-invalid')
                    if len(relationships) >= MAX_RELS:
                        raise ValueError('relationship-limit')
                    rel_id = attrs.get('Id')
                    if not rel_id or len(rel_id) > 256 or rel_id in seen_ids:
                        raise ValueError('duplicate-or-invalid-relationship-id')
                    seen_ids.add(rel_id)
                    target = attrs.get('Target')
                    kind = attrs.get('Type')
                    mode = attrs.get('TargetMode')
                    if any(value is not None and len(value) > 4096 for value in (target, kind, mode)):
                        raise ValueError('relationship-value-limit')
                    relationships.append({'id': rel_id, 'target': target,
                                          'type': kind, 'mode': mode})
            def end_rel(_name):
                global rel_depth
                rel_depth -= 1
            parser_for(start_rel, end_rel).Parse(rels, True)
    if sha(path) != expected_sha:
        raise ValueError('original-changed-during-parse')
    print(json.dumps({'references': references, 'relationships': relationships}, separators=(',', ':')))
except (OSError, ValueError, RuntimeError, EOFError, expat.ExpatError,
        zipfile.BadZipFile, zipfile.LargeZipFile) as error:
    print(type(error).__name__, file=sys.stderr)
    sys.exit(2)
`;

export interface ArchiveDocxDrawingRefsPlan {
  readonly publicationPath: string;
  readonly sourcePath: string;
  readonly recoveredOriginalPath: string;
}

type Gap =
  | 'missing-embed-or-link'
  | 'linked-image-unsupported'
  | 'ambiguous-embed-and-link'
  | 'missing-relationship'
  | 'external-relationship'
  | 'wrong-relationship-type'
  | 'non-media-image-target'
  | 'missing-package-media';

export interface ArchiveDocxDrawingRefsReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-docx-drawing-refs';
  readonly policy: 'declared-main-document-drawingml-v1';
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
  readonly references: readonly {
    readonly index: number;
    readonly relationshipIdSha256: string | null;
    readonly member: { readonly name: string; readonly sha256: string; readonly bytes: number } | null;
    readonly gap: Gap | null;
  }[];
  readonly unreferencedMedia: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly currentOriginal: 'not-checked';
  readonly coverage: 'declared-main-document-drawingml-only';
  readonly visualMeaning: 'not-evaluated';
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function canonicalPackageTarget(value: string | null): string | null {
  if (!value || value.length > 4096 || value.startsWith('/') ||
      value.includes(String.fromCharCode(92)) || value.includes('%') ||
      value.includes('?') || value.includes('#') || value.includes(':') ||
      Array.from(value).some((char) => char.codePointAt(0)! <= 31 ||
        char.codePointAt(0) === 127)) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return `word/${value}`;
}

async function boundedOriginal(path: string): Promise<{ sha256: string; bytes: number }> {
  assert(isAbsolute(text(path)));
  const pathStat = await lstat(path);
  assert(pathStat.isFile() && pathStat.size <= MAX_ORIGINAL,
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

/** Parser can be tested on deliberately malformed packages without registration. */
export async function scanRecoveredDocxDrawingRefs(
  recoveredOriginalPath: string,
  expectedSha256: string,
  pythonExecutable: string,
): Promise<{
  references: readonly { embed: string | null; link: string | null }[];
  relationships: readonly {
    id: string; target: string | null; type: string | null; mode: string | null;
  }[];
}> {
  assert(isAbsolute(text(recoveredOriginalPath)) && isAbsolute(text(pythonExecutable)));
  digest(expectedSha256);
  const stat = await lstat(recoveredOriginalPath);
  assert(stat.isFile() && stat.size <= MAX_ORIGINAL, 'Bound regular recovered file required');
  const worker = await promisify(execFile)(pythonExecutable,
    ['-I', '-S', '-c', DRAWING_REFS_WORKER, recoveredOriginalPath, expectedSha256],
    { timeout: 30000, maxBuffer: MAX_RESPONSE, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert(Buffer.byteLength(worker.stdout) <= MAX_RESPONSE);
  const parsed = object(JSON.parse(worker.stdout));
  const references = list(parsed['references']).map((raw) => {
    const row = object(raw);
    const embed = optionalText(row['embed']);
    const link = optionalText(row['link']);
    assert((embed?.length ?? 0) <= 256 && (link?.length ?? 0) <= 256);
    return { embed, link };
  });
  assert(references.length <= MAX_REFERENCES);
  const relationships = list(parsed['relationships']).map((raw) => {
    const row = object(raw);
    const id = text(row['id']);
    const target = optionalText(row['target']);
    const type = optionalText(row['type']);
    const mode = optionalText(row['mode']);
    assert(id.length > 0 && id.length <= 256);
    assert([target, type, mode].every((v) => v === null || v.length <= 4096));
    return { id, target, type, mode };
  });
  assert(relationships.length <= MAX_RELATIONSHIPS);
  assert.equal(new Set(relationships.map((r) => r.id)).size, relationships.length);
  return { references, relationships };
}

const IMAGE_REL_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/image',
]);

/** An operator must explicitly recover the pinned original before this call. */
export async function inventoryArchiveDocxDrawingRefs(
  input: ArchiveDocxDrawingRefsPlan,
): Promise<{ receipt: ArchiveDocxDrawingRefsReceipt; receiptPath: string }> {
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
  assert.equal(base.receipt.original.sha256, digest(base.receipt.original.sha256));
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Current source registration changed',
  );
  await admission();
  const worker = await scanRecoveredDocxDrawingRefs(
    input.recoveredOriginalPath, base.receipt.original.sha256,
    publication.transport.python,
  );
  const relationships = new Map(worker.relationships.map((r) => [r.id, r]));
  const members = new Map(base.receipt.members.map((m) => [m.name, m]));
  const referenced = new Set<string>();
  const references = worker.references.map((row, index) => {
    for (const referencedId of [row.embed, row.link]) {
      if (!referencedId) continue;
      const referencedRel = relationships.get(referencedId);
      if (!referencedRel || referencedRel.mode === 'External') continue;
      assert(referencedRel.mode === null || referencedRel.mode === 'Internal',
        'Unsafe internal image relationship mode');
      assert(canonicalPackageTarget(referencedRel.target),
        'Unsafe internal image relationship target');
    }
    const id = row.embed ?? row.link;
    const relationshipIdSha256 = id === null ? null : hash(id);
    let gap: Gap | null = null;
    let member: (typeof base.receipt.members)[number] | null = null;
    if (row.embed && row.link) gap = 'ambiguous-embed-and-link';
    else if (row.link) gap = 'linked-image-unsupported';
    else if (!row.embed) gap = 'missing-embed-or-link';
    else {
      const rel = relationships.get(row.embed);
      if (!rel) gap = 'missing-relationship';
      else if (rel.mode === 'External') gap = 'external-relationship';
      else {
        const target = canonicalPackageTarget(rel.target);
        assert(target, 'Unsafe internal image relationship target');
        if (!IMAGE_REL_TYPES.has(rel.type ?? '')) gap = 'wrong-relationship-type';
        else if (!target.startsWith('word/media/')) gap = 'non-media-image-target';
        else {
          member = members.get(target) ?? null;
          if (member) referenced.add(target);
          else gap = 'missing-package-media';
        }
      }
    }
    return { index, relationshipIdSha256, member, gap };
  });
  const unreferencedMedia = base.receipt.members.filter((m) => !referenced.has(m.name));
  assert.deepEqual(await boundedOriginal(input.recoveredOriginalPath),
    base.receipt.original, 'Recovered original changed');
  await admission();
  assert.equal(hash((await readJsonWithBytes(input.publicationPath)).bytes),
    hash(saved.bytes), 'Publication changed during inventory');
  assert.equal(hash((await readJsonWithBytes(base.receiptPath)).bytes),
    baseMediaReceiptSha256, 'Base media receipt changed');
  assert.equal(hash(await readFile(modulePath)), adapterSha256,
    'DOCX drawing adapter changed during operation');
  const receipt: ArchiveDocxDrawingRefsReceipt = {
    schema: 1, kind: 'temari-archive-docx-drawing-refs',
    policy: 'declared-main-document-drawingml-v1',
    workerSha256: hash(DRAWING_REFS_WORKER), adapterSha256,
    baseMediaReceiptSha256,
    sourceId: publication.source.id, generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath,
    publicationSha256: hash(saved.bytes), sourcePath: base.receipt.sourcePath,
    original: base.receipt.original, references, unreferencedMedia,
    currentOriginal: 'not-checked',
    coverage: 'declared-main-document-drawingml-only',
    visualMeaning: 'not-evaluated',
  };
  const receiptPath = join(publication.task.directory,
    `archive-docx-drawing-refs-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
