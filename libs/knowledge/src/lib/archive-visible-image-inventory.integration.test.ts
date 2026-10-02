import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { canonical, hash } from './codec.js';
import { inventoryVisibleArchiveImages } from './archive-visible-image-inventory.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: visible Markdown image inventory pins archived PNG and explicit gaps without visual claims', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const markdown =
    '# Gallery 😀\r\n' +
    '![pixel](../assets/pixel.png) ![missing](missing.png)\n' +
    '![remote](https://example.com/remote.png) ' +
    '![outside](../../escape.png)\n' +
    '`![code](missing.png)` \\![escaped](missing.png) ' +
    '\\\\![even](../assets/pixel.png)\n' +
    '<!-- ![comment](missing.png) -->\n' +
    '```md\n![fenced](missing.png)\n```\n';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WcLxW0AAAAASUVORK5CYII=',
    'base64',
  );
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      ...Array.from({ length: 22 }, (_, i) => ({
        path: `a${String(i).padStart(2, '0')}.md`,
        bytes: Buffer.from(`# Filler ${i}\n`),
      })),
      { path: 'docs/gallery.md', bytes: Buffer.from(markdown) },
    ],
  });
  await mkdir(join(f.base, 'sources/assets'));
  await writeFile(join(f.base, 'sources/assets/pixel.png'), png);
  const task = {
    id: 'visible-images',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-visible-image-inventory',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'visible-images-v1',
        transport: {
          python,
          registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  await rm(join(f.base, 'sources/docs/gallery.md'));
  await rm(join(f.base, 'sources/assets/pixel.png'));
  const plan = { publicationPath, paths: ['docs/gallery.md'] };
  const { receipt, receiptPath } = await inventoryVisibleArchiveImages(plan);
  assert.equal(receipt.references.length, 5);
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(receipt.coverage, 'inline-markdown-only');
  assert.equal(
    receipt.publicationSha256,
    hash(await readFile(publicationPath)),
  );
  assert.equal(
    (await inventoryVisibleArchiveImages(plan)).receiptPath,
    receiptPath,
  );
  for (const reference of receipt.references) {
    const quote = Array.from(markdown)
      .slice(reference.textStart, reference.textEnd)
      .join('');
    assert(quote.startsWith('!['));
    assert.equal(reference.quoteSha256, hash(quote));
    assert.equal(reference.sourceOriginalSha256, hash(markdown));
    assert.match(reference.sourceRepresentationSha256, /^[a-f0-9]{64}$/);
  }
  const [captured, missing, remote, outside, even] = receipt.references;
  assert.equal(captured.targetPath, 'assets/pixel.png');
  assert.deepEqual(captured.original, { sha256: hash(png), bytes: png.length });
  assert.equal(captured.gap, null);
  assert.equal(missing.targetPath, 'docs/missing.png');
  assert.equal(missing.gap?.kind, 'missing');
  assert.equal(remote.targetPath, null);
  assert.equal(remote.gap?.kind, 'unsupported');
  assert.equal(outside.targetPath, null);
  assert.equal(outside.gap?.kind, 'outside');
  assert.equal(even.targetPath, 'assets/pixel.png');
  assert.deepEqual(even.original, captured.original);
  assert.equal(even.gap, null);
  const cliEnv = {
    PATH: '/usr/bin:/bin',
    PYTHONPATH: join(registrarSource, 'src'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const inspectPage = async (offset: number) => {
    const result = await exec(
      python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        join(f.base, 'state'),
        'inspect',
        f.source.id,
        receipt.generation,
        '--manifest-sha256',
        receipt.manifestSha256,
        '--offset',
        String(offset),
        '--limit',
        '20',
        '--max-bytes',
        '1048576',
      ],
      { env: cliEnv, timeout: 60000, maxBuffer: 1_048_576 },
    );
    return JSON.parse(result.stdout) as {
      documents: { path: string }[];
      next_offset: number | null;
    };
  };
  const firstPage = await inspectPage(0);
  assert.equal(firstPage.documents.length, 20);
  assert.equal(firstPage.next_offset, 20);
  assert(!firstPage.documents.some((doc) => doc.path === 'assets/pixel.png'));
  const secondPage = await inspectPage(20);
  assert(secondPage.documents.some((doc) => doc.path === 'assets/pixel.png'));
  const receiptText = await readFile(receiptPath, 'utf8');
  assert(!receiptText.includes('![pixel]'));
  assert(!receiptText.includes('https://example.com'));
  assert(!receiptText.includes('![code]'));
  const destination = join(f.base, 'recovered-pixel.png');
  const recovered = await exec(
    python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'archive',
      '--workspace',
      join(f.base, 'state'),
      'recover',
      f.source.id,
      receipt.generation,
      'assets/pixel.png',
      destination,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      timeout: 60000,
      maxBuffer: 1_048_576,
    },
  );
  assert.equal(JSON.parse(recovered.stdout).sha256, hash(png));
  assert.deepEqual(await readFile(destination), png);

  const originalPublication = await readFile(publicationPath, 'utf8');
  const altered = JSON.parse(originalPublication);
  altered.manifestSha256 = '0'.repeat(64);
  await writeFile(publicationPath, canonical(altered));
  await assert.rejects(() => inventoryVisibleArchiveImages(plan));
  await writeFile(publicationPath, originalPublication);
  await exec(
    python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      join(f.base, 'state'),
      'disable',
      f.source.id,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      timeout: 60000,
      maxBuffer: 1_048_576,
    },
  );
  await assert.rejects(
    () => inventoryVisibleArchiveImages(plan),
    /Admitted source disabled|Source registration changed/,
  );
});
