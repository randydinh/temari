import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLocalRegistrar } from './registrar.js';
import { hash } from './codec.js';

test('PARSER SUBSTITUTION ONLY: matching response quote/body cannot forge exact source-byte text; malformed JSON rejected', async () => {
  const base = await mkdtemp(
    join(await realpath(tmpdir()), 'temari-parser-only-'),
  );
  const root = join(base, 'sources'),
    state = join(base, 'state'),
    registrarSource = join(base, 'stub-implementation');
  await mkdir(root);
  await mkdir(state);
  await mkdir(join(registrarSource, 'src'), { recursive: true });
  await writeFile(
    join(state, 'registry.sqlite3'),
    'test-only placeholder; shim never opens a database',
  );
  await writeFile(join(registrarSource, 'pyproject.toml'), '# test-only');
  await writeFile(join(registrarSource, 'uv.lock'), '# test-only');
  const body = 'Proposal 😀 café\r\n',
    source = {
      provider: 'test-parser',
      id: 'test-source',
      locator: pathToFileURL(root).href,
    };
  const preparation = join(base, 'preparation.json');
  await writeFile(
    preparation,
    JSON.stringify({
      schema: 1,
      kind: 'temari-knowledge-isolated',
      root,
      state,
      instance: source.provider,
      sourceId: source.id,
    }),
  );
  await writeFile(join(root, 'plan.txt'), body);
  const listing = {
    sources: [
      {
        id: source.id,
        root,
        enabled: true,
        generation: 'test-generation',
        recursive: true,
        exclude: [],
      },
    ],
  };
  const read = {
    schema: 1,
    operation: 'read',
    status: 'complete',
    source_id: source.id,
    path: 'plan.txt',
    generation: 'test-generation',
    sha256: hash(body),
    snapshot: hash('snapshot'),
    total_chars: Array.from(body).length,
    offset: 0,
    next_offset: null,
    record: {
      body,
      support: 'source-bytes-and-spans-verified',
      citations: [
        {
          source_id: source.id,
          path: 'plan.txt',
          absolute_path: join(root, 'plan.txt'),
          sha256: hash(body),
          text_start: 0,
          text_end: Array.from(body).length,
          extraction: 'utf-8-text',
          extractor_signature: hash('extractor'),
          quote: body,
        },
      ],
    },
  };
  read.record.body = 'X' + read.record.body.slice(1);
  read.record.citations[0].quote = read.record.body;
  for (const malformed of [false, true]) {
    const shim = join(base, `test-only-parser-shim-${malformed}`);
    const code = `#!${process.execPath}\nconst op = process.argv[process.argv.indexOf('--workspace') + 2];\nprocess.stdout.write(op === 'list' ? ${JSON.stringify(JSON.stringify(listing))} : ${JSON.stringify(malformed ? '{bad' : JSON.stringify(read))});\n`;
    await writeFile(shim, code, { mode: 0o700, flag: 'wx' });
    const provider = await createLocalRegistrar({
      python: shim,
      registrarSource,
      preparation,
      readScope: 'source-root',
    });
    const result = await provider.read({
      document: { source, path: 'plan.txt' },
      expectedSha256: null,
      maxCodePoints: 200,
      maxBytes: 16000,
      continuation: null,
    });
    assert(!result.ok);
    assert.equal(result.gap.kind, 'unknown');
    if (!malformed)
      assert.match(result.gap.detail, /exact source-byte codepoint slice/);
  }
});
