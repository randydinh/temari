import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { canonical, hash } from './codec.js';
import { inventoryArchiveMarkdownHtmlImages } from './archive-markdown-html-image-inventory.js';

const exec = promisify(execFile);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WcLxW0AAAAASUVORK5CYII=',
  'base64',
);
const cliEnv = (registrarSource: string) => ({
  PATH: '/usr/bin:/bin', PYTHONPATH: join(registrarSource, 'src'),
  PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
});
async function setLocalOnly(python: string, registrarSource: string,
  workspace: string, sourceId: string): Promise<void> {
  const result = await exec(python, ['-B', '-m', 'knowledge_agent.cli', 'sources',
    '--workspace', workspace, 'set-sharing', sourceId, 'local-only'],
  { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 });
  assert.equal(JSON.parse(result.stdout).sharing, 'local-only');
}

test('ACTUAL Registrar: archived Markdown HTML img receipt pins simple declarations and explicit gaps', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const markdown =
    '---\nfront: <img src="../assets/pixel.png">\n---\n' +
    '# Gallery 😀\n' +
    '<img alt="a > b" src="../assets/pixel.png" loading="lazy">\n' +
    '<IMG SRC="../assets/pixel.png" />\n' +
    '<img alt="literal <img src=\'fake.png\'" src="../assets/pixel.png">\n' +
    '\\<img src="../assets/pixel.png">\n' +
    '\\\\<img src="../assets/pixel.png">\n' +
    '<img src="../assets/lost.png">\n' +
    '<img src="https://example.com/remote.png">\n' +
    '<img src="../../escape.png">\n' +
    '<img src="../assets/pixel%20.png">\n' +
    '<img src="../assets/pixel.png" srcset="2x.png 2x">\n' +
    '<img alt="no source">\n' +
    '<img src="unterminated.png"\n' +
    '`<img src="../assets/pixel.png">`\n' +
    '<!-- <img src="../assets/pixel.png"> -->\n' +
    '    <img src="../assets/pixel.png">\n' +
    '```html\n<img src="../assets/pixel.png">\n```\n' +
    '<script>\n<img src="../assets/pixel.png">\n</script>\n' +
    '<pre>\n<img src="../assets/pixel.png">\n</pre>\n' +
    '<style>\n<img src="../assets/pixel.png">\n</style>\n' +
    '<textarea>\n<img src="../assets/pixel.png">\n</textarea>\n' +
    '<!DOCTYPE html [\n<img src="../assets/pixel.png">\n]>\n';
  const f = await prepareRegistrar({ python, registrarSource, documents: [
    ...Array.from({ length: 22 }, (_, i) => ({
      path: `a${String(i).padStart(2, '0')}.md`, bytes: Buffer.from(`# Filler ${i}\n`),
    })),
    { path: 'docs/gallery.markdown', bytes: Buffer.from(markdown) },
  ] });
  await mkdir(join(f.base, 'sources/assets'));
  await writeFile(join(f.base, 'sources/assets/pixel.png'), png);
  await setLocalOnly(python, registrarSource, join(f.base, 'state'), f.source.id);
  const task = { id: 'html-images', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-html-image-inventory' };
  const intake = await runArchiveIntake({ task, intakes: [{ task, source: f.source,
    readScope: 'source-root', requestKey: 'html-images-v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  await rm(join(f.base, 'sources/docs/gallery.markdown'));
  await rm(join(f.base, 'sources/assets/pixel.png'));
  const plan = { publicationPath, paths: ['docs/gallery.markdown'] };
  const { receipt, receiptPath } = await inventoryArchiveMarkdownHtmlImages(plan);
  assert.equal(receipt.images.length, 11);
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.coverage, 'simple-single-line-markdown-html-img-syntax-only');
  assert.equal(receipt.publicationSha256, hash(await readFile(publicationPath)));
  assert.equal((await inventoryArchiveMarkdownHtmlImages(plan)).receiptPath, receiptPath);
  for (const image of receipt.images) {
    const quote = Array.from(markdown).slice(image.textStart, image.textEnd).join('');
    assert.equal(image.quoteSha256, hash(quote));
    assert.equal(image.sourceOriginalSha256, hash(markdown));
    assert.match(image.sourceRepresentationSha256, /^[a-f0-9]{64}$/);
  }
  const [first, second, nestedQuote, evenEscape, missing, external, outside,
    unsupported, srcset, noSrc, unterminated] = receipt.images;
  assert.equal(first.textStart, Array.from(markdown.slice(0, markdown.indexOf('<img alt="a > b"'))).length);
  assert.equal(nestedQuote.textStart,
    Array.from(markdown.slice(0, markdown.indexOf('<img alt="literal <img'))).length);
  assert.equal(evenEscape.textStart,
    Array.from(markdown.slice(0, markdown.indexOf('\\\\<img src='))).length + 2);
  for (const image of [first, second, nestedQuote, evenEscape]) {
    assert.equal(image.targetPath, 'assets/pixel.png');
    assert.deepEqual(image.original, { sha256: hash(png), bytes: png.length });
    assert.equal(image.gap, null);
  }
  assert.equal(missing.gap?.kind, 'missing');
  assert.equal(external.gap?.kind, 'external');
  assert.equal(outside.gap?.kind, 'outside');
  assert.equal(unsupported.gap?.kind, 'unsupported');
  assert.equal(srcset.gap?.reason, 'srcset-selection-unsupported');
  assert.equal(noSrc.gap?.kind, 'malformed');
  assert.equal(unterminated.gap?.reason, 'unterminated-tag');
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
  const serialized = await readFile(receiptPath, 'utf8');
  for (const forbidden of ['<img', 'a > b', 'https://example.com', '../assets/pixel.png',
    'Gallery 😀', join(f.base, 'recovered-pixel.png')])
    assert(!serialized.includes(forbidden));
  const recovered = await exec(python, ['-B', '-m', 'knowledge_agent.cli', 'archive',
    '--workspace', join(f.base, 'state'), 'recover', f.source.id,
    receipt.generation, 'assets/pixel.png', join(f.base, 'recovered-pixel.png')],
  { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 });
  assert.equal(JSON.parse(recovered.stdout).sha256, hash(png));
  assert.deepEqual(await readFile(join(f.base, 'recovered-pixel.png')), png);
  const originalPublication = await readFile(publicationPath, 'utf8');
  const altered = JSON.parse(originalPublication);
  altered.manifestSha256 = '0'.repeat(64);
  await writeFile(publicationPath, canonical(altered));
  await assert.rejects(() => inventoryArchiveMarkdownHtmlImages(plan));
  await writeFile(publicationPath, originalPublication);
  await exec(python, ['-B', '-m', 'knowledge_agent.cli', 'sources', '--workspace',
    join(f.base, 'state'), 'disable', f.source.id],
  { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 });
  await assert.rejects(() => inventoryArchiveMarkdownHtmlImages(plan),
    /Admitted source disabled|Current source registration changed/);
});

test('ACTUAL Registrar: duplicate src and over-budget HTML img tags refuse', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({ python, registrarSource, documents: [
    { path: 'duplicate.md', bytes: Buffer.from('<img src="a.png" SRC="b.png">\n') },
    { path: 'many.md', bytes: Buffer.from('<img src="a.png">\n'.repeat(257)) },
    { path: 'long.md', bytes: Buffer.from(`<img alt="${'x'.repeat(1025)}" src="a.png">\n`) },
  ] });
  await setLocalOnly(python, registrarSource, join(f.base, 'state'), f.source.id);
  const task = { id: 'html-refusals', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-html-refusals' };
  const intake = await runArchiveIntake({ task, intakes: [{ task, source: f.source,
    readScope: 'source-root', requestKey: 'html-refusals-v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  await rm(join(f.base, 'sources/duplicate.md'));
  await rm(join(f.base, 'sources/many.md'));
  await rm(join(f.base, 'sources/long.md'));
  await assert.rejects(() => inventoryArchiveMarkdownHtmlImages({ publicationPath,
    paths: ['duplicate.md'] }), /Duplicate HTML img src attribute/);
  await assert.rejects(() => inventoryArchiveMarkdownHtmlImages({ publicationPath,
    paths: ['many.md'] }), /HTML img tag count budget exceeded/);
  await assert.rejects(() => inventoryArchiveMarkdownHtmlImages({ publicationPath,
    paths: ['long.md'] }), /HTML img tag length budget exceeded/);
});
