import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import {
  inventoryArchiveDocxMedia,
  scanRecoveredDocxPackage,
} from './archive-docx-media-inventory.js';
import { hash } from './codec.js';
import { loadArchivePublication } from './archive-intake.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: recovered local-only DOCX media inventory pins retained originals and refuses bad ZIP/admission', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python, registrarSource,
    documents: [{ path: 'seed.txt', bytes: Buffer.from('local-only fixture\n') }],
  });
  const originalPath = join(f.base, 'sources/report.docx');
  const duplicatePath = join(f.base, 'duplicate.docx');
  const expandedPath = join(f.base, 'expanded.docx');
  const plainZipPath = join(f.base, 'plain-zip.docx');
  const backslashPath = join(f.base, 'backslash.docx');
  const traversalPath = join(f.base, 'traversal.docx');
  const directoryPath = join(f.base, 'directory.docx');
  const crcPath = join(f.base, 'crc.docx');
  const fixture = String.raw`
import sys, zipfile
path, duplicate, expanded, plain, backslash, traversal, directory, crc = sys.argv[1:]
xml = b'<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Archive content</w:t></w:r></w:p></w:body></w:document>'
media = b'PNG example bytes for package inventory'
types = b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/media/', b'')
    z.writestr('word/media/logo.png', media)
    z.writestr('word/media/diagram.jpeg', b'JPEG example bytes')
with zipfile.ZipFile(duplicate, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/media/logo.png', media)
    z.writestr('word/media/logo.png', media)
with zipfile.ZipFile(expanded, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/media/large.bin', b'0' * (33 * 1024 * 1024))
with zipfile.ZipFile(plain, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('word/media/logo.png', media)
with zipfile.ZipFile(backslash, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word' + chr(92) + 'media' + chr(92) + 'logo.png', media)
with zipfile.ZipFile(traversal, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/../escape.png', media)
with zipfile.ZipFile(directory, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/../', b'')
with zipfile.ZipFile(crc, 'w', compression=zipfile.ZIP_STORED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('word/document.xml', xml)
    z.writestr('word/media/logo.png', b'CRC target data')
raw = open(crc, 'rb').read()
assert raw.count(b'CRC target data') == 1
open(crc, 'wb').write(raw.replace(b'CRC target data', b'CRX target data'))
`;
  await exec(python, ['-I', '-S', '-c', fixture,
    originalPath, duplicatePath, expandedPath, plainZipPath, backslashPath,
    traversalPath, directoryPath, crcPath],
  { timeout: 30000 });
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
  const sharing = await cli('sources', ['set-sharing', f.source.id, 'local-only']);
  assert.equal(sharing['sharing'], 'local-only');
  const task = {
    id: 'docx-package-media', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-docx-package',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [{ task, source: f.source, readScope: 'source-root',
      requestKey: 'docx-package-media-v1',
      transport: { python, registrarSource, workspace: join(f.base, 'state') },
    }],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const publication = await loadArchivePublication(publicationPath);
  assert.equal(publication.preservation, 'complete-admitted');
  await rm(originalPath);
  const recoveredOriginalPath = join(f.base, 'recovered-report.docx');
  const recovered = await cli('archive', [
    'recover', f.source.id, publication.generation,
    'report.docx', recoveredOriginalPath,
  ]);
  assert.equal(recovered['sha256'], hash(original));
  assert.deepEqual(await readFile(recoveredOriginalPath), original);

  const plan = { publicationPath, sourcePath: 'report.docx', recoveredOriginalPath };
  const { receipt, receiptPath } = await inventoryArchiveDocxMedia(plan);
  assert.equal(receipt.coverage, 'package-media-only');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.deepEqual(receipt.original, { sha256: hash(original), bytes: original.length });
  assert.equal(receipt.members.length, 2);
  assert.deepEqual(receipt.members.map((m) => m.name), [
    'word/media/diagram.jpeg', 'word/media/logo.png',
  ]);
  assert.deepEqual(receipt.members.map((m) => m.sha256), [
    hash('JPEG example bytes'), hash('PNG example bytes for package inventory'),
  ]);
  assert.equal((await inventoryArchiveDocxMedia(plan)).receiptPath, receiptPath);
  assert.match(receipt.workerSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.adapterSha256, /^[a-f0-9]{64}$/);
  const receiptBytes = await readFile(receiptPath, 'utf8');
  assert(!receiptBytes.includes(recoveredOriginalPath));
  assert(!receiptBytes.includes('PNG example bytes'));
  assert(!receiptBytes.includes('Archive content'));

  await writeFile(recoveredOriginalPath, Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(() => inventoryArchiveDocxMedia(plan),
    /Recovered DOCX does not match retained original/);
  await writeFile(recoveredOriginalPath, original);
  const malformed = await Promise.all([
    duplicatePath, expandedPath, plainZipPath, backslashPath,
    traversalPath, directoryPath, crcPath,
  ].map(async (path) => ({ path, sha256: hash(await readFile(path)) })));
  for (const candidate of malformed) {
    await assert.rejects(() => scanRecoveredDocxPackage(
      candidate.path, candidate.sha256, python));
  }
  const badZip = join(f.base, 'malformed.docx');
  await writeFile(badZip, Buffer.from('not a ZIP'));
  const badZipSha256 = hash(await readFile(badZip));
  await assert.rejects(() => scanRecoveredDocxPackage(
    badZip, badZipSha256, python));
  await assert.rejects(() => inventoryArchiveDocxMedia({
    ...plan, sourcePath: ['nested', 'report.docx'].join(String.fromCharCode(92)),
  }), /Canonical source-relative DOCX path required/);
  await assert.rejects(() => inventoryArchiveDocxMedia({
    ...plan, sourcePath: `nested${String.fromCharCode(0)}report.docx`,
  }), /Canonical source-relative DOCX path required/);

  const disabled = await cli('sources', ['disable', f.source.id]);
  assert.equal(disabled['enabled'], false);
  await assert.rejects(() => inventoryArchiveDocxMedia(plan),
    /Admitted source disabled|Source registration changed/);
});
