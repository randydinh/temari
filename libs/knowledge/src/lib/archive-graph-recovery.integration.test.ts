import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { prepareRegistrar } from '../support/prepare.js';
import { canonical, hash } from './codec.js';
import {
  planArchiveRecoveryDependencies,
  recheckArchiveRecoveryDependencies,
} from './archive-recovery-dependency-plan.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: ordered root and retracted-child OKF replay preserves graph lineage in a fresh local-only workspace', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource, 'Pinned actual Registrar required');
  const originals = {
    'evidence.md': Buffer.from(
      'Synthetic signal café 😀 remains archived.\r\n',
    ),
    'removed.txt': Buffer.from('Synthetic second original remains archived.\n'),
  };
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: Object.entries(originals).map(([path, bytes]) => ({
      path,
      bytes,
    })),
  });
  try {
    const sourceState = join(f.base, 'state');
    const restoredState = join(f.base, 'restored-state');
    const archiveTamperState = join(f.base, 'archive-tamper-state');
    const okfTamperState = join(f.base, 'okf-tamper-state');
    const childTamperState = join(f.base, 'child-tamper-state');
    const disabledState = join(f.base, 'disabled-state');
    const childDisabledState = join(f.base, 'child-disabled-state');
    const environment = {
      PATH: '/usr/bin:/bin',
      PYTHONPATH: join(registrarSource, 'src'),
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      LANG: 'en_US.UTF-8',
    };

    async function command(
      workspace: string,
      route: 'archive' | 'sources',
      args: string[],
    ) {
      try {
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
          { env: environment, timeout: 60000, maxBuffer: 1_048_576 },
        );
        return {
          code: 0,
          body: JSON.parse(result.stdout) as Record<string, unknown>,
        };
      } catch (error) {
        const failure = error as { code: number; stdout: string };
        assert.equal(failure.code, 2, String(error));
        return {
          code: 2,
          body: JSON.parse(failure.stdout) as Record<string, unknown>,
        };
      }
    }
    async function archive(workspace: string, args: string[]) {
      return command(workspace, 'archive', args);
    }
    async function refused(workspace: string, args: string[], reason: RegExp) {
      const result = await archive(workspace, args);
      assert.equal(result.code, 2, JSON.stringify(result.body));
      assert.equal(result.body['status'], 'invalid');
      assert.match(String(result.body['error']), reason);
    }
    async function backup(destination: string): Promise<void> {
      await mkdir(destination);
      await exec(
        python,
        [
          '-B',
          '-c',
          'import sqlite3,sys; source=sqlite3.connect(sys.argv[1]); target=sqlite3.connect(sys.argv[2]); source.backup(target); target.close(); source.close()',
          join(sourceState, 'registry.sqlite3'),
          join(destination, 'registry.sqlite3'),
        ],
        { env: environment, timeout: 60000 },
      );
    }
    async function counts(workspace: string) {
      const { stdout } = await exec(
        python,
        [
          '-B',
          '-c',
          "import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps([db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ('archive_generations','revision_sets','graph_generations','graph_record_identities','graph_retractions')]))",
          join(workspace, 'registry.sqlite3'),
        ],
        { env: environment, timeout: 60000 },
      );
      return JSON.parse(stdout) as number[];
    }
    async function graphLedger(workspace: string) {
      const { stdout } = await exec(
        python,
        [
          '-B',
          '-c',
          "import hashlib,json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); tables=('revision_sets','graph_generations','graph_record_identities','graph_retractions'); print(json.dumps({table:[(row[0],hashlib.sha256(row[1]).hexdigest()) if len(row)>1 else (row[0],) for row in db.execute('SELECT * FROM '+table+' ORDER BY id')] for table in tables}))",
          join(workspace, 'registry.sqlite3'),
        ],
        { env: environment, timeout: 60000 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    }

    const sharing = await command(sourceState, 'sources', [
      'set-sharing',
      f.source.id,
      'local-only',
    ]);
    assert.equal(sharing.code, 0);
    assert.equal(sharing.body['sharing'], 'local-only');
    const initialSources = (await command(sourceState, 'sources', ['list']))
      .body['sources'];
    await Promise.all(
      [
        restoredState,
        archiveTamperState,
        okfTamperState,
        childTamperState,
        disabledState,
        childDisabledState,
      ].map(backup),
    );
    for (const workspace of [
      restoredState,
      archiveTamperState,
      okfTamperState,
      childTamperState,
      disabledState,
      childDisabledState,
    ]) {
      assert.deepEqual(await counts(workspace), [0, 0, 0, 0, 0]);
      const listed = await command(workspace, 'sources', ['list']);
      assert.equal(
        canonical(listed.body['sources']),
        canonical(initialSources),
        'Destination registration and local-only access must predate capture',
      );
    }

    const captured = await archive(sourceState, [
      'capture',
      f.source.id,
      '--request-key',
      'paired-root-graph-v1',
    ]);
    assert.equal(captured.code, 0);
    assert.equal(captured.body['preservation'], 'complete-admitted');
    const generation = String(captured.body['generation']);
    const manifest = String(captured.body['manifest_sha256']);
    assert.match(generation, /^[a-f0-9]{32}$/);
    assert.match(manifest, /^[a-f0-9]{64}$/);
    const snapshot = JSON.stringify({ [f.source.id]: generation });
    const readArgs = (path: string) => [
      'read',
      f.source.id,
      generation,
      path,
      '--manifest-sha256',
      manifest,
    ];
    async function anchor(path: keyof typeof originals) {
      const result = await archive(sourceState, [
        ...readArgs(path),
        '--max-chars',
        '12',
      ]);
      assert.equal(result.code, 0);
      const record = result.body['record'] as {
        citations: Array<Record<string, unknown>>;
      };
      const citation = record.citations[0];
      assert(citation);
      assert.equal(citation['original_sha256'], hash(originals[path]));
      const span = Array.from(originals[path].toString('utf8'))
        .slice(Number(citation['text_start']), Number(citation['text_end']))
        .join('');
      assert.equal(span, citation['quote']);
      return {
        source_id: f.source.id,
        generation,
        manifest_sha256: manifest,
        path,
        original_sha256: citation['original_sha256'],
        representation_sha256: citation['representation_sha256'],
        text_start: citation['text_start'],
        text_end: citation['text_end'],
        quote: citation['quote'],
        quote_sha256: hash(citation['quote'] as string),
      };
    }
    const a = await anchor('evidence.md');
    const b = await anchor('removed.txt');
    const ids = { a: '1'.repeat(32), b: '2'.repeat(32), link: '3'.repeat(32) };
    const graph = {
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          { source_id: f.source.id, generation, manifest_sha256: manifest },
        ],
      },
      parent: null as string | null,
      nodes: [
        {
          id: ids.a,
          kind: 'mention',
          label: 'synthetic signal',
          provenance: 'extracted',
          anchors: [a],
        },
        {
          id: ids.b,
          kind: 'mention',
          label: 'synthetic second',
          provenance: 'extracted',
          anchors: [b],
        },
      ],
      assertions: [
        {
          id: ids.link,
          kind: 'relationship',
          subject: ids.a,
          predicate: 'related-to',
          object: ids.b,
          support: [a],
          contrary: [b],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
      ],
    };
    const graphBatch = join(f.base, 'graph-root.json');
    await writeFile(graphBatch, canonical(graph));
    const published = await archive(sourceState, ['graph-publish', graphBatch]);
    assert.equal(published.code, 0);
    assert.equal(published.body['status'], 'complete');
    const graphId = String(published.body['graph_id']);
    const revisionSetId = String(published.body['revision_set_id']);
    assert.match(graphId, /^[a-f0-9]{64}$/);
    assert.match(revisionSetId, /^[a-f0-9]{64}$/);
    const graphScope = ['--source', f.source.id];
    const originalRead = await archive(sourceState, [
      'graph-read',
      graphId,
      ...graphScope,
      '--limit',
      '10',
    ]);
    assert.equal(originalRead.code, 0);
    assert.equal(originalRead.body['revision_set_id'], revisionSetId);
    assert.equal(originalRead.body['exhausted'], true);
    assert.equal(
      canonical(originalRead.body['records']),
      canonical([...graph.nodes, ...graph.assertions]),
    );
    const originalProjection = await archive(sourceState, [
      'graph-projection',
      graphId,
      ...graphScope,
    ]);
    assert.equal(originalProjection.code, 0);
    const projectionPath = join(f.base, 'derived-projection.json');
    await writeFile(
      projectionPath,
      canonical(originalProjection.body['projection']),
    );
    const originalCheck = await archive(sourceState, [
      'graph-check',
      graphId,
      ...graphScope,
      projectionPath,
    ]);
    assert.equal(originalCheck.body['status'], 'verified');
    assert.equal(originalCheck.body['native_proof'], false);

    const retired = await archive(sourceState, [
      'graph-retract',
      graphId,
      ...graphScope,
      '--assertion',
      ids.link,
    ]);
    assert.equal(retired.code, 0);
    assert.equal(retired.body['parent_graph_id'], graphId);
    assert.deepEqual(retired.body['retracted_assertion_ids'], [ids.link]);
    const childGraphId = String(retired.body['graph_id']);
    assert.match(childGraphId, /^[a-f0-9]{64}$/);
    assert.notEqual(childGraphId, graphId);
    assert.equal(retired.body['revision_set_id'], revisionSetId);
    const childGraph = structuredClone(graph);
    childGraph.parent = graphId;
    childGraph.assertions[0].lifecycle = 'retracted';
    const originalChildRead = await archive(sourceState, [
      'graph-read',
      childGraphId,
      ...graphScope,
      '--limit',
      '10',
    ]);
    assert.equal(originalChildRead.code, 0);
    assert.equal(originalChildRead.body['revision_set_id'], revisionSetId);
    assert.equal(
      canonical(originalChildRead.body['records']),
      canonical([...childGraph.nodes, ...childGraph.assertions]),
    );
    const originalChildProjection = await archive(sourceState, [
      'graph-projection',
      childGraphId,
      ...graphScope,
    ]);
    assert.equal(originalChildProjection.code, 0);
    const childProjectionPath = join(f.base, 'derived-child-projection.json');
    await writeFile(
      childProjectionPath,
      canonical(originalChildProjection.body['projection']),
    );
    const originalChildCheck = await archive(sourceState, [
      'graph-check',
      childGraphId,
      ...graphScope,
      childProjectionPath,
    ]);
    assert.equal(originalChildCheck.body['status'], 'verified');
    assert.equal(originalChildCheck.body['native_proof'], false);
    assert.deepEqual(await counts(sourceState), [1, 1, 2, 3, 1]);

    const archivePackage = join(f.base, 'archive-package.json');
    const exportedArchive = await archive(sourceState, [
      'export',
      '--snapshots',
      snapshot,
      archivePackage,
    ]);
    assert.equal(exportedArchive.code, 0);
    assert.equal(
      exportedArchive.body['sha256'],
      hash(await readFile(archivePackage)),
    );
    const exportedGraph = await archive(sourceState, [
      'graph-export-okf',
      graphId,
      ...graphScope,
    ]);
    assert.equal(exportedGraph.code, 0);
    assert.equal(exportedGraph.body['graph_id'], graphId);
    assert.equal(exportedGraph.body['revision_set_id'], revisionSetId);
    assert.equal(canonical(exportedGraph.body['graph']), canonical(graph));
    assert.deepEqual(exportedGraph.body['omissions'], [
      'original-source-bytes',
      'access-grants',
      'native-provider-proof',
    ]);
    const files = exportedGraph.body['files'] as Record<string, string>;
    const fileHashes = exportedGraph.body['file_sha256'] as Record<
      string,
      string
    >;
    assert.deepEqual(
      Object.keys(files).sort(),
      Object.values(ids)
        .map((id) => `${id}.md`)
        .sort(),
    );
    for (const [path, content] of Object.entries(files))
      assert.equal(fileHashes[path], hash(content));
    const okfPackage = join(f.base, 'root-graph.okf.json');
    await writeFile(okfPackage, canonical(exportedGraph.body));
    assert.notEqual(archivePackage, okfPackage);
    const exportedChild = await archive(sourceState, [
      'graph-export-okf',
      childGraphId,
      ...graphScope,
    ]);
    assert.equal(exportedChild.code, 0);
    assert.equal(exportedChild.body['graph_id'], childGraphId);
    assert.equal(exportedChild.body['revision_set_id'], revisionSetId);
    assert.equal(canonical(exportedChild.body['graph']), canonical(childGraph));
    assert.deepEqual(
      Object.keys(exportedChild.body['files'] as object).sort(),
      Object.keys(files).sort(),
    );
    const childOkfPackage = join(f.base, 'child-graph.okf.json');
    await writeFile(childOkfPackage, canonical(exportedChild.body));
    assert.notEqual(childOkfPackage, okfPackage);

    const packagePaths = [childOkfPackage, okfPackage];
    const planned = await planArchiveRecoveryDependencies({
      archivePackagePath: archivePackage,
      graphPackagePaths: packagePaths,
    });
    assert.equal(planned.schema, 2);
    assert.equal(planned.status, 'dependency-closed');
    assert.equal(planned.payloadIntegrity, 'internal-hashes-verified');
    assert.equal(planned.profile, 'not-validated');
    assert.equal(planned.admission, 'not-checked');
    assert.equal(planned.atomicity, 'none');
    assert.deepEqual(planned.archive.selections, [
      { sourceId: f.source.id, generation, manifestSha256: manifest },
    ]);
    assert.equal(planned.archive.sha256, hash(await readFile(archivePackage)));
    assert.equal(
      planned.archive.bytes,
      (await readFile(archivePackage)).length,
    );
    assert.deepEqual(
      planned.graphs.map((entry) => [entry.graphId, entry.parentGraphId]),
      [
        [graphId, null],
        [childGraphId, graphId],
      ],
    );
    const expectedHashes = await Promise.all(
      [archivePackage, okfPackage, childOkfPackage].map(async (path) =>
        hash(await readFile(path)),
      ),
    );
    assert.deepEqual(planned.importOrder, [
      { kind: 'archive', sha256: expectedHashes[0] },
      { kind: 'graph', sha256: expectedHashes[1] },
      { kind: 'graph', sha256: expectedHashes[2] },
    ]);
    for (const [index, path] of [okfPackage, childOkfPackage].entries()) {
      const raw = await readFile(path);
      assert.equal(planned.graphs[index].sha256, hash(raw));
      assert.equal(planned.graphs[index].bytes, raw.length);
    }
    const plannedPaths = new Map(
      expectedHashes.map((sha256, index) => [
        sha256,
        [archivePackage, okfPackage, childOkfPackage][index],
      ]),
    );
    const planText = canonical(planned);
    for (const privateValue of [f.base, 'synthetic signal', 'Synthetic signal'])
      assert(!planText.includes(privateValue));
    const rechecked = await recheckArchiveRecoveryDependencies(
      { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
      planned,
    );
    assert.equal(rechecked.status, 'unchanged-at-check');
    assert.equal(rechecked.planSha256, hash(canonical(planned)));
    assert.deepEqual(rechecked.importOrder, planned.importOrder);
    assert.deepEqual(
      await recheckArchiveRecoveryDependencies(
        {
          archivePackagePath: archivePackage,
          graphPackagePaths: [okfPackage, childOkfPackage],
        },
        planned,
      ),
      rechecked,
      'Shuffled graph path input must reproduce the same normalized receipt',
    );
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        { ...planned, schema: 1 },
      ),
      /Invalid trusted recovery receipt version or claim/,
    );
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        { ...planned, untrustedExtra: true },
      ),
      /Invalid trusted recovery receipt shape/,
    );
    assert.deepEqual(await counts(restoredState), [0, 0, 0, 0, 0]);

    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: join(f.base, 'missing-archive.json'),
        graphPackagePaths: packagePaths,
      }),
      /Recovery package is unreadable/,
    );
    const badArchivePin = JSON.parse(
      await readFile(archivePackage, 'utf8'),
    ) as {
      generations: Array<{ manifest_sha256: string; manifest: object }>;
    };
    badArchivePin.generations[0].manifest_sha256 = 'f'.repeat(64);
    const badArchivePinPath = join(f.base, 'bad-archive-pin.json');
    await writeFile(badArchivePinPath, canonical(badArchivePin));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: badArchivePinPath,
        graphPackagePaths: packagePaths,
      }),
      /manifest declaration pin mismatch/,
    );
    const duplicateArchive = JSON.parse(
      await readFile(archivePackage, 'utf8'),
    ) as {
      generations: Array<{
        manifest_sha256: string;
        manifest: Record<string, unknown>;
      }>;
    };
    const duplicateManifest = {
      ...duplicateArchive.generations[0].manifest,
      request_key: 'same-generation-different-envelope',
    };
    duplicateArchive.generations.push({
      manifest_sha256: hash(canonical(duplicateManifest)),
      manifest: duplicateManifest,
    });
    const duplicateArchivePath = join(
      f.base,
      'duplicate-archive-generation.json',
    );
    await writeFile(duplicateArchivePath, canonical(duplicateArchive));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: duplicateArchivePath,
        graphPackagePaths: packagePaths,
      }),
      /Duplicate archive generation/,
    );
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [childOkfPackage],
      }),
      /exactly one root/,
    );
    const mismatched = structuredClone(exportedChild.body) as {
      graph: {
        revision_set: { selections: Array<{ manifest_sha256: string }> };
      };
      graph_id: string;
      revision_set_id: string;
    };
    mismatched.graph.revision_set.selections[0].manifest_sha256 = 'f'.repeat(
      64,
    );
    mismatched.revision_set_id = hash(canonical(mismatched.graph.revision_set));
    mismatched.graph_id = hash(canonical(mismatched.graph));
    const mismatchedPath = join(f.base, 'mismatched-child.okf.json');
    await writeFile(mismatchedPath, canonical(mismatched));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, mismatchedPath],
      }),
      /outside included archive declarations/,
    );
    const missingSecond = structuredClone(exportedChild.body) as {
      graph: {
        revision_set: {
          selections: Array<{
            source_id: string;
            generation: string;
            manifest_sha256: string;
          }>;
        };
      };
      graph_id: string;
      revision_set_id: string;
    };
    missingSecond.graph.revision_set.selections.push({
      source_id: '4'.repeat(32),
      generation: '5'.repeat(32),
      manifest_sha256: '6'.repeat(64),
    });
    missingSecond.revision_set_id = hash(
      canonical(missingSecond.graph.revision_set),
    );
    missingSecond.graph_id = hash(canonical(missingSecond.graph));
    const missingSecondPath = join(f.base, 'missing-second-selector.okf.json');
    await writeFile(missingSecondPath, canonical(missingSecond));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, missingSecondPath],
      }),
      /outside included archive declarations/,
    );
    const orphan = structuredClone(exportedChild.body) as {
      graph: { parent: string | null };
      graph_id: string;
    };
    orphan.graph.parent = 'e'.repeat(64);
    orphan.graph_id = hash(canonical(orphan.graph));
    const orphanPath = join(f.base, 'orphan-child.okf.json');
    await writeFile(orphanPath, canonical(orphan));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, orphanPath],
      }),
      /Orphan graph parent/,
    );
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, okfPackage],
      }),
      /Duplicate graph ID/,
    );
    const cycleA = structuredClone(exportedChild.body) as {
      graph: { parent: string | null };
      graph_id: string;
    };
    const cycleB = structuredClone(cycleA);
    cycleA.graph_id = 'a'.repeat(64);
    cycleB.graph_id = 'b'.repeat(64);
    cycleA.graph.parent = cycleB.graph_id;
    cycleB.graph.parent = cycleA.graph_id;
    const cycleAPath = join(f.base, 'cycle-a.okf.json');
    const cycleBPath = join(f.base, 'cycle-b.okf.json');
    await writeFile(cycleAPath, canonical(cycleA));
    await writeFile(cycleBPath, canonical(cycleB));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, cycleBPath, cycleAPath],
      }),
      /Cyclic graph parent/,
    );
    const largePath = join(f.base, 'oversized-child.okf.json');
    await writeFile(largePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, largePath],
      }),
      /bounded regular file/,
    );
    const largeArchivePath = join(f.base, 'oversized-archive.json');
    await writeFile(largeArchivePath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: largeArchivePath,
        graphPackagePaths: packagePaths,
      }),
      /bounded regular file/,
    );
    const symlinkPath = join(f.base, 'linked-child.okf.json');
    await symlink(childOkfPackage, symlinkPath);
    await assert.rejects(
      planArchiveRecoveryDependencies({
        archivePackagePath: archivePackage,
        graphPackagePaths: [okfPackage, symlinkPath],
      }),
      /Recovery package is unreadable/,
    );
    async function refuseInternalHashes(
      archivePath: string,
      graphPaths: string[],
      reason: RegExp,
    ) {
      await assert.rejects(
        planArchiveRecoveryDependencies({
          archivePackagePath: archivePath,
          graphPackagePaths: graphPaths,
        }),
        reason,
      );
      assert.deepEqual(await counts(restoredState), [0, 0, 0, 0, 0]);
    }
    const archivePayload = JSON.parse(
      await readFile(archivePackage, 'utf8'),
    ) as {
      blobs: Record<string, string>;
      generations: Array<{
        manifest_sha256: string;
        manifest: { documents: Array<{ original: { bytes: number } }> };
      }>;
    };
    const blobKey = Object.keys(archivePayload.blobs)[0];
    assert(blobKey);
    async function archiveVariant(
      name: string,
      mutate: (payload: typeof archivePayload) => void,
    ) {
      const payload = structuredClone(archivePayload);
      mutate(payload);
      const path = join(f.base, name);
      await writeFile(path, canonical(payload));
      return path;
    }
    const changedBlob = await archiveVariant('changed-blob.json', (payload) => {
      payload.blobs[blobKey] = Buffer.from('forged-blob').toString('base64');
    });
    await refuseInternalHashes(
      changedBlob,
      packagePaths,
      /archive blob hash mismatch/i,
    );
    const malformedBase64 = await archiveVariant(
      'malformed-base64.json',
      (payload) => {
        payload.blobs[blobKey] = '@@@';
      },
    );
    await refuseInternalHashes(
      malformedBase64,
      packagePaths,
      /archive blob base64/i,
    );
    const missingBlob = await archiveVariant('missing-blob.json', (payload) => {
      delete payload.blobs[blobKey];
    });
    await refuseInternalHashes(
      missingBlob,
      packagePaths,
      /archive descriptor blob missing/i,
    );
    const extraBlob = await archiveVariant('extra-blob.json', (payload) => {
      payload.blobs[hash('unreferenced')] =
        Buffer.from('unreferenced').toString('base64');
    });
    await refuseInternalHashes(
      extraBlob,
      packagePaths,
      /unreferenced archive blob/i,
    );
    const wrongDescriptorSize = await archiveVariant(
      'wrong-descriptor-size.json',
      (payload) => {
        payload.generations[0].manifest.documents[0].original.bytes += 1;
        payload.generations[0].manifest_sha256 = hash(
          canonical(payload.generations[0].manifest),
        );
      },
    );
    await refuseInternalHashes(
      wrongDescriptorSize,
      packagePaths,
      /archive descriptor length mismatch/i,
    );
    const changedOkf = structuredClone(exportedChild.body) as {
      files: Record<string, string>;
      file_sha256: Record<string, string>;
    };
    const okfKey = `${ids.link}.md`;
    changedOkf.files[okfKey] += '\nforged child';
    const changedOkfPath = join(f.base, 'changed-okf-body.json');
    await writeFile(changedOkfPath, canonical(changedOkf));
    await refuseInternalHashes(
      archivePackage,
      [okfPackage, changedOkfPath],
      /OKF file hash mismatch/,
    );
    const wrongOkfHash = structuredClone(
      exportedChild.body,
    ) as typeof changedOkf;
    wrongOkfHash.file_sha256[okfKey] = 'f'.repeat(64);
    const wrongOkfHashPath = join(f.base, 'changed-okf-hash.json');
    await writeFile(wrongOkfHashPath, canonical(wrongOkfHash));
    await refuseInternalHashes(
      archivePackage,
      [okfPackage, wrongOkfHashPath],
      /OKF file hash mismatch/,
    );
    const missingOkfHash = structuredClone(
      exportedChild.body,
    ) as typeof changedOkf;
    delete missingOkfHash.file_sha256[okfKey];
    const missingOkfHashPath = join(f.base, 'missing-okf-hash.json');
    await writeFile(missingOkfHashPath, canonical(missingOkfHash));
    await refuseInternalHashes(
      archivePackage,
      [okfPackage, missingOkfHashPath],
      /OKF file hash keyset mismatch/,
    );
    const extraOkfHash = structuredClone(
      exportedChild.body,
    ) as typeof changedOkf;
    extraOkfHash.file_sha256['extra.md'] = hash('unused');
    const extraOkfHashPath = join(f.base, 'extra-okf-hash.json');
    await writeFile(extraOkfHashPath, canonical(extraOkfHash));
    await refuseInternalHashes(
      archivePackage,
      [okfPackage, extraOkfHashPath],
      /OKF file hash keyset mismatch/,
    );
    const originalArchiveBytes = await readFile(archivePackage);
    const originalChildBytes = await readFile(childOkfPackage);
    const sameArchivePayload = JSON.parse(
      originalArchiveBytes.toString('utf8'),
    );
    await writeFile(
      archivePackage,
      JSON.stringify(sameArchivePayload, null, 2),
    );
    assert.equal(
      (
        await planArchiveRecoveryDependencies({
          archivePackagePath: archivePackage,
          graphPackagePaths: packagePaths,
        })
      ).status,
      'dependency-closed',
    );
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        planned,
      ),
      /Recovery packages changed since trusted plan/,
    );
    await writeFile(archivePackage, originalArchiveBytes);
    await writeFile(
      childOkfPackage,
      JSON.stringify(exportedChild.body, null, 2),
    );
    assert.equal(
      (
        await planArchiveRecoveryDependencies({
          archivePackagePath: archivePackage,
          graphPackagePaths: packagePaths,
        })
      ).status,
      'dependency-closed',
    );
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        planned,
      ),
      /Recovery packages changed since trusted plan/,
    );
    await writeFile(childOkfPackage, originalChildBytes);
    const selfConsistentChild = structuredClone(changedOkf);
    selfConsistentChild.file_sha256[okfKey] = hash(
      selfConsistentChild.files[okfKey],
    );
    await writeFile(childOkfPackage, canonical(selfConsistentChild));
    assert.equal(
      (
        await planArchiveRecoveryDependencies({
          archivePackagePath: archivePackage,
          graphPackagePaths: packagePaths,
        })
      ).status,
      'dependency-closed',
    );
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        planned,
      ),
      /Recovery packages changed since trusted plan/,
    );
    await writeFile(childOkfPackage, originalChildBytes);
    await rm(childOkfPackage);
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        planned,
      ),
      /Recovery package is unreadable/,
    );
    await symlink(okfPackage, childOkfPackage);
    await assert.rejects(
      recheckArchiveRecoveryDependencies(
        { archivePackagePath: archivePackage, graphPackagePaths: packagePaths },
        planned,
      ),
      /Recovery package is unreadable/,
    );
    await rm(childOkfPackage);
    await writeFile(childOkfPackage, originalChildBytes);
    assert.equal(
      (
        await recheckArchiveRecoveryDependencies(
          {
            archivePackagePath: archivePackage,
            graphPackagePaths: packagePaths,
          },
          planned,
        )
      ).status,
      'unchanged-at-check',
    );
    assert.deepEqual(
      await counts(restoredState),
      [0, 0, 0, 0, 0],
      'Planning and every refusal must leave destination state unchanged',
    );

    await refused(
      restoredState,
      ['graph-import-okf', okfPackage],
      /unknown archive generation|unknown graph or RevisionSet/,
    );
    assert.deepEqual(
      await counts(restoredState),
      [0, 0, 0, 0, 0],
      'Wrong-order graph import must not publish an invalid graph',
    );
    const importedArchive = await archive(restoredState, [
      'import',
      plannedPaths.get(planned.importOrder[0].sha256)!,
    ]);
    assert.equal(importedArchive.code, 0);
    assert.equal(importedArchive.body['imported_generations'], 1);
    assert.deepEqual(await counts(restoredState), [1, 0, 0, 0, 0]);
    await refused(
      restoredState,
      ['graph-import-okf', childOkfPackage],
      /unknown graph or RevisionSet/,
    );
    assert.deepEqual(
      await counts(restoredState),
      [1, 0, 0, 0, 0],
      'Child before root must not publish a graph or retirement row',
    );
    const importedGraph = await archive(restoredState, [
      'graph-import-okf',
      plannedPaths.get(planned.importOrder[1].sha256)!,
    ]);
    assert.equal(importedGraph.code, 0);
    assert.equal(importedGraph.body['graph_id'], graphId);
    assert.equal(importedGraph.body['revision_set_id'], revisionSetId);
    assert.deepEqual(await counts(restoredState), [1, 1, 1, 3, 0]);
    const importedChild = await archive(restoredState, [
      'graph-import-okf',
      plannedPaths.get(planned.importOrder[2].sha256)!,
    ]);
    assert.equal(importedChild.code, 0);
    assert.equal(importedChild.body['graph_id'], childGraphId);
    assert.equal(importedChild.body['revision_set_id'], revisionSetId);
    assert.deepEqual(await counts(restoredState), [1, 1, 2, 3, 1]);
    assert.equal(
      canonical(await graphLedger(restoredState)),
      canonical(await graphLedger(sourceState)),
      'RevisionSet, both graph generations, record identities and retirement must match',
    );
    const restoredChildOkf = await archive(restoredState, [
      'graph-export-okf',
      childGraphId,
      ...graphScope,
    ]);
    assert.equal(restoredChildOkf.code, 0);
    assert.equal(
      canonical(restoredChildOkf.body),
      canonical(exportedChild.body),
      'Child OKF must preserve exact parent pointer and lifecycle',
    );
    const replayedRoot = await archive(restoredState, [
      'graph-import-okf',
      okfPackage,
    ]);
    assert.equal(replayedRoot.code, 0);
    assert.equal(replayedRoot.body['graph_id'], graphId);
    assert.deepEqual(await counts(restoredState), [1, 1, 2, 3, 1]);
    const ledgerAfterRootReplay = await graphLedger(restoredState);
    assert.equal(
      canonical(ledgerAfterRootReplay),
      canonical(await graphLedger(sourceState)),
      'Reimporting an immutable root may not erase a child retirement',
    );
    const resurrectionBatch = join(f.base, 'resurrection.json');
    await writeFile(
      resurrectionBatch,
      canonical({
        ...graph,
        parent: graphId,
        nodes: graph.nodes.map((node) =>
          node.id === ids.a ? { ...node, label: 'new root child label' } : node,
        ),
      }),
    );
    await refused(
      restoredState,
      ['graph-publish', resurrectionBatch],
      /retracted assertion ID cannot reactivate/,
    );
    assert.equal(
      canonical(await graphLedger(restoredState)),
      canonical(ledgerAfterRootReplay),
      'Resurrection refusal must not publish any graph state',
    );
    const inspected = await archive(restoredState, [
      'inspect',
      f.source.id,
      generation,
      '--manifest-sha256',
      manifest,
    ]);
    assert.equal(inspected.code, 0);
    assert.equal(inspected.body['integrity'], 'verified');
    assert.equal(inspected.body['manifest_sha256'], manifest);
    const inspectedDocuments = inspected.body['documents'] as Array<{
      path: string;
      original: { sha256: string; bytes: number };
    }>;
    assert.equal(inspectedDocuments.length, 2);
    for (const document of inspectedDocuments) {
      const expected = originals[document.path as keyof typeof originals];
      assert(expected);
      assert.deepEqual(document.original, {
        sha256: hash(expected),
        bytes: expected.length,
      });
    }
    const restoredSources = (await command(restoredState, 'sources', ['list']))
      .body['sources'];
    assert.equal(
      canonical(restoredSources),
      canonical(initialSources),
      'Paired import must not change pre-provisioned source policy',
    );

    await writeFile(
      join(f.base, 'sources/evidence.md'),
      'Live edited original.',
    );
    await rm(join(f.base, 'sources/removed.txt'));
    const restoredRead = await archive(restoredState, [
      'graph-read',
      graphId,
      ...graphScope,
      '--limit',
      '10',
    ]);
    assert.equal(restoredRead.code, 0);
    assert.equal(
      canonical(restoredRead.body),
      canonical(originalRead.body),
      'Imported graph IDs, records, anchors and RevisionSet must match exactly',
    );
    const restoredProjection = await archive(restoredState, [
      'graph-projection',
      graphId,
      ...graphScope,
    ]);
    assert.equal(restoredProjection.code, 0);
    assert.equal(
      canonical(restoredProjection.body),
      canonical(originalProjection.body),
    );
    const restoredCheck = await archive(restoredState, [
      'graph-check',
      graphId,
      ...graphScope,
      projectionPath,
    ]);
    assert.equal(restoredCheck.body['status'], 'verified');
    assert.equal(restoredCheck.body['native_proof'], false);
    const restoredChildRead = await archive(restoredState, [
      'graph-read',
      childGraphId,
      ...graphScope,
      '--limit',
      '10',
    ]);
    assert.equal(restoredChildRead.code, 0);
    assert.equal(
      canonical(restoredChildRead.body),
      canonical(originalChildRead.body),
      'Retracted child must remain an exact historical pinned graph',
    );
    const restoredChildProjection = await archive(restoredState, [
      'graph-projection',
      childGraphId,
      ...graphScope,
    ]);
    assert.equal(restoredChildProjection.code, 0);
    assert.equal(
      canonical(restoredChildProjection.body),
      canonical(originalChildProjection.body),
    );
    const restoredChildCheck = await archive(restoredState, [
      'graph-check',
      childGraphId,
      ...graphScope,
      childProjectionPath,
    ]);
    assert.equal(restoredChildCheck.body['status'], 'verified');
    assert.equal(restoredChildCheck.body['native_proof'], false);
    for (const [path, bytes] of Object.entries(originals)) {
      const before = await archive(sourceState, readArgs(path));
      const after = await archive(restoredState, readArgs(path));
      assert.equal(before.code, 0);
      assert.equal(after.code, 0);
      assert.equal(canonical(after.body), canonical(before.body));
      assert.equal(after.body['integrity'], 'verified');
      assert.equal(after.body['current_original'], 'not-checked');
      const representation = after.body['representation'] as {
        sha256: string;
        original_sha256: string;
      };
      assert.equal(representation.original_sha256, hash(bytes));
      const record = after.body['record'] as {
        body: string;
        citations: Array<{
          source_id: string;
          path: string;
          original_sha256: string;
          representation_sha256: string;
          quote: string;
        }>;
      };
      assert.equal(record.body, bytes.toString('utf8'));
      assert.equal(record.citations.length, 1);
      assert.equal(record.citations[0].source_id, f.source.id);
      assert.equal(record.citations[0].path, path);
      assert.equal(record.citations[0].original_sha256, hash(bytes));
      assert.equal(
        record.citations[0].representation_sha256,
        representation.sha256,
      );
      assert.equal(record.citations[0].quote, record.body);
      const destination = join(f.base, `recovered-${path}`);
      const recovered = await archive(restoredState, [
        'recover',
        f.source.id,
        generation,
        path,
        destination,
      ]);
      assert.equal(recovered.code, 0);
      assert.equal(recovered.body['sha256'], hash(bytes));
      assert.deepEqual(await readFile(destination), bytes);
    }

    await refused(
      archiveTamperState,
      ['import', changedBlob],
      /blob integrity mismatch/,
    );
    assert.deepEqual(await counts(archiveTamperState), [0, 0, 0, 0, 0]);

    assert.equal(
      (await archive(okfTamperState, ['import', archivePackage])).body[
        'imported_generations'
      ],
      1,
    );
    const tamperedOkf = JSON.parse(await readFile(okfPackage, 'utf8'));
    tamperedOkf.files[`${ids.a}.md`] += '\nforged content';
    const badOkfPackage = join(f.base, 'tampered-root-graph.okf.json');
    await writeFile(badOkfPackage, canonical(tamperedOkf));
    await refused(
      okfTamperState,
      ['graph-import-okf', badOkfPackage],
      /OKF profile mismatch/,
    );
    assert.deepEqual(await counts(okfTamperState), [1, 0, 0, 0, 0]);

    assert.equal(
      (await archive(childTamperState, ['import', archivePackage])).body[
        'imported_generations'
      ],
      1,
    );
    assert.equal(
      (await archive(childTamperState, ['graph-import-okf', okfPackage])).body[
        'graph_id'
      ],
      graphId,
    );
    const matchingChild = structuredClone(changedOkf);
    matchingChild.file_sha256[okfKey] = hash(matchingChild.files[okfKey]);
    const matchingChildPath = join(f.base, 'matching-child-hashes.okf.json');
    await writeFile(matchingChildPath, canonical(matchingChild));
    const tamperedPlan = await planArchiveRecoveryDependencies({
      archivePackagePath: archivePackage,
      graphPackagePaths: [matchingChildPath, okfPackage],
    });
    assert.equal(tamperedPlan.status, 'dependency-closed');
    assert.equal(tamperedPlan.payloadIntegrity, 'internal-hashes-verified');
    assert.equal(tamperedPlan.profile, 'not-validated');
    assert.equal(
      tamperedPlan.graphs[1].sha256,
      hash(await readFile(matchingChildPath)),
    );
    await refused(
      childTamperState,
      ['graph-import-okf', matchingChildPath],
      /OKF profile mismatch/,
    );
    assert.deepEqual(await counts(childTamperState), [1, 1, 1, 3, 0]);

    assert.equal(
      (await archive(disabledState, ['import', archivePackage])).body[
        'imported_generations'
      ],
      1,
    );
    const disabled = await command(disabledState, 'sources', [
      'disable',
      f.source.id,
    ]);
    assert.equal(disabled.body['enabled'], false);
    await refused(
      disabledState,
      ['graph-import-okf', okfPackage],
      /source is disabled/,
    );
    assert.deepEqual(await counts(disabledState), [1, 0, 0, 0, 0]);
    assert.equal(
      (await archive(childDisabledState, ['import', archivePackage])).body[
        'imported_generations'
      ],
      1,
    );
    assert.equal(
      (await archive(childDisabledState, ['graph-import-okf', okfPackage]))
        .body['graph_id'],
      graphId,
    );
    const childDisabled = await command(childDisabledState, 'sources', [
      'disable',
      f.source.id,
    ]);
    assert.equal(childDisabled.body['enabled'], false);
    await refused(
      childDisabledState,
      ['graph-import-okf', childOkfPackage],
      /source is disabled/,
    );
    assert.deepEqual(await counts(childDisabledState), [1, 1, 1, 3, 0]);
    const restoredDisabled = await command(restoredState, 'sources', [
      'disable',
      f.source.id,
    ]);
    assert.equal(restoredDisabled.body['enabled'], false);
    await refused(
      restoredState,
      ['graph-read', graphId, ...graphScope],
      /source is disabled/,
    );
    await refused(
      restoredState,
      ['graph-projection', graphId, ...graphScope],
      /source is disabled/,
    );
    await refused(
      restoredState,
      ['graph-export-okf', graphId, ...graphScope],
      /source is disabled/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
