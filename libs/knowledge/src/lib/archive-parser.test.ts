import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveTransport } from './archive-transport.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { canonical, hash } from './codec.js';

test('MALFORMED PROTOCOL SHIM ONLY: strict archive identity/coordinates/version/size checks; not proof of inclusion', async () => {
  const base = await mkdtemp(
      join(await realpath(tmpdir()), 'archive-parser-only-'),
    ),
    workspace = join(base, 'state'),
    registrarSource = join(base, 'stub-source'),
    task = {
      id: 'parser-only',
      authorityRef: 'synthetic-shim',
      directory: base,
    };
  await mkdir(workspace);
  await mkdir(join(registrarSource, 'src'), { recursive: true });
  await mkdir(join(registrarSource, 'docs/design'), { recursive: true });
  for (const name of [
    'pyproject.toml',
    'uv.lock',
    'docs/design/source-archive-contract-v1.json',
  ])
    await writeFile(join(registrarSource, name), 'test-only');
  await writeFile(join(workspace, 'registry.sqlite3'), 'shim does not open DB');
  const source = {
    provider: 'shim-only',
    id: 'fixture',
    locator: pathToFileURL(join(base, 'missing-originals')).href,
  };
  const row = {
    id: source.id,
    root: join(base, 'missing-originals'),
    enabled: true,
    recursive: true,
    exclude: [],
  };
  const pin = {
    source_id: source.id,
    generation: 'a'.repeat(32),
    manifest_sha256: 'b'.repeat(64),
    evidence: 'archived-snapshot',
    current_original: 'not-checked',
  };
  const citation = {
    ...pin,
    snapshot_generation: pin.generation,
    path: 'plan.txt',
    sha256: hash('abc'),
    original_sha256: hash('abc'),
    representation_sha256: hash('abc'),
    extractor_signature: hash('extractor'),
    extraction: 'utf-8-text',
    coordinate_space: 'unicode-codepoints',
    text_start: 0,
    text_end: 3,
    quote: 'abc',
  };
  const good = {
    ...pin,
    schema: 1,
    status: 'complete',
    integrity: 'verified',
    path: 'plan.txt',
    offset: 0,
    total_chars: 3,
    next_offset: null,
    next_cursor: null,
    gaps: [],
    record: { body: 'abc', citations: [citation] },
    representation: {
      version: 1,
      original_sha256: hash('abc'),
      sha256: hash('abc'),
      bytes: 3,
      encoding: 'utf-8',
      coordinate_space: 'unicode-codepoints',
      extractor_signature: hash('extractor'),
      extraction: 'utf-8-text',
      settings: {},
      omissions: [],
    },
  };
  for (const variant of [
    'valid-metadata',
    'schema',
    'source',
    'manifest',
    'original',
    'representation',
    'coordinates',
    'truncated',
    'oversized',
    'settings',
    'text-hash',
    'text-bytes',
  ]) {
    const reply = structuredClone(good);
    if (variant === 'schema') reply.schema = 2;
    if (variant === 'source') reply.source_id = 'OUT-OF-SCOPE-SECRET';
    if (variant === 'manifest') reply.manifest_sha256 = '0'.repeat(64);
    if (variant === 'original')
      reply.representation.original_sha256 = '0'.repeat(64);
    if (variant === 'representation')
      reply.record.citations[0].representation_sha256 = '0'.repeat(64);
    if (variant === 'text-hash') {
      reply.representation.sha256 = hash('other text');
      reply.record.citations[0].representation_sha256 =
        reply.representation.sha256;
    }
    if (variant === 'text-bytes') reply.representation.bytes = 4;
    if (variant === 'coordinates') reply.total_chars = 2;
    if (variant === 'settings')
      reply.representation.settings = { huge: 'x'.repeat(9000) };
    const raw =
      variant === 'truncated'
        ? '{'
        : variant === 'oversized'
          ? 'x'.repeat(70000)
          : JSON.stringify(reply);
    const shim = join(base, `parser-shim-${variant}`);
    await writeFile(
      shim,
      `#!${process.execPath}\nconst op=process.argv[process.argv.indexOf('--workspace')+2]; process.stdout.write(op==='list'?${JSON.stringify(JSON.stringify({ sources: [row] }))}:${JSON.stringify(raw)});\n`,
      { mode: 0o700 },
    );
    const transport = await archiveTransport({
      python: shim,
      registrarSource,
      workspace,
    });
    const captureRequestKey = `temari-archive-v1:${hash(variant)}`;
    const binding = hash(captureRequestKey);
    const publicationPath = join(base, `archive-publication-${binding}.json`);
    const registration = canonical({
      source,
      root: row.root,
      kind: 'local',
      enabled: true,
      recursive: true,
      exclude: [],
    });
    const publication = {
      schema: 1,
      kind: 'temari-archive-publication',
      task,
      source,
      readScope: 'source-root',
      transport: transport.config,
      implementation: transport.implementation,
      protocolSha256: transport.protocolSha256,
      registration,
      binding,
      generation: pin.generation,
      manifestSha256: pin.manifest_sha256,
      captureRequestKey,
      captureFingerprint: hash('fp'),
      preservation: 'complete-admitted',
      counts: { captured: 1 },
      capabilities: {},
      gaps: [],
      currentOriginal: 'not-checked',
    };
    await writeFile(publicationPath, canonical(publication));
    await writeFile(
      join(base, `archive-binding-${binding}.json`),
      canonical({
        schema: 1,
        task,
        source,
        readScope: 'source-root',
        transport: transport.config,
        implementation: transport.implementation,
        protocolSha256: transport.protocolSha256,
        registration,
        captureRequestKey,
      }),
    );
    const provider = await createArchiveRegistrar({
      publications: [publicationPath],
      readScope: 'source-root',
    });
    const result = await provider.read({
      document: { source, path: 'plan.txt' },
      expectedSha256: hash('abc'),
      maxCodePoints: 10,
      maxBytes: 16000,
      continuation: null,
    });
    if (variant === 'valid-metadata') {
      assert(result.ok, JSON.stringify(result));
      assert.equal(
        result.value.evidence.archive?.currentOriginal,
        'not-checked',
      );
    } else assert(!result.ok, variant);
    assert(!canonical(result).includes('OUT-OF-SCOPE-SECRET'));
  }
});
