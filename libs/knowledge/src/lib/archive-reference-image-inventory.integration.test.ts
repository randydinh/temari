import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { canonical, hash } from './codec.js';
import { inventoryArchiveReferenceImages } from './archive-reference-image-inventory.js';

const exec = promisify(execFile);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WcLxW0AAAAASUVORK5CYII=',
  'base64',
);
const cliEnv = (registrarSource: string) => ({
  PATH: '/usr/bin:/bin', PYTHONPATH: join(registrarSource, 'src'),
  PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
});

test('ACTUAL Registrar: reference-style Markdown images resolve only pinned simple definitions', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const markdown =
    '---\nphantom: ![frontmatter][L A B]\n---\n' +
    '# Gallery 😀\n' +
    '![one][  L  A B ] ![alt][] ![undefined][none] ![lost][m]\n' +
    '![remote][r] ![outside][o] ![other][u]\n' +
    '`![code][L A B]` \\![escaped][L A B]\n' +
    '<!-- ![comment][L A B] -->\n' +
    '```md\n![fenced][L A B]\n```\n' +
    '[l a b]: ../assets/pixel.png\n' +
    '[alt]: ../assets/pixel.png\n' +
    '[m]: ../assets/lost.png\n' +
    '[r]: https://example.com/remote.png\n' +
    '[o]: ../../escape.png\n' +
    '[u]: other.txt\n';
  const f = await prepareRegistrar({
    python, registrarSource,
    documents: [
      ...Array.from({ length: 22 }, (_, i) => ({
        path: `a${String(i).padStart(2, '0')}.md`, bytes: Buffer.from(`# Filler ${i}\n`),
      })),
      { path: 'docs/gallery.md', bytes: Buffer.from(markdown) },
    ],
  });
  await mkdir(join(f.base, 'sources/assets'));
  await writeFile(join(f.base, 'sources/assets/pixel.png'), png);
  const task = { id: 'reference-images', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-reference-image-inventory' };
  const intake = await runArchiveIntake({ task, intakes: [{ task, source: f.source,
    readScope: 'source-root', requestKey: 'reference-images-v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  await rm(join(f.base, 'sources/docs/gallery.md'));
  await rm(join(f.base, 'sources/assets/pixel.png'));
  const plan = { publicationPath, paths: ['docs/gallery.md'] };
  const { receipt, receiptPath } = await inventoryArchiveReferenceImages(plan);
  assert.equal(receipt.references.length, 7);
  assert.equal(receipt.coverage, 'simple-reference-markdown-syntax-only');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.publicationSha256, hash(await readFile(publicationPath)));
  assert.equal((await inventoryArchiveReferenceImages(plan)).receiptPath, receiptPath);
  for (const reference of receipt.references) {
    const quote = Array.from(markdown).slice(reference.textStart, reference.textEnd).join('');
    assert.equal(reference.quoteSha256, hash(quote));
    assert.equal(reference.sourceOriginalSha256, hash(markdown));
    assert.match(reference.sourceRepresentationSha256, /^[a-f0-9]{64}$/);
  }
  const [full, collapsed, unresolved, missing, external, outside, unsupported] = receipt.references;
  assert.equal(full.form, 'full');
  assert.equal(collapsed.form, 'collapsed');
  for (const item of [full, collapsed]) {
    assert.equal(item.targetPath, 'assets/pixel.png');
    assert.deepEqual(item.original, { sha256: hash(png), bytes: png.length });
    assert.equal(item.gap, null);
  }
  const inspect = async (offset: number) => JSON.parse((await exec(python,
    ['-B', '-m', 'knowledge_agent.cli', 'archive', '--workspace',
      join(f.base, 'state'), 'inspect', f.source.id, receipt.generation,
      '--manifest-sha256', receipt.manifestSha256, '--offset', String(offset),
      '--limit', '20', '--max-bytes', '1048576'],
    { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 },
  )).stdout) as { documents: { path: string }[]; next_offset: number | null };
  const firstPage = await inspect(0);
  assert.equal(firstPage.next_offset, 20);
  assert(!firstPage.documents.some((document) => document.path === 'assets/pixel.png'));
  const secondPage = await inspect(20);
  assert(secondPage.documents.some((document) => document.path === 'assets/pixel.png'));
  assert.equal(unresolved.gap?.kind, 'unresolved');
  assert.equal(missing.gap?.kind, 'missing');
  assert.equal(external.gap?.kind, 'external');
  assert.equal(outside.gap?.kind, 'outside');
  assert.equal(unsupported.gap?.kind, 'unsupported');
  const serialized = await readFile(receiptPath, 'utf8');
  for (const forbidden of ['![one]', '![frontmatter]', 'https://example.com', '../assets/pixel.png',
    'Gallery 😀', join(f.base, 'recovered-pixel.png')])
    assert(!serialized.includes(forbidden));
  const recovered = await exec(python, ['-B', '-m', 'knowledge_agent.cli', 'archive',
    '--workspace', join(f.base, 'state'), 'recover', f.source.id,
    receipt.generation, 'assets/pixel.png', join(f.base, 'recovered-pixel.png')],
  { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 });
  assert.equal(JSON.parse(recovered.stdout).sha256, hash(png));
  assert.deepEqual(await readFile(join(f.base, 'recovered-pixel.png')), png);
  await assert.rejects(() => inventoryArchiveReferenceImages({ publicationPath,
    paths: ['docs\\gallery.md'] }));
  await assert.rejects(() => inventoryArchiveReferenceImages({ publicationPath,
    paths: ['docs\0gallery.md'] }));

  const originalPublication = await readFile(publicationPath, 'utf8');
  const altered = JSON.parse(originalPublication);
  altered.manifestSha256 = '0'.repeat(64);
  await writeFile(publicationPath, canonical(altered));
  await assert.rejects(() => inventoryArchiveReferenceImages(plan));
  await writeFile(publicationPath, originalPublication);
  await exec(python, ['-B', '-m', 'knowledge_agent.cli', 'sources', '--workspace',
    join(f.base, 'state'), 'disable', f.source.id],
  { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 });
  await assert.rejects(() => inventoryArchiveReferenceImages(plan),
    /Admitted source disabled|Current source registration changed/);
});

test('ACTUAL Registrar: duplicate definitions and over-budget uses or definitions refuse', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const duplicate = '![a][X]\n[X]: a.png\n[x]: b.png\n';
  const many = `${'![a][x] '.repeat(257)}\n[x]: a.png\n`;
  const manyDefinitions = Array.from({ length: 257 }, (_, i) =>
    `[label-${i}]: a.png\n`).join('');
  const f = await prepareRegistrar({ python, registrarSource, documents: [
    { path: 'duplicate.md', bytes: Buffer.from(duplicate) },
    { path: 'many.md', bytes: Buffer.from(many) },
    { path: 'definitions.md', bytes: Buffer.from(manyDefinitions) },
  ] });
  const task = { id: 'reference-refusals', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-reference-refusals' };
  const intake = await runArchiveIntake({ task, intakes: [{ task, source: f.source,
    readScope: 'source-root', requestKey: 'reference-refusals-v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  await rm(join(f.base, 'sources/duplicate.md'));
  await rm(join(f.base, 'sources/many.md'));
  await rm(join(f.base, 'sources/definitions.md'));
  await assert.rejects(() => inventoryArchiveReferenceImages({ publicationPath,
    paths: ['duplicate.md'] }), /Duplicate normalized reference definition/);
  await assert.rejects(() => inventoryArchiveReferenceImages({ publicationPath,
    paths: ['many.md'] }), /Reference image use budget exceeded/);
  await assert.rejects(() => inventoryArchiveReferenceImages({ publicationPath,
    paths: ['definitions.md'] }), /Reference definition budget exceeded/);
});
