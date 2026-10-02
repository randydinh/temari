import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { inventoryArchiveDocxHeaderFooterRefs } from './archive-docx-header-footer-refs.js';
import { loadArchivePublication } from './archive-intake.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: recovered local-only DOCX pins declared header/footer image references and refuses unsafe XML', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python, registrarSource,
    documents: [{ path: 'seed.txt', bytes: Buffer.from('local-only fixture\n') }],
  });
  const names = [
    'sections.docx', 'unsafe-doc-target.docx', 'unsafe-image-target.docx',
    'duplicate-part-rel.docx', 'dtd-header.docx', 'bad-header-root.docx',
    'over-refs.docx', 'over-parts.docx', 'over-total-xml.docx',
  ];
  const paths = names.map((name) => join(f.base, 'sources', name));
  const fixture = String.raw`
import sys, zipfile
(good, unsafe_doc, unsafe_image, duplicate_part_rel, dtd_header,
 bad_header_root, over_refs, over_parts, over_total) = sys.argv[1:]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
IMAGE = R + '/image'
HEADER = R + '/header'
FOOTER = R + '/footer'
TYPES = b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
def declaration(kind, rid, variant='default'):
    return '<w:' + kind + 'Reference w:type="' + variant + '"' + (
        ' r:id="' + rid + '"' if rid else '') + '/>'
def document(entries):
    return ('<w:document xmlns:w="' + W + '" xmlns:a="' + A + '" xmlns:r="' + R + '"><w:body>'
            '<w:drawing><a:blip r:embed="rBodyImg"/></w:drawing>'
            '<w:sectPr>' + ''.join(entries) + '</w:sectPr></w:body></w:document>').encode()
def relationship(rid, kind, target, mode=''):
    return '<Relationship Id="' + rid + '" Type="' + kind + '" Target="' + target + '"' + (
        ' TargetMode="' + mode + '"' if mode else '') + '/>'
def relationships(entries):
    return ('<Relationships xmlns="' + P + '">' + ''.join(entries) + '</Relationships>').encode()
def blip(attr, rid):
    return '<w:drawing><a:blip' + (' r:' + attr + '="' + rid + '"' if attr else '') + '/></w:drawing>'
def part(kind, drawings):
    root = 'hdr' if kind == 'header' else 'ftr'
    return ('<w:' + root + ' xmlns:w="' + W + '" xmlns:a="' + A + '" xmlns:r="' + R + '">'
            + ''.join(drawings) + '</w:' + root + '>').encode()

doc = document([
    declaration('header', 'rH1'), declaration('header', 'rH1', 'even'),
    declaration('footer', 'rF1', 'first'),
    declaration('header', 'rMissing'), declaration('header', 'rExt'),
    declaration('header', 'rWrong'), declaration('header', 'rAbsent'),
    declaration('header', 'rBadPart'), declaration('header', ''),
])
doc_rels = relationships([
    relationship('rH1', HEADER, 'header1.xml'),
    relationship('rF1', FOOTER, 'footer1.xml'),
    relationship('rBodyImg', IMAGE, 'media/body.png'),
    relationship('rExt', HEADER, 'https://example.test/header.xml', 'External'),
    relationship('rWrong', R + '/hyperlink', 'header1.xml'),
    relationship('rAbsent', HEADER, 'header404.xml'),
    relationship('rBadPart', HEADER, 'footer1.xml'),
])
header = part('header', [
    blip('embed', 'rImg1'), blip('embed', 'rImg1'),
    blip('embed', 'rGone'), blip('embed', 'rExt'),
    blip('embed', 'rWrong'), blip('embed', 'rMissing'),
    blip('link', 'rLink'), blip('', ''),
])
footer = part('footer', [blip('embed', 'rImg1')])
header_rels = relationships([
    relationship('rImg1', IMAGE, 'media/used.png'),
    relationship('rGone', IMAGE, 'media/gone.png'),
    relationship('rExt', IMAGE, 'https://example.test/image.png', 'External'),
    relationship('rWrong', R + '/hyperlink', 'media/used.png'),
    relationship('rLink', IMAGE, 'https://example.test/linked.png', 'External'),
])
footer_rels = relationships([relationship('rImg1', IMAGE, 'media/footer.png')])
def write(path, document_xml=doc, document_rels=doc_rels,
          header_xml=header, header_relationships=header_rels,
          extra=None):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', TYPES)
        z.writestr('word/document.xml', document_xml)
        z.writestr('word/_rels/document.xml.rels', document_rels)
        z.writestr('word/header1.xml', header_xml)
        z.writestr('word/_rels/header1.xml.rels', header_relationships)
        z.writestr('word/footer1.xml', footer)
        z.writestr('word/_rels/footer1.xml.rels', footer_rels)
        z.writestr('word/media/used.png', b'header media bytes')
        z.writestr('word/media/footer.png', b'footer media bytes')
        z.writestr('word/media/body.png', b'body media bytes')
        z.writestr('word/media/unreferenced.png', b'unreferenced media bytes')
        for name, data in (extra or {}).items():
            z.writestr(name, data)
write(good)
write(unsafe_doc, document_rels=doc_rels.replace(
    b'Target="header1.xml"', b'Target="../header1.xml"').replace(
    ('Id="rH1" Type="' + HEADER + '"').encode(),
    ('Id="rH1" Type="' + R + '/hyperlink"').encode()))
write(unsafe_image, header_relationships=header_rels.replace(
    b'Target="media/used.png"',
    ('Target="media' + chr(92) + 'used.png"').encode()))
write(duplicate_part_rel, header_relationships=header_rels.replace(
    b'</Relationships>',
    (relationship('rImg1', IMAGE, 'media/used.png') + '</Relationships>').encode()))
write(dtd_header, header_xml=b'<!DOCTYPE x [<!ENTITY x "bad">]>' + header)
write(bad_header_root, header_xml=header.replace(b'w:hdr', b'w:notHeader'))
write(over_refs, header_xml=part('header', [blip('embed', 'rImg1')] * 257))
many = [(f'rH{i}', f'header{i}.xml') for i in range(1, 34)]
many_doc = document([declaration('header', rid) for rid, _ in many])
many_rels = relationships([relationship(rid, HEADER, target) for rid, target in many])
write(over_parts, document_xml=many_doc, document_rels=many_rels,
      extra={'word/header' + str(i) + '.xml': part('header', []) for i in range(2, 34)})
wide = [(f'rH{i}', f'header{i}.xml') for i in range(1, 10)]
wide_doc = document([declaration('header', rid) for rid, _ in wide])
wide_rels = relationships([relationship(rid, HEADER, target) for rid, target in wide])
large = part('header', [])
large = large.replace(b'</w:hdr>', b' ' * 950000 + b'</w:hdr>')
write(over_total, document_xml=wide_doc, document_rels=wide_rels,
      header_xml=large,
      extra={'word/header' + str(i) + '.xml': large for i in range(2, 10)})
`;
  await exec(python, ['-I', '-S', '-c', fixture, ...paths],
    { timeout: 30000 });
  const original = await readFile(paths[0]);
  const environment = {
    PATH: '/usr/bin:/bin', PYTHONPATH: join(registrarSource, 'src'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  };
  async function cli(route: 'archive' | 'sources', args: string[]) {
    const result = await exec(python,
      ['-B', '-m', 'knowledge_agent.cli', route, '--workspace',
        join(f.base, 'state'), ...args],
      { env: environment, timeout: 60000, maxBuffer: 1_048_576 });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }
  assert.equal((await cli('sources', ['set-sharing', f.source.id, 'local-only']))['sharing'],
    'local-only');
  const task = {
    id: 'docx-header-footer', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-docx-header-footer',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [{ task, source: f.source, readScope: 'source-root',
      requestKey: 'docx-header-footer-v1',
      transport: { python, registrarSource, workspace: join(f.base, 'state') },
    }],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const pinnedPublicationPath: string = publicationPath;
  const publication = await loadArchivePublication(publicationPath);
  assert.equal(publication.preservation, 'complete-admitted');
  for (const path of paths) await rm(path);
  async function recover(sourcePath: string) {
    const recoveredOriginalPath = join(f.base, `recovered-${sourcePath}`);
    await cli('archive', [
      'recover', f.source.id, publication.generation,
      sourcePath, recoveredOriginalPath,
    ]);
    return { publicationPath: pinnedPublicationPath, sourcePath, recoveredOriginalPath };
  }
  const plan = await recover(names[0]);
  assert.deepEqual(await readFile(plan.recoveredOriginalPath), original);
  const { receipt, receiptPath } = await inventoryArchiveDocxHeaderFooterRefs(plan);
  assert.equal(receipt.coverage, 'declared-header-footer-drawingml-only');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.deepEqual(receipt.original, { sha256: hash(original), bytes: original.length });
  assert.equal(receipt.declarations.length, 9);
  assert.deepEqual(receipt.declarations.map((d) => d.gap), [
    null, null, null, 'missing-relationship', 'external-relationship',
    'wrong-relationship-type', 'missing-part', 'wrong-part-location',
    'missing-relationship-id',
  ]);
  assert.deepEqual(receipt.declarations.slice(0, 2).map((d) => d.partName),
    ['word/header1.xml', 'word/header1.xml']);
  assert.deepEqual(receipt.declarations.slice(0, 3).map((d) => d.variant),
    ['default', 'even', 'first']);
  assert.deepEqual(receipt.parts.map((p) => p.name),
    ['word/header1.xml', 'word/footer1.xml']);
  assert.deepEqual(receipt.parts[0].references.map((r) => r.gap), [
    null, null, 'missing-package-media', 'external-relationship',
    'wrong-relationship-type', 'missing-relationship',
    'linked-image-unsupported', 'missing-embed-or-link',
  ]);
  assert.deepEqual(receipt.parts[0].references.slice(0, 2).map((r) => r.member?.sha256),
    [hash('header media bytes'), hash('header media bytes')]);
  assert.equal(receipt.parts[1].references[0].member?.sha256,
    hash('footer media bytes'));
  assert.deepEqual(receipt.notReferencedBySelectedHeaderFooterParts.map((m) => m.name),
    ['word/media/body.png', 'word/media/unreferenced.png']);
  assert.equal((await inventoryArchiveDocxHeaderFooterRefs(plan)).receiptPath,
    receiptPath);
  const receiptBytes = await readFile(receiptPath, 'utf8');
  assert(!receiptBytes.includes(plan.recoveredOriginalPath));
  assert(!receiptBytes.includes('header media bytes'));
  assert(!receiptBytes.includes('https://example.test'));
  assert(!receiptBytes.includes('rH1'));
  assert.match(receipt.baseMediaReceiptSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.workerSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.adapterSha256, /^[a-f0-9]{64}$/);

  for (const name of names.slice(1)) {
    const bad = await recover(name);
    await assert.rejects(() => inventoryArchiveDocxHeaderFooterRefs(bad));
  }
  await writeFile(plan.recoveredOriginalPath,
    Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(() => inventoryArchiveDocxHeaderFooterRefs(plan),
    /Recovered DOCX does not match retained original/);
  await writeFile(plan.recoveredOriginalPath, original);
  assert.equal((await cli('sources', ['disable', f.source.id]))['enabled'], false);
  await assert.rejects(() => inventoryArchiveDocxHeaderFooterRefs(plan),
    /Admitted source disabled|Source registration changed/);
});
