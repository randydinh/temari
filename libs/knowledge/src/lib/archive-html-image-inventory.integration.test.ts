import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { loadArchivePublication } from './archive-intake.js';
import { canonical, hash } from './codec.js';
import { inventoryArchiveHtmlImages } from './archive-html-image-inventory.js';

const exec = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WcLxW0AAAAASUVORK5CYII=',
  'base64',
);
const cliEnv = (registrarSource: string) => ({
  PATH: '/usr/bin:/bin',
  PYTHONPATH: join(registrarSource, 'src'),
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
});
async function cli(
  python: string,
  registrarSource: string,
  workspace: string,
  route: 'sources' | 'archive',
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await exec(
    python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      route,
      '--workspace',
      workspace,
      ...args,
    ],
    { env: cliEnv(registrarSource), timeout: 60000, maxBuffer: 1_048_576 },
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('ACTUAL Registrar: recovered local-only HTML images pin declarations, originals and explicit gaps', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const html =
    '<!doctype html>\n<html><body>😀\n' +
    '<img alt="one > two" src="../assets/pixel.png">\n' +
    '<IMG SRC="../assets/pixel.png" loading="lazy">\n' +
    '<img alt="literal <img src=\'fake.png\'" src="../assets/pixel.png">\n' +
    '<img src="../assets/lost.png">\n' +
    '<img src="https://example.com/remote.png">\n' +
    '<img src="../../escape.png">\n' +
    '<img src="../assets/pixel%20.png">\n' +
    '<img src="../assets/pixel.png" srcset="2x.png 2x">\n' +
    '<img alt="no source">\n' +
    '<!-- <img src="../assets/pixel.png"> -->\n' +
    '<script>const html = \'<img src="../assets/pixel.png">\';</script>\n' +
    '<style>.x:after { content: "<img src=\'../assets/pixel.png\'>"; }</style>\n' +
    '<template><img src="../assets/pixel.png"></template>\n' +
    '<textarea><img src="../assets/pixel.png"></textarea>\n' +
    '<title><img src="../assets/pixel.png"></title>\n' +
    '</body></html>\n';
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      ...Array.from({ length: 22 }, (_, i) => ({
        path: `a${String(i).padStart(2, '0')}.md`,
        bytes: Buffer.from(`# Filler ${i}\n`),
      })),
      { path: 'seed.txt', bytes: Buffer.from('HTML fixture seed\n') },
    ],
  });
  const workspace = join(f.base, 'state');
  const htmlPath = join(f.base, 'sources/docs/gallery.html');
  await mkdir(join(f.base, 'sources/docs'));
  await mkdir(join(f.base, 'sources/assets'));
  await writeFile(htmlPath, html);
  await writeFile(join(f.base, 'sources/assets/pixel.png'), png);
  assert.equal(
    (
      await cli(python, registrarSource, workspace, 'sources', [
        'set-sharing',
        f.source.id,
        'local-only',
      ])
    )['sharing'],
    'local-only',
  );
  const task = {
    id: 'html-original-images',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-html-image-inventory',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'html-original-images-v1',
        transport: { python, registrarSource, workspace },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const publication = await loadArchivePublication(publicationPath);
  assert.equal(publication.preservation, 'complete-admitted');
  await rm(htmlPath);
  await rm(join(f.base, 'sources/assets/pixel.png'));
  const recoveredOriginalPath = join(f.base, 'recovered-gallery.html');
  const recovered = await cli(python, registrarSource, workspace, 'archive', [
    'recover',
    f.source.id,
    publication.generation,
    'docs/gallery.html',
    recoveredOriginalPath,
  ]);
  assert.equal(recovered['sha256'], hash(html));
  assert.deepEqual(await readFile(recoveredOriginalPath), Buffer.from(html));
  const plan = {
    publicationPath,
    sourcePath: 'docs/gallery.html',
    recoveredOriginalPath,
  };
  const { receipt, receiptPath } = await inventoryArchiveHtmlImages(plan);
  assert.equal(receipt.schema, 2);
  assert.equal(receipt.images.length, 9);
  assert.deepEqual(receipt.sourceOriginal, {
    sha256: hash(html),
    bytes: Buffer.byteLength(html),
  });
  assert.equal(
    receipt.coverage,
    'local-only-simple-single-line-html-img-declarations-only',
  );
  assert.equal(receipt.sourceSharing, 'local-only');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  assert.equal(
    receipt.publicationSha256,
    hash(await readFile(publicationPath)),
  );
  assert.equal(
    (await inventoryArchiveHtmlImages(plan)).receiptPath,
    receiptPath,
  );
  for (const image of receipt.images) {
    const quote = Array.from(html)
      .slice(image.textStart, image.textEnd)
      .join('');
    assert.equal(image.quoteSha256, hash(quote));
  }
  const [
    first,
    second,
    nested,
    missing,
    external,
    outside,
    unsupported,
    srcset,
    noSrc,
  ] = receipt.images;
  assert.equal(
    first.textStart,
    Array.from(html.slice(0, html.indexOf('<img alt="one > two"'))).length,
  );
  for (const image of [first, second, nested]) {
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
  const page0 = await cli(python, registrarSource, workspace, 'archive', [
    'inspect',
    f.source.id,
    receipt.generation,
    '--manifest-sha256',
    receipt.manifestSha256,
    '--offset',
    '0',
    '--limit',
    '20',
    '--max-bytes',
    '1048576',
  ]);
  assert.equal(page0['next_offset'], 20);
  assert(
    !(page0['documents'] as { path: string }[]).some(
      (row) => row.path === 'assets/pixel.png',
    ),
  );
  const page1 = await cli(python, registrarSource, workspace, 'archive', [
    'inspect',
    f.source.id,
    receipt.generation,
    '--manifest-sha256',
    receipt.manifestSha256,
    '--offset',
    '20',
    '--limit',
    '20',
    '--max-bytes',
    '1048576',
  ]);
  assert(
    (page1['documents'] as { path: string }[]).some(
      (row) => row.path === 'assets/pixel.png',
    ),
  );
  const serialized = await readFile(receiptPath, 'utf8');
  for (const forbidden of [
    '<img',
    'one > two',
    'https://example.com',
    '../assets/pixel.png',
    'recovered-gallery.html',
    '😀',
  ])
    assert(!serialized.includes(forbidden));

  await writeFile(recoveredOriginalPath, Buffer.from('<img src="fake.png">'));
  await assert.rejects(
    () => inventoryArchiveHtmlImages(plan),
    /Recovered HTML differs/,
  );
  await writeFile(recoveredOriginalPath, html);
  const saved = await readFile(publicationPath, 'utf8');
  const altered = JSON.parse(saved);
  altered.manifestSha256 = '0'.repeat(64);
  await writeFile(publicationPath, canonical(altered));
  await assert.rejects(() => inventoryArchiveHtmlImages(plan));
  await writeFile(publicationPath, saved);
  assert.equal(
    (
      await cli(python, registrarSource, workspace, 'sources', [
        'set-sharing',
        f.source.id,
        'registered-sources',
      ])
    )['sharing'],
    'registered-sources',
  );
  const switched = await inventoryArchiveHtmlImages(plan);
  assert.equal(switched.receipt.schema, 2);
  assert.equal(switched.receipt.sourceSharing, 'registered-sources');
  assert.equal(
    switched.receipt.coverage,
    'registered-sources-simple-single-line-html-img-declarations-only',
  );
  assert.notEqual(switched.receiptPath, receiptPath);
  assert.equal(
    (
      await cli(python, registrarSource, workspace, 'sources', [
        'set-sharing',
        f.source.id,
        'local-only',
      ])
    )['sharing'],
    'local-only',
  );
  await cli(python, registrarSource, workspace, 'sources', [
    'disable',
    f.source.id,
  ]);
  await assert.rejects(
    () => inventoryArchiveHtmlImages(plan),
    /Admitted source disabled/,
  );
});

test('ACTUAL Registrar: default registered-sources HTML inventory pins recovered originals and refuses a mode change during inventory', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      { path: 'seed.txt', bytes: Buffer.from('HTML sharing seed\n') },
    ],
  });
  const workspace = join(f.base, 'state');
  const html = '<!doctype html>\n<p>😀</p><img src="pixel.png">\n';
  const htmlPath = join(f.base, 'sources/gallery.html');
  const assetPath = join(f.base, 'sources/pixel.png');
  await writeFile(htmlPath, html);
  await writeFile(assetPath, png);
  const sourceRows = (
    await cli(python, registrarSource, workspace, 'sources', ['list'])
  )['sources'] as { id: string; sharing: string }[];
  assert.equal(
    sourceRows.find((row) => row.id === f.source.id)?.sharing,
    'registered-sources',
  );

  // A fixed executable keeps the transport implementation pin intact. Only
  // test-owned registry state changes on the third admitted list call.
  const pythonWrapper = join(f.base, 'python-wrapper.sh');
  const armPath = join(f.base, 'change-sharing.arm');
  const countPath = join(f.base, 'list-count');
  await writeFile(
    pythonWrapper,
    `#!/bin/sh
if [ "$4" = "sources" ] && [ "$7" = "list" ] && [ -f ${shellQuote(armPath)} ]; then
  n=0
  if [ -f ${shellQuote(countPath)} ]; then n=$(cat ${shellQuote(countPath)}); fi
  n=$((n+1))
  printf '%s' "$n" > ${shellQuote(countPath)}
  if [ "$n" = "3" ]; then
    ${shellQuote(python)} -B -m knowledge_agent.cli sources --workspace ${shellQuote(workspace)} set-sharing ${shellQuote(f.source.id)} local-only >/dev/null || exit $?
  fi
fi
exec ${shellQuote(python)} "$@"
`,
  );
  await chmod(pythonWrapper, 0o700);
  const task = {
    id: 'html-default-sharing',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-registered-html-image-inventory',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'html-default-sharing-v1',
        transport: {
          python: pythonWrapper,
          registrarSource,
          workspace,
        },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const publication = await loadArchivePublication(publicationPath);
  assert.equal(publication.preservation, 'complete-admitted');
  await rm(htmlPath);
  await rm(assetPath);
  const recoveredOriginalPath = join(f.base, 'recovered-default-gallery.html');
  const recovered = await cli(python, registrarSource, workspace, 'archive', [
    'recover',
    f.source.id,
    publication.generation,
    'gallery.html',
    recoveredOriginalPath,
  ]);
  assert.equal(recovered['sha256'], hash(html));
  assert.deepEqual(await readFile(recoveredOriginalPath), Buffer.from(html));
  const plan = {
    publicationPath,
    sourcePath: 'gallery.html',
    recoveredOriginalPath,
  };
  const { receipt, receiptPath } = await inventoryArchiveHtmlImages(plan);
  assert.equal(receipt.schema, 2);
  assert.equal(receipt.sourceSharing, 'registered-sources');
  assert.equal(
    receipt.coverage,
    'registered-sources-simple-single-line-html-img-declarations-only',
  );
  assert.deepEqual(receipt.sourceOriginal, {
    sha256: hash(html),
    bytes: Buffer.byteLength(html),
  });
  assert.equal(receipt.images.length, 1);
  assert.equal(receipt.images[0].targetPath, 'pixel.png');
  assert.deepEqual(receipt.images[0].original, {
    sha256: hash(png),
    bytes: png.length,
  });
  assert.equal(receipt.images[0].gap, null);
  assert.equal(receipt.images[0].quoteSha256, hash('<img src="pixel.png">'));
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.visualMeaning, 'not-evaluated');
  const serialized = await readFile(receiptPath, 'utf8');
  for (const forbidden of ['<img', 'recovered-default-gallery', '😀'])
    assert(!serialized.includes(forbidden));

  await writeFile(armPath, 'armed');
  await assert.rejects(
    () => inventoryArchiveHtmlImages(plan),
    /Current source sharing changed during HTML inventory/,
  );
  assert.equal(await readFile(countPath, 'utf8'), '4');
  const changedRows = (
    await cli(python, registrarSource, workspace, 'sources', ['list'])
  )['sources'] as { id: string; sharing: string }[];
  assert.equal(
    changedRows.find((row) => row.id === f.source.id)?.sharing,
    'local-only',
  );
});

test('ACTUAL Registrar: ambiguous and over-budget recovered HTML refuses', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      { path: 'seed.txt', bytes: Buffer.from('HTML refusal seed\n') },
    ],
  });
  const workspace = join(f.base, 'state');
  const examples = {
    'duplicate.html': '<img src="a.png" SRC="b.png">\n',
    'many.html': '<img src="a.png">\n'.repeat(257),
    'long.html': `<img alt="${'x'.repeat(1025)}" src="a.png">\n`,
    'invalid.html': Buffer.from([0x3c, 0x69, 0x6d, 0x67, 0xff, 0x3e]),
    'large.html': `${'x'.repeat(65537)}\n`,
    'nested.html':
      '<template><template><img src="a.png"></template></template>\n',
    'multiline.html': '<img src="a.png"\n<img src="b.png">\n',
    'cr.html': '<img\r src="a.png">\n',
    'raw.html': '<xmp><img src="a.png"></xmp>\n',
    'base.html': '<base href="https://example.com/"><img src="a.png">\n',
  };
  for (const [path, data] of Object.entries(examples))
    await writeFile(join(f.base, 'sources', path), data);
  assert.equal(
    (
      await cli(python, registrarSource, workspace, 'sources', [
        'set-sharing',
        f.source.id,
        'local-only',
      ])
    )['sharing'],
    'local-only',
  );
  const task = {
    id: 'html-refusals',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-html-refusals',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'html-refusals-v1',
        transport: { python, registrarSource, workspace },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const publication = await loadArchivePublication(publicationPath);
  for (const [sourcePath, data] of Object.entries(examples)) {
    await rm(join(f.base, 'sources', sourcePath));
    const recoveredOriginalPath = join(f.base, `recovered-${sourcePath}`);
    const recovered = await cli(python, registrarSource, workspace, 'archive', [
      'recover',
      f.source.id,
      publication.generation,
      sourcePath,
      recoveredOriginalPath,
    ]);
    assert.equal(recovered['sha256'], hash(data));
    const plan = { publicationPath, sourcePath, recoveredOriginalPath };
    const reason =
      sourcePath === 'duplicate.html'
        ? /Duplicate HTML img src/
        : sourcePath === 'many.html'
          ? /HTML img tag count budget/
          : sourcePath === 'long.html'
            ? /HTML img tag length budget/
            : sourcePath === 'invalid.html'
              ? /encoded data was not valid/
              : sourcePath === 'large.html'
                ? /over byte bound/
                : sourcePath === 'raw.html'
                  ? /Unsupported HTML raw-text container xmp/
                  : sourcePath === 'base.html'
                    ? /HTML base element unsupported/
                    : sourcePath === 'nested.html'
                      ? /Nested HTML template/
                      : /Multiline or unterminated/;
    await assert.rejects(() => inventoryArchiveHtmlImages(plan), reason);
  }
});
