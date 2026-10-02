import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL Registrar: archive-only export/import restores pinned bytes under pre-provisioned local-only access', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'] ?? '';
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'] ?? '';
  assert(python && registrarSource);
  const original = Buffer.from(
    'Recovery signal café 😀\r\nCitation remains archived.\n',
  );
  const deleted = Buffer.from('Second archived original survives deletion.\n');
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      { path: 'evidence.md', bytes: original },
      { path: 'removed.txt', bytes: deleted },
    ],
  });
  const sourceState = join(f.base, 'state');
  const restoredState = join(f.base, 'restored-state');
  const tamperState = join(f.base, 'tamper-state');
  const wrongOriginState = join(f.base, 'wrong-origin-state');
  const disabledState = join(f.base, 'disabled-state');
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
  ): Promise<{ code: number; body: Record<string, unknown> }> {
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
      return { code: 0, body: JSON.parse(result.stdout) };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      assert.equal(failure.code, 2);
      return { code: 2, body: JSON.parse(failure.stdout) };
    }
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
  async function generationCount(workspace: string): Promise<number> {
    const { stdout } = await exec(
      python,
      [
        '-B',
        '-c',
        "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT COUNT(*) FROM archive_generations').fetchone()[0])",
        join(workspace, 'registry.sqlite3'),
      ],
      { env: environment, timeout: 60000 },
    );
    return Number(stdout.trim());
  }
  async function refused(
    workspace: string,
    args: string[],
    reason: RegExp,
  ): Promise<void> {
    const result = await command(workspace, 'archive', args);
    assert.equal(result.code, 2, JSON.stringify(result.body));
    assert.equal(result.body['status'], 'invalid');
    assert.match(String(result.body['error']), reason);
  }

  const sharing = await command(sourceState, 'sources', [
    'set-sharing',
    f.source.id,
    'local-only',
  ]);
  assert.equal(sharing.code, 0);
  assert.equal(sharing.body['sharing'], 'local-only');
  const initialSources = await command(sourceState, 'sources', ['list']);
  assert.equal(initialSources.code, 0);
  assert.equal((initialSources.body['sources'] as unknown[]).length, 1);
  await Promise.all([
    backup(restoredState),
    backup(tamperState),
    backup(wrongOriginState),
    backup(disabledState),
  ]);
  for (const workspace of [
    restoredState,
    tamperState,
    wrongOriginState,
    disabledState,
  ]) {
    assert.equal(await generationCount(workspace), 0);
    const registered = await command(workspace, 'sources', ['list']);
    assert.equal(
      canonical(registered.body['sources']),
      canonical(initialSources.body['sources']),
      'Destination registration must be provisioned before capture',
    );
  }

  const captured = await command(sourceState, 'archive', [
    'capture',
    f.source.id,
    '--request-key',
    'recovery-proof-v1',
  ]);
  assert.equal(captured.code, 0);
  assert.equal(captured.body['status'], 'complete');
  assert.equal(captured.body['preservation'], 'complete-admitted');
  const generation = String(captured.body['generation']);
  const manifest = String(captured.body['manifest_sha256']);
  assert.match(generation, /^[a-f0-9]{32}$/);
  assert.match(manifest, /^[a-f0-9]{64}$/);
  const bundlePath = join(f.base, 'archive-bundle.json');
  const snapshots = JSON.stringify({ [f.source.id]: generation });
  const exported = await command(sourceState, 'archive', [
    'export',
    '--snapshots',
    snapshots,
    bundlePath,
  ]);
  assert.equal(exported.code, 0);
  assert.equal(exported.body['status'], 'complete');
  assert.equal(exported.body['sha256'], hash(await readFile(bundlePath)));

  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  const blobKey = Object.keys(bundle.blobs)[0];
  assert(blobKey);
  bundle.blobs[blobKey] = Buffer.from('forged-blob').toString('base64');
  const tamperedBundle = join(f.base, 'tampered-bundle.json');
  await writeFile(tamperedBundle, canonical(bundle));
  await refused(
    tamperState,
    ['import', tamperedBundle],
    /blob integrity mismatch/,
  );
  assert.equal(await generationCount(tamperState), 0);

  const wrongRoot = join(f.base, 'different-origin');
  await mkdir(wrongRoot);
  await exec(
    python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['root']=sys.argv[3]; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(wrongOriginState, 'registry.sqlite3'),
      f.source.id,
      wrongRoot,
    ],
    { env: environment, timeout: 60000 },
  );
  await refused(
    wrongOriginState,
    ['import', bundlePath],
    /origin binding mismatch/,
  );
  assert.equal(await generationCount(wrongOriginState), 0);

  const imported = await command(restoredState, 'archive', [
    'import',
    bundlePath,
  ]);
  assert.equal(imported.code, 0);
  assert.equal(imported.body['status'], 'complete');
  assert.equal(imported.body['imported_generations'], 1);
  assert.equal(imported.body['access_settings'], 'preserved');
  const listed = await command(restoredState, 'sources', ['list']);
  assert.equal(listed.code, 0);
  const sourceRows = listed.body['sources'] as {
    id: string;
    root: string;
    sharing: string;
  }[];
  assert.equal(sourceRows.length, 1);
  assert.equal(sourceRows[0].id, f.source.id);
  assert.equal(sourceRows[0].root, join(f.base, 'sources'));
  assert.equal(sourceRows[0].sharing, 'local-only');
  assert.equal(
    canonical(sourceRows),
    canonical(initialSources.body['sources']),
    'Import changed destination access settings',
  );
  const inspected = await command(restoredState, 'archive', [
    'inspect',
    f.source.id,
    generation,
    '--manifest-sha256',
    manifest,
  ]);
  assert.equal(inspected.code, 0);
  assert.equal(inspected.body['generation'], generation);
  assert.equal(inspected.body['manifest_sha256'], manifest);
  assert.equal(inspected.body['integrity'], 'verified');

  await writeFile(join(f.base, 'sources/evidence.md'), 'live original changed');
  await rm(join(f.base, 'sources/removed.txt'));
  for (const [path, bytes] of [
    ['evidence.md', original],
    ['removed.txt', deleted],
  ] as const) {
    const args = [
      'read',
      f.source.id,
      generation,
      path,
      '--manifest-sha256',
      manifest,
    ];
    const before = await command(sourceState, 'archive', args);
    const after = await command(restoredState, 'archive', args);
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
    assert.match(representation.sha256, /^[a-f0-9]{64}$/);
    const record = after.body['record'] as {
      body: string;
      citations: {
        source_id: string;
        path: string;
        original_sha256: string;
        representation_sha256: string;
        quote: string;
      }[];
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
    const recovered = await command(restoredState, 'archive', [
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

  const disabled = await command(disabledState, 'sources', [
    'disable',
    f.source.id,
  ]);
  assert.equal(disabled.code, 0);
  assert.equal(disabled.body['enabled'], false);
  // Import checks registered origin; it does not grant access or restore policy.
  const importedDisabled = await command(disabledState, 'archive', [
    'import',
    bundlePath,
  ]);
  assert.equal(importedDisabled.code, 0);
  assert.equal(importedDisabled.body['imported_generations'], 1);
  const disabledList = await command(disabledState, 'sources', ['list']);
  const disabledRows = disabledList.body['sources'] as {
    enabled: boolean;
    sharing: string;
  }[];
  assert.equal(disabledRows[0].enabled, false);
  assert.equal(disabledRows[0].sharing, 'local-only');
  await refused(
    disabledState,
    [
      'read',
      f.source.id,
      generation,
      'evidence.md',
      '--manifest-sha256',
      manifest,
    ],
    /source is disabled/,
  );
  await refused(
    disabledState,
    [
      'recover',
      f.source.id,
      generation,
      'evidence.md',
      join(f.base, 'denied-recovered.md'),
    ],
    /source is disabled/,
  );
  await refused(
    disabledState,
    ['export', '--snapshots', snapshots, join(f.base, 'denied-bundle.json')],
    /source is disabled/,
  );
});
