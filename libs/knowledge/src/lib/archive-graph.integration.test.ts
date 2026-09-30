import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRegistrar } from '../support/prepare.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { hash } from './codec.js';

const exec = promisify(execFile);
async function fixture() {
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  assert(
    registrarSource && python,
    'Pinned Registrar source and Python required',
  );
  const f = await prepareRegistrar({
    registrarSource,
    python,
    documents: [
      {
        path: 'aaa.txt',
        bytes: Buffer.from('Signal and a contrary proposal.\n'),
      },
      {
        path: 'zzz.txt',
        bytes: Buffer.from(
          'Signal signal signal signal signal signal signal.\n',
        ),
      },
    ],
  });
  const options = {
    task: {
      id: 'graph-bm25-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-authority',
    },
    source: f.source,
    readScope: 'source-root' as const,
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
    requestKey: 'v1',
  };
  const outcome = await captureArchive(options);
  assert(outcome.publicationPath, await readFile(outcome.resultPath, 'utf8'));
  const publication = await loadArchivePublication(outcome.publicationPath);
  const config = {
    publications: [outcome.publicationPath],
    readScope: 'source-root' as const,
  };
  async function cli(args: string[]) {
    const result = await exec(
      python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        join(f.base, 'state'),
        ...args,
      ],
      {
        cwd: registrarSource,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(registrarSource, 'src'),
          PYTHONNOUSERSITE: '1',
        },
        timeout: 60000,
        maxBuffer: 1_048_576,
      },
    );
    return JSON.parse(result.stdout);
  }
  return { ...f, publication, config, cli };
}

test('actual archive BM25 is opt-in, ranked, continuation-bound, and still reads exact retained bytes', async () => {
  const f = await fixture();
  const exact = await createArchiveRegistrar(f.config);
  const bm25 = await createArchiveRegistrar({
    ...f.config,
    discoveryMode: 'bm25',
  });
  const request = {
    scope: [f.source],
    query: 'signal',
    limit: 1,
    maxBytes: 16000,
    continuation: null,
  };
  const firstExact = await exact.discover(request);
  const firstRanked = await bm25.discover(request);
  assert(
    firstExact.ok && firstRanked.ok,
    JSON.stringify([firstExact, firstRanked]),
  );
  assert.equal(firstExact.value.documents[0].document.path, 'aaa.txt');
  assert.equal(firstRanked.value.documents[0].document.path, 'zzz.txt');
  assert.match(firstRanked.value.documents[0].applicability, /BM25-ranked/);
  assert.notEqual(exact.identity.configuration, bm25.identity.configuration);
  assert(firstRanked.value.next);
  const second = await bm25.discover({
    ...request,
    continuation: firstRanked.value.next,
  });
  assert(second.ok && second.value.coverage.exhausted);
  assert.equal(second.value.documents[0].document.path, 'aaa.txt');
  assert(
    !(
      await exact.discover({ ...request, continuation: firstRanked.value.next })
    ).ok,
  );
  assert(
    !(
      await bm25.discover({
        ...request,
        query: 'proposal',
        continuation: firstRanked.value.next,
      })
    ).ok,
  );
  await rm(join(f.base, 'sources'), { recursive: true });
  const retained = await bm25.read({
    document: firstRanked.value.documents[0].document,
    expectedSha256: firstRanked.value.documents[0].sha256,
    maxCodePoints: 8000,
    maxBytes: 65536,
    continuation: null,
  });
  assert(retained.ok);
  assert.match(retained.value.evidence.excerpt, /Signal signal signal/);
  assert.equal(retained.value.evidence.archive?.currentOriginal, 'not-checked');
});

test('actual archived graph reads and projection retain pinned source anchors and refuse scope changes', async () => {
  const f = await fixture();
  const anchors = [];
  for (const path of ['aaa.txt', 'zzz.txt']) {
    const read = await f.cli([
      'read',
      f.source.id,
      f.publication.generation,
      path,
      '--manifest-sha256',
      f.publication.manifestSha256,
      '--max-chars',
      '6',
    ]);
    const c = read.record.citations[0];
    anchors.push({
      source_id: f.source.id,
      generation: f.publication.generation,
      manifest_sha256: f.publication.manifestSha256,
      path,
      original_sha256: c.original_sha256,
      representation_sha256: c.representation_sha256,
      text_start: c.text_start,
      text_end: c.text_end,
      quote: c.quote,
      quote_sha256: hash(c.quote),
    });
  }
  const [a, b] = anchors;
  const graph = {
    schema: 1,
    revision_set: {
      schema: 1,
      selections: [
        {
          source_id: f.source.id,
          generation: f.publication.generation,
          manifest_sha256: f.publication.manifestSha256,
        },
      ],
    },
    parent: null,
    nodes: [
      {
        id: '1'.repeat(32),
        kind: 'mention',
        label: 'contrary proposal',
        provenance: 'extracted',
        anchors: [a],
      },
      {
        id: '2'.repeat(32),
        kind: 'mention',
        label: 'signal',
        provenance: 'extracted',
        anchors: [b],
      },
    ],
    assertions: [
      {
        id: '3'.repeat(32),
        kind: 'relationship',
        subject: '2'.repeat(32),
        predicate: 'contradicts',
        object: '1'.repeat(32),
        support: [b],
        contrary: [a],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
    ],
  };
  const batch = join(f.base, 'graph.json');
  await writeFile(batch, JSON.stringify(graph));
  const published = await f.cli(['graph-publish', batch]);
  assert.equal(published.status, 'complete');
  const reader = await createArchiveGraphReader(f.config);
  const request = {
    graphId: published.graph_id as string,
    scope: [f.source],
    limit: 1,
    maxBytes: 16000,
    cursor: null,
  };
  const first = await reader.read(request);
  assert(first.ok && first.value.next, JSON.stringify(first));
  assert.equal(first.value.currentOriginal, 'not-checked');
  assert.equal(
    first.value.records[0].anchors?.[0].manifest_sha256,
    f.publication.manifestSha256,
  );
  const next = await reader.read({ ...request, cursor: first.value.next });
  assert(next.ok && next.value.next);
  const expanded = await reader.read({
    ...request,
    limit: 10,
    nodeId: '2'.repeat(32),
  });
  assert(expanded.ok && expanded.value.exhausted);
  assert.equal(expanded.value.records.length, 3);
  const projection = await reader.projection(request.graphId, [f.source]);
  assert(projection.ok, JSON.stringify(projection));
  assert.equal(projection.value.nodes.length, 3);
  assert.equal(projection.value.edges.length, 2);
  assert.equal(projection.value.native.status, 'unavailable');
  await rm(join(f.base, 'sources'), { recursive: true });
  assert((await reader.read(request)).ok);
  const db = join(f.base, 'state/registry.sqlite3');
  await rename(db, `${db}.saved`);
  const denied = await reader.read({
    ...request,
    scope: [{ ...f.source, id: 'other-source' }],
  });
  assert(!denied.ok && denied.gap.kind === 'scope-refused');
  await rename(`${db}.saved`, db);
});

test('graph reader rejects a mismatched generation for a selected source with no anchors', async () => {
  const f = await fixture();
  const root = join(f.base, 'second-source');
  await mkdir(root);
  await writeFile(join(root, 'other.txt'), 'Original second source.\n');
  const python = f.publication.transport.python;
  const registrarSource = f.publication.transport.registrarSource;
  const { stdout } = await exec(python, [
    '-B', '-m', 'knowledge_agent.cli', 'sources', '--workspace',
    join(f.base, 'state'), 'add', root,
  ], {
    cwd: registrarSource,
    env: { PATH: '/usr/bin:/bin', PYTHONPATH: join(registrarSource, 'src'), PYTHONNOUSERSITE: '1' },
    timeout: 60000, maxBuffer: 1_048_576,
  });
  const secondId = JSON.parse(stdout).id as string;
  const secondSource = {
    provider: `temari-isolated-${secondId}`,
    id: secondId,
    locator: pathToFileURL(root).href,
  };
  const secondTask = join(f.base, 'second-task');
  await mkdir(secondTask);
  const firstCapture = await captureArchive({
    task: { id: 'second-source', directory: secondTask, authorityRef: 'synthetic-authority' },
    source: secondSource,
    readScope: 'source-root',
    transport: f.publication.transport,
    requestKey: 'first',
  });
  assert(firstCapture.publicationPath);
  const secondPublication = await loadArchivePublication(firstCapture.publicationPath);
  await writeFile(join(root, 'other.txt'), 'Changed second source.\n');
  const changed = await f.cli(['capture', secondId, '--request-key', 'changed']);
  assert.notEqual(changed.generation, secondPublication.generation);
  const read = await f.cli([
    'read', f.source.id, f.publication.generation, 'aaa.txt',
    '--manifest-sha256', f.publication.manifestSha256, '--max-chars', '6',
  ]);
  const c = read.record.citations[0];
  const anchor = {
    source_id: f.source.id,
    generation: f.publication.generation,
    manifest_sha256: f.publication.manifestSha256,
    path: 'aaa.txt',
    original_sha256: c.original_sha256,
    representation_sha256: c.representation_sha256,
    text_start: c.text_start,
    text_end: c.text_end,
    quote: c.quote,
    quote_sha256: hash(c.quote),
  };
  const graph = {
    schema: 1,
    revision_set: { schema: 1, selections: [
      { source_id: f.source.id, generation: f.publication.generation,
        manifest_sha256: f.publication.manifestSha256 },
      { source_id: secondId, generation: changed.generation,
        manifest_sha256: changed.manifest_sha256 },
    ] },
    parent: null,
    nodes: [{ id: '4'.repeat(32), kind: 'mention', label: 'signal',
      provenance: 'extracted', anchors: [anchor] }],
    assertions: [],
  };
  const batch = join(f.base, 'mismatched-revision-set.json');
  await writeFile(batch, JSON.stringify(graph));
  const published = await f.cli(['graph-publish', batch]);
  const reader = await createArchiveGraphReader({
    publications: [f.config.publications[0], firstCapture.publicationPath],
    readScope: 'source-root',
  });
  const scope = [f.source, secondSource];
  const result = await reader.read({
    graphId: published.graph_id, scope, limit: 10, maxBytes: 16000, cursor: null,
  });
  assert(!result.ok);
  assert(!(await reader.projection(published.graph_id, scope)).ok);
});
