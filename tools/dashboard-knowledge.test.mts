import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareRegistrar } from '../libs/knowledge/src/support/prepare.js';
import {
  captureArchive,
  loadArchivePublication,
} from '../libs/knowledge/src/lib/archive-intake.js';
import { publishArchiveDocumentLinks } from '../libs/knowledge/src/lib/archive-document-links.js';
import { hash, canonical } from '../libs/knowledge/src/lib/codec.js';
import {
  parseDashboardKnowledgeOptions,
  inspectKnowledgeMap,
  selectKnowledgeMapNode,
  expandKnowledgeMap,
  type DashboardKnowledgeOptions,
} from './dashboard-knowledge.mjs';
const exec = promisify(execFile);
const python = process.env['TEMARI_REGISTRAR_PYTHON'];
const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
const structural = {
  readScope: 'source-root',
  publications: [
    {
      id: 'source-one',
      publicationPath: '/explicit/archive-publication.json',
      sha256: 'a'.repeat(64),
    },
  ],
  graphs: [
    { id: 'links', graphId: 'b'.repeat(64), publicationIds: ['source-one'] },
  ],
};

test('not configured is honest and performs no implicit discovery', async () => {
  assert.deepEqual(await inspectKnowledgeMap(), {
    schema: 1,
    state: 'not-configured',
    configurationId: null,
    nodes: [],
    edges: [],
    gaps: [],
    coverage: {
      configuredPublications: 0,
      validPublications: 0,
      documentsReturned: 0,
      documentsKnown: 0,
      graphRecordsReturned: 0,
      graphRecordsKnown: 0,
      truncated: false,
      semanticRecall: 'not-evaluated',
      consistency: 'sequential-checks-not-atomic',
    },
    historical: true,
    currentOriginal: 'not-checked',
  });
});
test('configuration refuses scope widening, client query knobs, unpinned publications and excessive bounds', () => {
  assert.equal(
    parseDashboardKnowledgeOptions(structural).publications[0]!.sha256,
    'a'.repeat(64),
  );
  for (const value of [
    { ...structural, readScope: 'all' },
    { ...structural, query: 'secret' },
    {
      ...structural,
      publications: [
        {
          id: 'source-one',
          publicationPath: 'relative.json',
          sha256: 'a'.repeat(64),
        },
      ],
    },
    {
      ...structural,
      publications: [
        {
          id: 'source-one',
          publicationPath: '/explicit/file',
          sha256: 'latest',
        },
      ],
    },
    {
      ...structural,
      graphs: [
        { id: 'links', graphId: 'b'.repeat(64), publicationIds: ['outside'] },
      ],
    },
    { ...structural, limits: { graphRecords: 101 } },
    { ...structural, limits: { responseBytes: 524289 } },
  ])
    assert.throws(() => parseDashboardKnowledgeOptions(value));
});
test('missing pinned publication yields an explicit gap and never guesses a replacement', async () => {
  const map = await inspectKnowledgeMap(
    parseDashboardKnowledgeOptions(structural),
  );
  assert.equal(map.state, 'unavailable');
  assert(map.gaps.some((g) => g.kind === 'publication-unavailable'));
  assert(!map.nodes.some((n) => n.kind === 'document'));
  await assert.rejects(
    () =>
      selectKnowledgeMapNode(
        parseDashboardKnowledgeOptions(structural),
        '/etc/passwd',
      ),
    /Unknown/,
  );
});

test(
  'ACTUAL Registrar: pinned archive catalog and graph projection preserve navigation evidence and deny unsafe changes',
  {
    skip:
      !python || !registrarSource
        ? 'Explicit pinned Registrar source and Python are required for actual adapter proof.'
        : false,
  },
  async (t) => {
    const version = await exec(python!, [
      '-c',
      'import sys;print(str(sys.version_info.major)+"."+str(sys.version_info.minor))',
    ]);
    assert.equal(version.stdout.trim(), '3.12');
    const f = await prepareRegistrar({
      python: python!,
      registrarSource: registrarSource!,
      documents: [
        { path: 'docs/start.md', bytes: Buffer.from('Start [map](map.md).\n') },
        {
          path: 'docs/map.md',
          bytes: Buffer.from(
            'PRIVATE_CONTENT_DO_NOT_LABEL: retained map target.\n',
          ),
        },
        {
          path: 'notes/extra.md',
          bytes: Buffer.from('An extra retained document.\n'),
        },
      ],
    });
    if (!process.env['TEMARI_KNOWLEDGE_PROOF_PATH'])
      t.after(() => rm(f.base, { recursive: true, force: true }));
    const intake = {
      task: {
        id: 'dashboard-map',
        directory: join(f.base, 'task'),
        authorityRef: 'explicit-synthetic-dashboard-map-proof',
      },
      source: f.source,
      readScope: 'source-root' as const,
      transport: {
        python: python!,
        registrarSource: registrarSource!,
        workspace: join(f.base, 'state'),
      },
      requestKey: 'map-v1',
    };
    const captured = await captureArchive(intake);
    assert(captured.publicationPath, JSON.stringify(captured));
    const publicationPath = captured.publicationPath;
    const publication = await loadArchivePublication(publicationPath);
    const published = await publishArchiveDocumentLinks({
      publicationPath,
      paths: ['docs/start.md', 'docs/map.md'],
      maxEdges: 10,
    });
    assert.equal(published.status, 'published');
    assert(published.graphId);
    const options: DashboardKnowledgeOptions = parseDashboardKnowledgeOptions({
      readScope: 'source-root',
      publications: [
        {
          id: 'fixture',
          publicationPath,
          sha256: hash(await readFile(publicationPath)),
        },
      ],
      graphs: [
        {
          id: 'document-links',
          graphId: published.graphId,
          publicationIds: ['fixture'],
        },
      ],
    });
    const database = join(f.base, 'state', 'registry.sqlite3');
    const databaseBefore = hash(await readFile(database));
    const map = await inspectKnowledgeMap(options);
    await t.test(
      'actual document/path/source/publication and anchored graph assertions are shown without raw text',
      async () => {
        assert.equal(map.state, 'partial');
        assert(map.gaps.every((gap) => gap.kind === 'capability-gap'));
        for (const kind of [
          'source',
          'publication',
          'document',
          'path',
          'graph',
          'assertion',
          'provenance',
        ])
          assert(
            map.nodes.some((node) => node.kind === kind),
            kind,
          );
        assert(map.nodes.some((node) => node.label === 'docs/start.md'));
        assert(
          map.nodes.some(
            (node) => node.kind === 'path' && node.label === 'docs',
          ),
        );
        assert.equal(map.coverage.documentsKnown, 3);
        assert.equal(map.coverage.documentsReturned, 3);
        assert.equal(map.currentOriginal, 'not-checked');
        assert.equal(map.coverage.semanticRecall, 'not-evaluated');
        const assertion = map.nodes.find((node) => node.kind === 'assertion')!;
        assert(assertion.qualifiers.includes('extracted'));
        assert(assertion.qualifiers.includes('historical'));
        assert(
          assertion.anchors.some(
            (a) => a.role === 'support' && a.path === 'docs/start.md',
          ),
        );
        for (const edge of map.edges.filter(
          (edge) => edge.kind !== 'has-gap',
        )) {
          assert(edge.anchors.length > 0, edge.kind);
          assert(
            edge.anchors.every(
              (a) =>
                a.generation === publication.generation &&
                a.manifestSha256 === publication.manifestSha256,
            ),
          );
        }
        assert(!JSON.stringify(map).includes('PRIVATE_CONTENT_DO_NOT_LABEL'));
        assert(!JSON.stringify(map).includes('"quote":'));
      },
    );
    await t.test(
      'selection and one-hop expansion resolve server IDs and retain exact click detail identity',
      async () => {
        const document = map.nodes.find(
          (node) => node.kind === 'document' && node.label === 'docs/map.md',
        )!;
        const detail = await selectKnowledgeMapNode(options, document.id);
        assert.equal(detail.state, 'ready');
        assert.equal(detail.metadata['path'], 'docs/map.md');
        assert.equal(detail.metadata['generation'], publication.generation);
        assert.equal(
          detail.metadata['sha256'],
          hash(
            Buffer.from('PRIVATE_CONTENT_DO_NOT_LABEL: retained map target.\n'),
          ),
        );
        assert(
          !JSON.stringify(detail).includes('PRIVATE_CONTENT_DO_NOT_LABEL'),
        );
        const assertion = map.nodes.find((node) => node.kind === 'assertion')!;
        const assertionDetail = await selectKnowledgeMapNode(
          options,
          assertion.id,
        );
        assert.equal(assertionDetail.state, 'ready');
        assert.equal(assertionDetail.metadata['predicate'], 'links-to');
        assert.equal(assertionDetail.metadata['provenance'], 'extracted');
        assert(
          assertionDetail.node.anchors.every((a) => a.quoteSha256 && a.span),
        );
        const expanded = await expandKnowledgeMap(options, assertion.id);
        assert(expanded.nodes.some((node) => node.id === assertion.id));
        assert(
          expanded.edges.some(
            (edge) => edge.source === assertion.id && edge.kind === 'subject',
          ),
        );
        assert(
          expanded.edges.some(
            (edge) => edge.source === assertion.id && edge.kind === 'object',
          ),
        );
        await assert.rejects(
          () => expandKnowledgeMap(options, 'km-' + '0'.repeat(32)),
          /Unknown|expired/,
        );
        await assert.rejects(
          () =>
            selectKnowledgeMapNode(
              { ...options, limits: { documentsPerPublication: 1 } },
              document.id,
            ),
          /Unknown|expired/,
        );
        assert.equal(
          hash(await readFile(database)),
          databaseBefore,
          'Map inspection, selection and expansion must leave authoritative Registrar state unchanged.',
        );
      },
    );
    await t.test(
      'node, edge, byte and page bounds disclose omissions',
      async () => {
        const bounded = await inspectKnowledgeMap({
          ...options,
          limits: {
            documentsPerPublication: 1,
            graphRecords: 1,
            nodes: 16,
            edges: 16,
            responseBytes: 8192,
          },
        });
        assert.equal(bounded.state, 'partial');
        assert(bounded.coverage.truncated);
        assert(bounded.nodes.length <= 16);
        assert(bounded.edges.length <= 16);
        assert(Buffer.byteLength(canonical(bounded)) <= 8192);
        assert(bounded.gaps.some((g) => g.kind === 'catalog-bound'));
        assert(
          bounded.gaps.some(
            (g) => g.kind === 'graph-bound' || g.kind === 'projection-bound',
          ),
        );
        const ids = new Set(bounded.nodes.map((node) => node.id));
        assert(
          bounded.edges.every(
            (edge) => ids.has(edge.source) && ids.has(edge.target),
          ),
        );
      },
    );
    await t.test(
      'catalog gap expansion reads only its next pinned metadata page through a server ID',
      async () => {
        const paged = {
          ...options,
          graphs: [],
          limits: { documentsPerPublication: 1 },
        };
        const first = await inspectKnowledgeMap(paged);
        const next = first.gaps.find((gap) => gap.kind === 'catalog-bound')!;
        assert(next);
        const expanded = await expandKnowledgeMap(paged, next.id);
        assert(
          expanded.nodes.some(
            (node) => node.kind === 'document' && node.label === 'docs/map.md',
          ),
        );
        assert(
          expanded.nodes
            .flatMap((node) => node.anchors)
            .every((a) => a.generation === publication.generation),
        );
        const repeated = await expandKnowledgeMap(paged, next.id);
        assert.deepEqual(
          repeated,
          expanded,
          'The same server selection must replay the same pinned page.',
        );
        const second = expanded.gaps.find(
          (gap) => gap.kind === 'catalog-bound',
        )!;
        assert.notEqual(second.id, next.id);
        const third = await expandKnowledgeMap(paged, second.id);
        assert(
          third.nodes.some(
            (node) =>
              node.kind === 'document' && node.label === 'docs/start.md',
          ),
        );
        let last = third;
        for (let remaining = 0; remaining < 4; remaining++) {
          const nextGap = last.gaps.find((gap) => gap.kind === 'catalog-bound');
          if (!nextGap) break;
          last = await expandKnowledgeMap(paged, nextGap.id);
        }
        assert(!last.gaps.some((gap) => gap.kind === 'catalog-bound'));
        assert(last.gaps.some((gap) => gap.kind === 'catalog-page'));
        assert(
          last.coverage.truncated,
          'A later page cannot claim to be the whole catalog.',
        );
      },
    );
    await t.test(
      'missing originals and a newer capture never replace the selected historical generation',
      async () => {
        await writeFile(
          join(f.base, 'sources', 'docs', 'map.md'),
          'NEW LIVE CONTENT MUST NOT REPLACE V1\n',
        );
        const newer = await captureArchive({ ...intake, requestKey: 'map-v2' });
        assert(newer.publicationPath);
        assert.notEqual(
          (await loadArchivePublication(newer.publicationPath)).generation,
          publication.generation,
        );
        await rename(join(f.base, 'sources'), join(f.base, 'sources-away'));
        try {
          const retained = await inspectKnowledgeMap(options);
          assert.equal(retained.state, 'partial');
          assert(retained.gaps.every((gap) => gap.kind === 'capability-gap'));
          assert(
            retained.nodes
              .flatMap((node) => node.anchors)
              .every((a) => a.generation === publication.generation),
          );
          const doc = retained.nodes.find(
            (node) => node.kind === 'document' && node.label === 'docs/map.md',
          )!;
          assert.equal(
            (await selectKnowledgeMapNode(options, doc.id)).state,
            'ready',
          );
        } finally {
          await rename(join(f.base, 'sources-away'), join(f.base, 'sources'));
        }
        const mismatched = await inspectKnowledgeMap({
          ...options,
          publications: [
            {
              id: 'fixture',
              publicationPath: newer.publicationPath,
              sha256: hash(await readFile(newer.publicationPath)),
            },
          ],
        });
        assert(mismatched.gaps.some((g) => g.kind === 'graph-unavailable'));
        assert(!mismatched.nodes.some((n) => n.kind === 'assertion'));
      },
    );
    await t.test(
      'corrupt publication pin refuses the source before projection',
      async () => {
        const refused = await inspectKnowledgeMap({
          ...options,
          publications: [
            { ...options.publications[0]!, sha256: '0'.repeat(64) },
          ],
        });
        assert.equal(refused.state, 'unavailable');
        assert(refused.gaps.some((g) => g.kind === 'publication-unavailable'));
        assert(!refused.nodes.some((n) => n.kind === 'document'));
      },
    );
    await t.test(
      'disabled source revokes overview and previously selected details',
      async () => {
        const original = (
          await exec(python!, [
            '-c',
            "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0])",
            database,
            f.source.id,
          ])
        ).stdout.trim();
        await exec(python!, [
          '-c',
          "import sqlite3,sys,json;db=sqlite3.connect(sys.argv[1]);row=json.loads(sys.argv[3]);row['enabled']=False;db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2]));db.commit()",
          database,
          f.source.id,
          original,
        ]);
        try {
          const refused = await inspectKnowledgeMap(options);
          assert.equal(refused.state, 'unavailable');
          const selected = await selectKnowledgeMapNode(
            options,
            map.nodes.find((n) => n.kind === 'document')!.id,
          );
          assert.equal(selected.state, 'unavailable');
          assert(selected.gaps.length);
          assert.equal(selected.edges.length, 0);
          assert.equal(selected.node.anchors.length, 0);
          assert.deepEqual(
            selected.metadata,
            {},
            'Revocation must not serve cached source metadata.',
          );
        } finally {
          await exec(python!, [
            '-c',
            "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('UPDATE sources SET data=? WHERE id=?',(sys.argv[3],sys.argv[2]));db.commit()",
            database,
            f.source.id,
            original,
          ]);
        }
      },
    );
    await t.test(
      'corrupt retained manifest yields gaps rather than live-source fallback',
      async () => {
        const saved = (
          await exec(python!, [
            '-c',
            "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);print(db.execute('SELECT hex(manifest) FROM archive_generations WHERE id=?',(sys.argv[2],)).fetchone()[0])",
            database,
            publication.generation,
          ])
        ).stdout.trim();
        await exec(python!, [
          '-c',
          'import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute("UPDATE archive_generations SET manifest=x\'7b7d\' WHERE id=?",(sys.argv[2],));db.commit()',
          database,
          publication.generation,
        ]);
        try {
          const refused = await inspectKnowledgeMap(options);
          assert.equal(refused.state, 'unavailable');
          assert(
            refused.gaps.some((g) => g.kind === 'publication-unavailable'),
          );
          assert(!refused.nodes.some((n) => n.kind === 'document'));
        } finally {
          await exec(python!, [
            '-c',
            "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('UPDATE archive_generations SET manifest=? WHERE id=?',(bytes.fromhex(sys.argv[3]),sys.argv[2]));db.commit()",
            database,
            publication.generation,
            saved,
          ]);
        }
      },
    );
    if (process.env['TEMARI_KNOWLEDGE_PROOF_PATH']) {
      const finalMap = await inspectKnowledgeMap(options);
      assert.equal(finalMap.state, 'partial');
      assert(finalMap.gaps.every((gap) => gap.kind === 'capability-gap'));
      await writeFile(
        process.env['TEMARI_KNOWLEDGE_PROOF_PATH']!,
        JSON.stringify(
          {
            schema: 1,
            kind: 'synthetic-registrar-dashboard-map',
            fixtureRoot: f.base,
            sourceRoot: join(f.base, 'sources'),
            workspaceRoot: join(f.base, 'state'),
            python,
            registrarSource,
            options,
            selectedGeneration: publication.generation,
            selectedManifestSha256: publication.manifestSha256,
            note: 'Synthetic retained archive and actual Registrar graph; original source was changed for the no-latest-fallback test. The configured map remains pinned to v1.',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    }
  },
);
