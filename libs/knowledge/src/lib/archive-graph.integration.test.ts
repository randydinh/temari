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
import { createArchiveGraphReader, retractArchiveGraph } from './archive-graph.js';
import { evaluateArchiveGraphTrial } from './archive-graph-trial.js';
import { publishArchiveStructure } from './archive-structure.js';
import { evaluateArchiveSearch, runArchiveIntake } from './archive-journey.js';
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
  const review = await retractArchiveGraph({
    publications: f.config.publications,
    graphId: request.graphId,
    assertionIds: ['3'.repeat(32)],
    reviewerRef: 'synthetic-operator',
    reason: 'Fixture relationship rejected after review',
  });
  const reviewReceipt = JSON.parse(await readFile(review.receiptPath, 'utf8'));
  assert.equal(reviewReceipt.parentGraphId, request.graphId);
  assert.equal(reviewReceipt.reason, 'Fixture relationship rejected after review');
  assert.equal(reviewReceipt.revisionSetId, first.value.revisionSetId);
  const child = await reader.read({ ...request, graphId: review.graphId, limit: 10 });
  assert(child.ok);
  assert.equal(child.value.records.at(-1)?.lifecycle, 'retracted');
  const historical = await reader.read({ ...request, limit: 10 });
  assert(historical.ok);
  assert.equal(historical.value.records.at(-1)?.lifecycle, 'active');
  await assert.rejects(() => retractArchiveGraph({
    publications: f.config.publications,
    graphId: review.graphId,
    assertionIds: ['3'.repeat(32)],
    reviewerRef: 'synthetic-operator',
    reason: 'Duplicate review',
  }));
  await rm(join(f.base, 'sources'), { recursive: true });
  assert((await reader.read(request)).ok);
  assert((await reader.read({ ...request, graphId: review.graphId })).ok);
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
  const { stdout } = await exec(
    python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      join(f.base, 'state'),
      'add',
      root,
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
  const secondId = JSON.parse(stdout).id as string;
  const secondSource = {
    provider: `temari-isolated-${secondId}`,
    id: secondId,
    locator: pathToFileURL(root).href,
  };
  const secondTask = join(f.base, 'second-task');
  await mkdir(secondTask);
  const firstCapture = await captureArchive({
    task: {
      id: 'second-source',
      directory: secondTask,
      authorityRef: 'synthetic-authority',
    },
    source: secondSource,
    readScope: 'source-root',
    transport: f.publication.transport,
    requestKey: 'first',
  });
  assert(firstCapture.publicationPath);
  const secondPublication = await loadArchivePublication(
    firstCapture.publicationPath,
  );
  await writeFile(join(root, 'other.txt'), 'Changed second source.\n');
  const changed = await f.cli([
    'capture',
    secondId,
    '--request-key',
    'changed',
  ]);
  assert.notEqual(changed.generation, secondPublication.generation);
  const read = await f.cli([
    'read',
    f.source.id,
    f.publication.generation,
    'aaa.txt',
    '--manifest-sha256',
    f.publication.manifestSha256,
    '--max-chars',
    '6',
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
    revision_set: {
      schema: 1,
      selections: [
        {
          source_id: f.source.id,
          generation: f.publication.generation,
          manifest_sha256: f.publication.manifestSha256,
        },
        {
          source_id: secondId,
          generation: changed.generation,
          manifest_sha256: changed.manifest_sha256,
        },
      ],
    },
    parent: null,
    nodes: [
      {
        id: '4'.repeat(32),
        kind: 'mention',
        label: 'signal',
        provenance: 'extracted',
        anchors: [anchor],
      },
    ],
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
    graphId: published.graph_id,
    scope,
    limit: 10,
    maxBytes: 16000,
    cursor: null,
  });
  assert(!result.ok);
  assert(!(await reader.projection(published.graph_id, scope)).ok);
});

test('actual Graft and Nx structure imports publish only archived, current source anchors', async () => {
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  assert(registrarSource && python);
  const documents = [
    {
      path: 'apps/app/project.json',
      bytes: Buffer.from('{"name":"app","implicitDependencies":["shared"]}\n'),
    },
    {
      path: 'apps/app/package.json',
      bytes: Buffer.from('{"name":"app","dependencies":{}}\n'),
    },
    {
      path: 'libs/shared/project.json',
      bytes: Buffer.from('{"name":"shared"}\n'),
    },
    {
      path: 'libs/shared/package.json',
      bytes: Buffer.from('{"name":"shared"}\n'),
    },
    {
      path: 'apps/scoped/package.json',
      bytes: Buffer.from(
        '{"name":"@pilot/app","dependencies":{"@pilot/shared":"workspace:*"}}\n',
      ),
    },
    {
      path: 'libs/scoped/package.json',
      bytes: Buffer.from('{"name":"@pilot/shared"}\n'),
    },
    {
      path: 'apps/packonly/project.json',
      bytes: Buffer.from('{"name":"packonly"}\n'),
    },
    {
      path: 'apps/excluded/project.json',
      bytes: Buffer.from(
        '{"name":"excluded","implicitDependencies":["shared","!shared"]}\n',
      ),
    },
    {
      path: 'apps/packonly/package.json',
      bytes: Buffer.from('{"name":"packonly","dependencies":{"shared":"*"}}\n'),
    },
    {
      path: 'src/Caller.swift',
      bytes: Buffer.from(
        'class Caller {\n  func callTarget() { target() }\n}\n',
      ),
    },
    {
      path: 'src/Target.swift',
      bytes: Buffer.from(
        'class Target {\n  func target() {}\n  func unused() {}\n}\n',
      ),
    },
    {
      path: 'src/CommentCaller.swift',
      bytes: Buffer.from(
        'class CommentCaller {\n  func callUnused() { /* unused() */ }\n}\n',
      ),
    },
    {
      path: 'src/BlockCommentCaller.swift',
      bytes: Buffer.from('/*\n  func fakeCall() { target() }\n*/\n'),
    },
    {
      path: 'src/RawCaller.swift',
      bytes: Buffer.from(
        'class RawCaller {\n  func callTarget() { let example = #"before " target() " after"# }\n}\n',
      ),
    },
    {
      path: 'src/InterpolatedCaller.swift',
      bytes: Buffer.from(
        'class InterpolatedCaller {\n  func callTarget() { let example = "\\(identity("target()"))" }\n}\n',
      ),
    },
    {
      path: 'src/RegexCaller.swift',
      bytes: Buffer.from(
        'class RegexCaller {\n  func callTarget() { let pattern = #/target()/# }\n}\n',
      ),
    },
    {
      path: 'src/UnicodeCaller.swift',
      bytes: Buffer.from(
        'class UnicodeCaller {\n  func callTarget() { étarget() }\n}\n',
      ),
    },
    {
      path: 'src/MultilineCaller.swift',
      bytes: Buffer.from(
        'class MultilineCaller {\n  func callTarget() { let example = """ before \\ """ target() \\ """ after """ }\n}\n',
      ),
    },
    {
      path: 'src/DeclarationCaller.swift',
      bytes: Buffer.from('class DeclarationCaller {\n  func target() {}\n}\n'),
    },
    {
      path: 'src/InitializerCaller.swift',
      bytes: Buffer.from('class InitializerCaller {\n  init() {}\n}\n'),
    },
    {
      path: 'src/TargetInit.swift',
      bytes: Buffer.from('class TargetInit {\n  init() {}\n}\n'),
    },
    {
      path: 'libs/decoy/project.json',
      bytes: Buffer.from('{"name":"other","description":"shared"}\n'),
    },
    {
      path: 'apps/escaped/package.json',
      bytes: Buffer.from(
        '{"name":"escaped-app","meta":{"dependencies":{"shared":"shadow"}},"\\u0064ependencies":{"\\u0073hared":"shared"}}\n',
      ),
    },
    {
      path: 'libs/escaped/package.json',
      bytes: Buffer.from('{"name":"shared"}\n'),
    },
  ];
  const f = await prepareRegistrar({
    registrarSource,
    python,
    documents: [
      { path: 'seed.txt', bytes: Buffer.from('Synthetic fixture.\n') },
    ],
  });
  for (const document of documents) {
    const path = join(f.base, 'sources', document.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, document.bytes);
  }
  const capture = await captureArchive({
    task: {
      id: 'structure-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-authority',
    },
    source: f.source,
    readScope: 'source-root',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
    requestKey: 'v1',
  });
  assert(capture.publicationPath);
  const graftPath = join(f.base, 'wiring.json');
  await writeFile(
    graftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'src/Caller.swift',
          path: 'src/Caller.swift',
          name: 'Caller.swift',
          span: 'L1-L4',
          kind: 'file',
          body_hash: hash(
            documents.find((item) => item.path === 'src/Caller.swift')!.bytes,
          ),
        },
        {
          id: 'src/Caller.swift#Caller.callTarget',
          path: 'src/Caller.swift',
          name: 'callTarget',
          span: 'L2-L2',
          kind: 'method',
          body_hash: hash('  func callTarget() { target() }'),
        },
        {
          id: 'src/Target.swift#Target.target',
          path: 'src/Target.swift',
          name: 'target',
          span: 'L2-L2',
          kind: 'method',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'src/Caller.swift',
          target: 'src/Caller.swift#Caller.callTarget',
          relation: 'contains',
          confidence: 'extracted',
        },
        {
          source: 'src/Caller.swift#Caller.callTarget',
          target: 'src/Target.swift#Target.target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  const graft = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: graftPath,
    kind: 'graft',
    paths: ['src/Caller.swift', 'src/Target.swift'],
    maxEdges: 4,
  });
  assert.equal(graft.relationshipCount, 2);
  const boundedGraft = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: graftPath,
    kind: 'graft',
    paths: ['src/Caller.swift', 'src/Target.swift'],
    maxEdges: 1,
  });
  assert.equal(boundedGraft.relationshipCount, 1);
  assert.equal(boundedGraft.skipped['edge-budget'], 1);
  const reader = await createArchiveGraphReader({
    publications: [capture.publicationPath],
    readScope: 'source-root',
  });
  const projection = await reader.projection(graft.graphId, [f.source]);
  assert(projection.ok, JSON.stringify(projection));
  assert.equal(projection.value.nodes.length, 5);
  assert.equal(projection.value.edges.length, 4);
  const relationships = projection.value.nodes.filter(
    (node) => node.attributes.kind === 'relationship',
  );
  assert(
    relationships.some(
      (node) => node.attributes.support?.[0]?.quote === 'target',
    ),
  );
  assert(
    relationships.some(
      (node) => node.attributes.support?.[0]?.quote === 'class Caller {',
    ),
  );

  const nxPath = join(f.base, 'nx-project-graph.json');
  await writeFile(
    nxPath,
    JSON.stringify({
      graph: {
        nodes: {
          app: { data: { root: 'apps/app' } },
          shared: { data: { root: 'libs/shared' } },
        },
        dependencies: {
          app: [{ source: 'app', target: 'shared', type: 'implicit' }],
          shared: [],
        },
      },
    }),
  );
  const nx = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: nxPath,
    kind: 'nx',
    paths: [
      'apps/app/project.json',
      'apps/app/package.json',
      'libs/shared/project.json',
      'libs/shared/package.json',
    ],
    maxEdges: 4,
  });
  assert.equal(nx.relationshipCount, 1);
  const nxProjection = await reader.projection(nx.graphId, [f.source]);
  assert(nxProjection.ok, JSON.stringify(nxProjection));
  assert.equal(nxProjection.value.nodes.length, 3);
  assert.equal(
    nxProjection.value.nodes.find(
      (node) => node.attributes.kind === 'relationship',
    )?.attributes.support?.[0]?.quote,
    'shared',
  );
  const scopedNxPath = join(f.base, 'scoped-nx.json');
  await writeFile(
    scopedNxPath,
    JSON.stringify({
      graph: {
        nodes: {
          'scoped-app': {
            data: {
              root: 'apps/scoped',
              metadata: { js: { packageName: '@pilot/app' } },
            },
          },
          'scoped-shared': {
            data: {
              root: 'libs/scoped',
              metadata: { js: { packageName: '@pilot/shared' } },
            },
          },
        },
        dependencies: {
          'scoped-app': [
            { source: 'scoped-app', target: 'scoped-shared', type: 'static' },
          ],
          'scoped-shared': [],
        },
      },
    }),
  );
  const scopedNx = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: scopedNxPath,
    kind: 'nx',
    paths: ['apps/scoped/package.json', 'libs/scoped/package.json'],
    maxEdges: 4,
  });
  assert.equal(scopedNx.relationshipCount, 1);
  const scopedTrial = await evaluateArchiveGraphTrial({
    graphId: scopedNx.graphId,
    publications: [capture.publicationPath],
    scope: [f.source],
    provider: await createArchiveRegistrar({
      publications: [capture.publicationPath],
      readScope: 'source-root',
    }),
    lexical: [
      {
        sourceId: f.source.id,
        path: 'seed.txt',
        sha256: hash('Synthetic fixture.\n'),
      },
      {
        sourceId: f.source.id,
        path: 'apps/scoped/package.json',
        sha256: hash(
          documents.find((item) => item.path === 'apps/scoped/package.json')!
            .bytes,
        ),
      },
    ],
    expected: [{ sourceId: f.source.id, path: 'libs/scoped/package.json' }],
    topK: 3,
    taskDirectory: join(f.base, 'task'),
  });
  assert.equal(scopedTrial.expectedRecallAtK, 1);
  const falseImplicitPath = join(f.base, 'false-implicit-nx.json');
  await writeFile(
    falseImplicitPath,
    JSON.stringify({
      graph: {
        nodes: {
          packonly: { data: { root: 'apps/packonly' } },
          shared: { data: { root: 'libs/shared' } },
        },
        dependencies: {
          packonly: [
            { source: 'packonly', target: 'shared', type: 'implicit' },
          ],
          shared: [],
        },
      },
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: falseImplicitPath,
      kind: 'nx',
      paths: [
        'apps/packonly/project.json',
        'apps/packonly/package.json',
        'libs/shared/project.json',
        'libs/shared/package.json',
      ],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const excludedNxPath = join(f.base, 'excluded-nx.json');
  await writeFile(
    excludedNxPath,
    JSON.stringify({
      graph: {
        nodes: {
          excluded: { data: { root: 'apps/excluded' } },
          shared: { data: { root: 'libs/shared' } },
        },
        dependencies: {
          excluded: [
            { source: 'excluded', target: 'shared', type: 'implicit' },
          ],
          shared: [],
        },
      },
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: excludedNxPath,
      kind: 'nx',
      paths: ['apps/excluded/project.json', 'libs/shared/project.json'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const staleGraftPath = join(f.base, 'stale-wiring.json');
  await writeFile(
    staleGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'src/Caller.swift#Caller.callTarget',
          path: 'src/Caller.swift',
          name: 'callTarget',
          span: 'L2-L2',
          kind: 'method',
          body_hash: hash('  func callTarget() { target() }'),
        },
        {
          id: 'src/Target.swift#Target.unused',
          path: 'src/Target.swift',
          name: 'unused',
          span: 'L3-L3',
          kind: 'method',
          body_hash: hash('  func unused() {}'),
        },
      ],
      edges: [
        {
          source: 'src/Caller.swift#Caller.callTarget',
          target: 'src/Target.swift#Target.unused',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: staleGraftPath,
      kind: 'graft',
      paths: ['src/Caller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const commentGraftPath = join(f.base, 'comment-wiring.json');
  await writeFile(
    commentGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'src/CommentCaller.swift#CommentCaller.callUnused',
          path: 'src/CommentCaller.swift',
          name: 'callUnused',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func callUnused() { /* unused() */ }'),
        },
        {
          id: 'src/Target.swift#Target.unused',
          path: 'src/Target.swift',
          name: 'unused',
          kind: 'method',
          span: 'L3-L3',
          body_hash: hash('  func unused() {}'),
        },
      ],
      edges: [
        {
          source: 'src/CommentCaller.swift#CommentCaller.callUnused',
          target: 'src/Target.swift#Target.unused',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: commentGraftPath,
      kind: 'graft',
      paths: ['src/CommentCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const blockCommentGraftPath = join(f.base, 'block-comment-wiring.json');
  await writeFile(
    blockCommentGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'block-comment-caller',
          path: 'src/BlockCommentCaller.swift',
          name: 'fakeCall',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func fakeCall() { target() }'),
        },
        {
          id: 'block-comment-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'block-comment-caller',
          target: 'block-comment-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: blockCommentGraftPath,
      kind: 'graft',
      paths: ['src/BlockCommentCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const rawGraftPath = join(f.base, 'raw-wiring.json');
  await writeFile(
    rawGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'raw-caller',
          path: 'src/RawCaller.swift',
          name: 'callTarget',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash(
            '  func callTarget() { let example = #"before " target() " after"# }',
          ),
        },
        {
          id: 'raw-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'raw-caller',
          target: 'raw-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: rawGraftPath,
      kind: 'graft',
      paths: ['src/RawCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const interpolatedGraftPath = join(f.base, 'interpolated-wiring.json');
  await writeFile(
    interpolatedGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'interpolated-caller',
          path: 'src/InterpolatedCaller.swift',
          name: 'callTarget',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash(
            '  func callTarget() { let example = "\\(identity("target()"))" }',
          ),
        },
        {
          id: 'interpolated-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'interpolated-caller',
          target: 'interpolated-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: interpolatedGraftPath,
      kind: 'graft',
      paths: ['src/InterpolatedCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const regexGraftPath = join(f.base, 'regex-wiring.json');
  await writeFile(
    regexGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'regex-caller',
          path: 'src/RegexCaller.swift',
          name: 'callTarget',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func callTarget() { let pattern = #/target()/# }'),
        },
        {
          id: 'regex-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'regex-caller',
          target: 'regex-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: regexGraftPath,
      kind: 'graft',
      paths: ['src/RegexCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const unicodeGraftPath = join(f.base, 'unicode-wiring.json');
  await writeFile(
    unicodeGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'unicode-caller',
          path: 'src/UnicodeCaller.swift',
          name: 'callTarget',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func callTarget() { étarget() }'),
        },
        {
          id: 'unicode-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'unicode-caller',
          target: 'unicode-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: unicodeGraftPath,
      kind: 'graft',
      paths: ['src/UnicodeCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const multilineGraftPath = join(f.base, 'multiline-wiring.json');
  await writeFile(
    multilineGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'multiline-caller',
          path: 'src/MultilineCaller.swift',
          name: 'callTarget',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash(
            '  func callTarget() { let example = """ before \\ """ target() \\ """ after """ }',
          ),
        },
        {
          id: 'multiline-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'multiline-caller',
          target: 'multiline-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: multilineGraftPath,
      kind: 'graft',
      paths: ['src/MultilineCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const declarationGraftPath = join(f.base, 'declaration-wiring.json');
  await writeFile(
    declarationGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'declaration-caller',
          path: 'src/DeclarationCaller.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
        {
          id: 'declaration-target',
          path: 'src/Target.swift',
          name: 'target',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  func target() {}'),
        },
      ],
      edges: [
        {
          source: 'declaration-caller',
          target: 'declaration-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: declarationGraftPath,
      kind: 'graft',
      paths: ['src/DeclarationCaller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const initGraftPath = join(f.base, 'init-wiring.json');
  await writeFile(
    initGraftPath,
    JSON.stringify({
      meta: { version: 1 },
      nodes: [
        {
          id: 'init-caller',
          path: 'src/InitializerCaller.swift',
          name: 'init',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  init() {}'),
        },
        {
          id: 'init-target',
          path: 'src/TargetInit.swift',
          name: 'init',
          kind: 'method',
          span: 'L2-L2',
          body_hash: hash('  init() {}'),
        },
      ],
      edges: [
        {
          source: 'init-caller',
          target: 'init-target',
          relation: 'calls',
          confidence: 'inferred',
        },
      ],
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: initGraftPath,
      kind: 'graft',
      paths: ['src/InitializerCaller.swift', 'src/TargetInit.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const decoyNxPath = join(f.base, 'decoy-nx.json');
  await writeFile(
    decoyNxPath,
    JSON.stringify({
      graph: {
        nodes: {
          app: { data: { root: 'apps/app' } },
          shared: { data: { root: 'libs/decoy' } },
        },
        dependencies: {
          app: [{ source: 'app', target: 'shared', type: 'static' }],
          shared: [],
        },
      },
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: decoyNxPath,
      kind: 'nx',
      paths: ['apps/app/project.json', 'libs/decoy/project.json'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const escapedNxPath = join(f.base, 'escaped-nx.json');
  await writeFile(
    escapedNxPath,
    JSON.stringify({
      graph: {
        nodes: {
          'escaped-app': { data: { root: 'apps/escaped' } },
          shared: { data: { root: 'libs/escaped' } },
        },
        dependencies: {
          'escaped-app': [
            { source: 'escaped-app', target: 'shared', type: 'static' },
          ],
          shared: [],
        },
      },
    }),
  );
  const escapedNx = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: escapedNxPath,
    kind: 'nx',
    paths: ['apps/escaped/package.json', 'libs/escaped/package.json'],
    maxEdges: 4,
  });
  const escapedProjection = await reader.projection(escapedNx.graphId, [
    f.source,
  ]);
  assert(escapedProjection.ok);
  assert.equal(
    escapedProjection.value.nodes.find(
      (node) => node.attributes.kind === 'relationship',
    )?.attributes.support?.[0]?.quote,
    '"\\u0073hared"',
  );
  const staleNxPath = join(f.base, 'stale-nx.json');
  await writeFile(
    staleNxPath,
    JSON.stringify({
      graph: {
        nodes: {
          app: { data: { root: 'apps/app' } },
          shared: { data: { root: 'libs/shared' } },
        },
        dependencies: {
          app: [],
          shared: [{ source: 'shared', target: 'app', type: 'static' }],
        },
      },
    }),
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: staleNxPath,
      kind: 'nx',
      paths: ['apps/app/project.json', 'libs/shared/project.json'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
  const intake = await runArchiveIntake({
    task: {
      id: 'structure-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-authority',
    },
    intakes: [
      {
        task: {
          id: 'structure-test',
          directory: join(f.base, 'task'),
          authorityRef: 'synthetic-authority',
        },
        source: f.source,
        readScope: 'source-root',
        transport: {
          python,
          registrarSource,
          workspace: join(f.base, 'state'),
        },
        requestKey: 'v1',
      },
    ],
    structures: [
      {
        sourceId: f.source.id,
        artifactPath: graftPath,
        kind: 'graft',
        paths: ['src/Caller.swift', 'src/Target.swift'],
        maxEdges: 4,
      },
    ],
  });
  assert(intake.handoffPath && intake.structures?.[0]?.graphId);
  const automatic = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases: [
      {
        id: 'automatic-graph',
        query: 'callTarget',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'src/Target.swift' }],
        topK: 2,
        discoveryMode: 'bm25',
        hostedTextApproved: false,
      },
    ],
  });
  assert.equal(automatic.report.cases[0].expectedRecallAtK, 0);
  assert.equal(automatic.report.cases[0].graph?.expectedRecallAtK, 1);
  await writeFile(
    join(f.base, 'sources/src/Target.swift'),
    'class Target { changed }\n',
  );
  const partial = await publishArchiveStructure({
    publicationPath: capture.publicationPath,
    artifactPath: graftPath,
    kind: 'graft',
    paths: ['src/Caller.swift', 'src/Target.swift'],
    maxEdges: 4,
  });
  assert.equal(partial.relationshipCount, 1);
  await writeFile(
    join(f.base, 'sources/src/Caller.swift'),
    'class Caller { changed }\n',
  );
  await assert.rejects(
    publishArchiveStructure({
      publicationPath: capture.publicationPath,
      artifactPath: graftPath,
      kind: 'graft',
      paths: ['src/Caller.swift', 'src/Target.swift'],
      maxEdges: 4,
    }),
    /No structure edges/,
  );
});
