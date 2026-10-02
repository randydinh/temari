import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import {
  inventoryArchiveDocxDrawingRefs,
  scanRecoveredDocxDrawingRefs,
} from './archive-docx-drawing-refs.js';
import { loadArchivePublication } from './archive-intake.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: recovered local-only DOCX maps declared main-document DrawingML references with explicit gaps', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python, registrarSource,
    documents: [{ path: 'seed.txt', bytes: Buffer.from('local-only fixture\n') }],
  });
  const originalPath = join(f.base, 'sources/drawings.docx');
  const unsafePath = join(f.base, 'sources/unsafe.docx');
  const unsafeWrongTypePath = join(f.base, 'sources/unsafe-wrong-type.docx');
  const charRefTargetPath = join(f.base, 'sources/control-char-target.docx');
  const duplicateRelPath = join(f.base, 'duplicate-rel.docx');
  const dtdPath = join(f.base, 'dtd.docx');
  const badXmlPath = join(f.base, 'bad-xml.docx');
  const badDocumentRootPath = join(f.base, 'bad-document-root.docx');
  const badRelationshipsRootPath = join(f.base, 'bad-relationships-root.docx');
  const backslashTargetPath = join(f.base, 'sources/backslash-target.docx');
  const nulTargetPath = join(f.base, 'nul-target.docx');
  const overRefsPath = join(f.base, 'over-refs.docx');
  const overDocumentPath = join(f.base, 'over-document.docx');
  const overRelsPath = join(f.base, 'over-rels.docx');
  const fixture = String.raw`
import sys, zipfile
good, unsafe, unsafe_wrong_type, char_ref_target, duplicate_rel, dtd, bad_xml, bad_doc_root, bad_rels_root, backslash_target, nul_target, over_refs, over_document, over_rels = sys.argv[1:]
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
IMAGE = R + '/image'
def blip(attribute, value):
    return '<w:drawing><a:blip r:' + attribute + '="' + value + '"/></w:drawing>'
drawings = ''.join([
    blip('embed', 'rId1'), blip('embed', 'rId1'),
    blip('embed', 'rIdMissing'), blip('embed', 'rIdExt'),
    blip('embed', 'rIdWrong'), blip('embed', 'rIdAbsent'),
    blip('link', 'rIdLink'),
    '<w:drawing><a:blip/></w:drawing>',
])
doc = ('<w:document xmlns:w="' + W + '" xmlns:a="' + A + '" xmlns:r="' + R + '">'
       '<w:body>' + drawings + '</w:body></w:document>').encode()
rels = ('<Relationships xmlns="' + P + '">'
        '<Relationship Id="rId1" Type="' + IMAGE + '" Target="media/used.png"/>'
        '<Relationship Id="rIdExt" Type="' + IMAGE + '" TargetMode="External" Target="https://example.test/image.png"/>'
        '<Relationship Id="rIdWrong" Type="' + R + '/hyperlink" Target="media/used.png"/>'
        '<Relationship Id="rIdAbsent" Type="' + IMAGE + '" Target="media/gone.png"/>'
        '<Relationship Id="rIdLink" Type="' + IMAGE + '" TargetMode="External" Target="https://example.test/linked.png"/>'
        '</Relationships>').encode()
types = b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
def write(path, document=doc, relationships=rels):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', types)
        z.writestr('word/document.xml', document)
        z.writestr('word/_rels/document.xml.rels', relationships)
        z.writestr('word/media/used.png', b'used image bytes')
        z.writestr('word/media/unreferenced.png', b'unreferenced image bytes')
write(good)
unsafe_doc = doc.replace(b'</w:body>', (blip('embed', 'rIdUnsafe') + '</w:body>').encode())
def with_target(target):
    return rels.replace(b'</Relationships>',
        ('<Relationship Id="rIdUnsafe" Type="' + IMAGE + '" Target="' + target + '"/></Relationships>').encode())
write(unsafe, document=unsafe_doc, relationships=with_target('../media/used.png'))
write(unsafe_wrong_type, document=unsafe_doc,
    relationships=with_target('../media/used.png').replace(
        ('Id="rIdUnsafe" Type="' + IMAGE + '"').encode(),
        ('Id="rIdUnsafe" Type="' + R + '/hyperlink"').encode()))
write(char_ref_target, document=unsafe_doc,
    relationships=with_target('media/foo&#xA;bar.png'))
write(duplicate_rel, relationships=rels.replace(b'</Relationships>',
    ('<Relationship Id="rId1" Type="' + IMAGE + '" Target="media/used.png"/></Relationships>').encode()))
write(dtd, document=b'<!DOCTYPE x [<!ENTITY secret "x">]>' + doc)
write(bad_xml, document=doc[:-13])
write(bad_doc_root, document=doc.replace(b'w:document', b'w:notdocument'))
write(bad_rels_root, relationships=rels.replace(b'Relationships', b'NotRelationships'))
write(backslash_target, document=unsafe_doc,
    relationships=with_target('media' + chr(92) + 'used.png'))
write(nul_target, document=unsafe_doc,
    relationships=with_target('media/' + chr(0) + 'used.png'))
write(over_refs, document=doc.replace(b'</w:body>',
    (blip('embed', 'rId1') * 257 + '</w:body>').encode()))
write(over_document, document=doc.replace(b'</w:body>', b' ' * (1024 * 1024) + b'</w:body>'))
write(over_rels, relationships=rels.replace(b'</Relationships>',
    b' ' * (1024 * 1024) + b'</Relationships>'))
`;
  await exec(python, ['-I', '-S', '-c', fixture,
    originalPath, unsafePath, unsafeWrongTypePath, charRefTargetPath,
    duplicateRelPath, dtdPath, badXmlPath,
    badDocumentRootPath, badRelationshipsRootPath, backslashTargetPath,
    nulTargetPath,
    overRefsPath, overDocumentPath, overRelsPath], { timeout: 30000 });
  const original = await readFile(originalPath);
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
    id: 'docx-drawing-refs', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-docx-drawing',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [{ task, source: f.source, readScope: 'source-root',
      requestKey: 'docx-drawing-refs-v1',
      transport: { python, registrarSource, workspace: join(f.base, 'state') },
    }],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const publication = await loadArchivePublication(publicationPath);
  assert.equal(publication.preservation, 'complete-admitted');
  await rm(originalPath);
  await rm(unsafePath);
  await rm(unsafeWrongTypePath);
  await rm(charRefTargetPath);
  await rm(backslashTargetPath);
  const recoveredOriginalPath = join(f.base, 'recovered-drawings.docx');
  assert.equal((await cli('archive', [
    'recover', f.source.id, publication.generation,
    'drawings.docx', recoveredOriginalPath,
  ]))['sha256'], hash(original));
  assert.deepEqual(await readFile(recoveredOriginalPath), original);

  const plan = { publicationPath, sourcePath: 'drawings.docx', recoveredOriginalPath };
  const { receipt, receiptPath } = await inventoryArchiveDocxDrawingRefs(plan);
  assert.equal(receipt.coverage, 'declared-main-document-drawingml-only');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.deepEqual(receipt.original, { sha256: hash(original), bytes: original.length });
  assert.match(receipt.baseMediaReceiptSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.workerSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.adapterSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.references.length, 8);
  assert.deepEqual(receipt.references.map((r) => r.gap), [
    null, null, 'missing-relationship', 'external-relationship',
    'wrong-relationship-type', 'missing-package-media',
    'linked-image-unsupported', 'missing-embed-or-link',
  ]);
  assert.deepEqual(receipt.references.slice(0, 2).map((r) => r.member?.name),
    ['word/media/used.png', 'word/media/used.png']);
  assert.deepEqual(receipt.references.slice(0, 2).map((r) => r.member?.sha256),
    [hash('used image bytes'), hash('used image bytes')]);
  assert.deepEqual(receipt.unreferencedMedia.map((m) => m.name),
    ['word/media/unreferenced.png']);
  assert.equal((await inventoryArchiveDocxDrawingRefs(plan)).receiptPath, receiptPath);
  const receiptBytes = await readFile(receiptPath, 'utf8');
  assert(!receiptBytes.includes(recoveredOriginalPath));
  assert(!receiptBytes.includes('used image bytes'));
  assert(!receiptBytes.includes('https://example.test'));
  assert(!receiptBytes.includes('rId1'));

  const recoveredUnsafePath = join(f.base, 'recovered-unsafe.docx');
  await cli('archive', [
    'recover', f.source.id, publication.generation,
    'unsafe.docx', recoveredUnsafePath,
  ]);
  await assert.rejects(() => inventoryArchiveDocxDrawingRefs({
    publicationPath, sourcePath: 'unsafe.docx',
    recoveredOriginalPath: recoveredUnsafePath,
  }), /Unsafe internal image relationship target/);
  for (const [sourcePath, recoveredPath] of [
    ['unsafe-wrong-type.docx', join(f.base, 'recovered-unsafe-wrong-type.docx')],
    ['backslash-target.docx', join(f.base, 'recovered-backslash-target.docx')],
    ['control-char-target.docx', join(f.base, 'recovered-control-char-target.docx')],
  ] as const) {
    await cli('archive', [
      'recover', f.source.id, publication.generation, sourcePath, recoveredPath,
    ]);
    await assert.rejects(() => inventoryArchiveDocxDrawingRefs({
      publicationPath, sourcePath, recoveredOriginalPath: recoveredPath,
    }), /Unsafe internal image relationship target/);
  }

  for (const path of [duplicateRelPath, dtdPath, badXmlPath,
    badDocumentRootPath, badRelationshipsRootPath, nulTargetPath,
    overRefsPath, overDocumentPath, overRelsPath]) {
    const sha256 = hash(await readFile(path));
    await assert.rejects(() => scanRecoveredDocxDrawingRefs(
      path, sha256, python));
  }
  await writeFile(recoveredOriginalPath, Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(() => inventoryArchiveDocxDrawingRefs(plan),
    /Recovered DOCX does not match retained original/);
  await writeFile(recoveredOriginalPath, original);
  assert.equal((await cli('sources', ['disable', f.source.id]))['enabled'], false);
  await assert.rejects(() => inventoryArchiveDocxDrawingRefs(plan),
    /Admitted source disabled|Source registration changed/);
});
