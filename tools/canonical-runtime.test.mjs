import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  packageCanonicalRuntime,
  checkCanonicalArtifact,
} from './canonical-runtime.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
let buildRoot;
let output;
let manifest;

before(async () => {
  buildRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'temari canonical build-')),
  );
  output = join(buildRoot, 'artifact');
  manifest = await packageCanonicalRuntime(output);
});
after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

async function relocated(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari relocated café-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  await cp(output, artifact, { recursive: true });
  return { root, artifact };
}

async function child(args, options = {}, expectedCode = 0) {
  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...options },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number'))
          reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
  assert.equal(result.code, expectedCode, `${result.stderr}\n${result.stdout}`);
  return result;
}

test('canonical artifact contains only compiled production packages and verifies after relocation', async (t) => {
  const { artifact } = await relocated(t);
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
  assert(manifest.files.length > 4);
  assert(!JSON.stringify(manifest).includes(repository));
  for (const file of manifest.files) {
    assert(
      !/\.test\.|\/demo\/|\/fixtures\/|\.map$|tsbuildinfo/.test(file.path),
      file.path,
    );
    assert(/\.(?:js|d\.ts|json)$/.test(file.path), file.path);
    const text = await readFile(join(artifact, file.path), 'utf8');
    assert(!text.includes(repository), file.path);
    assert(!text.includes('@swc-node/register'), file.path);
  }
  for (const name of [
    'contracts',
    'temari-core',
    'workflow-engine',
    'runtime',
  ]) {
    const pkg = JSON.parse(
      await readFile(
        join(artifact, 'node_modules', '@temari', name, 'package.json'),
        'utf8',
      ),
    );
    assert.equal(pkg.name, `@temari/${name}`);
    assert.equal(pkg.type, 'module');
    assert(!JSON.stringify(pkg).includes('workspace:'));
    assert(!JSON.stringify(pkg).includes('@org/source'));
  }
});

test('relocated stock Node resumes an acknowledged prefix and verifies bytes with isolated readback', async (t) => {
  const { root, artifact } = await relocated(t);
  const state = join(root, 'state');
  await mkdir(state);
  const consumer = join(root, 'consumer.mjs');
  await copyFile(
    new URL('./fixtures/canonical-consumer.mjs', import.meta.url),
    consumer,
  );
  await writeFile(join(state, 'source.txt'), 'pear\napple\n');
  const runId = randomUUID();
  const revision = 'packaged-pear-apple-fixture-v1';
  await writeFile(
    join(state, 'request.json'),
    JSON.stringify({
      runId,
      revision,
      request: {
        workType: 'feature',
        obligations: { evidence: 'revision-bound' },
        lightweight: {
          resultIsClearLocalAndReversible: true,
          changesSharedBoundary: false,
          isReportedDefect: false,
          hasUnexplainedSymptom: false,
          makesPerformanceClaim: false,
          isDesignChoice: false,
          isMigration: false,
          affectedCallersAreKnown: true,
          crossesArchitecturalBoundary: false,
          directCheckAvailable: true,
        },
      },
    }),
  );
  const blocked = [
    join(repository, 'libs/runtime/src/index.ts'),
    join(repository, 'node_modules/typescript/package.json'),
    join(output, 'canonical-manifest.json'),
  ];
  for (const path of blocked) await access(path);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = (mode, expectedCode = 0) =>
    child(
      [
        // Node permission mode disables fsync; use it for the readback, not writes.
        ...(mode === 'inspect'
          ? [
              '--permission',
              `--allow-fs-read=${artifact}`,
              `--allow-fs-read=${consumer}`,
              `--allow-fs-read=${state}`,
              `--allow-fs-write=${state}`,
            ]
          : []),
        consumer,
        artifact,
        state,
        mode,
        JSON.stringify(blocked),
      ],
      { cwd: root, env },
      expectedCode,
    );
  await run('interrupt', 73);
  const prefix = JSON.parse(
    await readFile(join(state, 'acknowledged-prefix.json'), 'utf8'),
  );
  assert.deepEqual(
    prefix.stages.map((s) => s.stage),
    stages.slice(0, 3),
  );
  assert.equal(prefix.revision, revision);
  await run('resume');
  const { stdout } = await run('inspect');
  const { receipt, checkpoint, artifacts } = JSON.parse(stdout);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.failure, null);
  assert.equal(receipt.startedAt, prefix.startedAt);
  assert.deepEqual(receipt.stages.slice(0, 3), prefix.stages);
  assert.deepEqual(
    receipt.stages.map((s) => s.stage),
    stages,
  );
  assert.deepEqual(checkpoint.stages, receipt.stages);
  assert.deepEqual(
    (await readFile(join(state, 'handlers.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    stages,
  );
  assert.deepEqual(
    artifacts.map((a) => a.stage),
    stages,
  );
  assert.equal(artifacts.at(-1).text, 'APPLE\nPEAR\n');
  assert.equal(
    await readFile(join(state, 'workspaces/deliver/result.txt'), 'utf8'),
    'APPLE\nPEAR\n',
  );
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
});

test('canonical inventory rejects missing and same-size tampered dependency bytes', async (t) => {
  const { artifact } = await relocated(t);
  const dependency = join(
    artifact,
    'node_modules/@temari/contracts/src/index.js',
  );
  const bytes = await readFile(dependency);
  await unlink(dependency);
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /missing|inventory|files/i,
  );
  const altered = Buffer.from(bytes);
  altered[0] = altered[0] === 120 ? 121 : 120;
  await writeFile(dependency, altered);
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /hash|digest|integrity/i,
  );
  await writeFile(dependency, bytes);
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
});

test('canonical inventory rejects unknown files and links', async (t) => {
  const { root, artifact } = await relocated(t);
  const extra = join(artifact, 'unexpected.txt');
  await writeFile(extra, 'not part of the artifact');
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /unknown|unexpected|inventory|files/i,
  );
  await unlink(extra);
  await symlink(root, join(artifact, 'outside-link'), 'junction');
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /link|regular|directory/i,
  );
});

test('canonical inventory rejects escaping paths and rewritten manifests', async (t) => {
  const { artifact } = await relocated(t);
  const path = join(artifact, 'canonical-manifest.json');
  const escaped = structuredClone(manifest);
  escaped.files[0].path = '../outside.txt';
  await writeFile(path, JSON.stringify(escaped));
  await assert.rejects(
    checkCanonicalArtifact(artifact),
    /path|safe|inventory/i,
  );
  const rewritten = structuredClone(manifest);
  const file = rewritten.files.find((entry) =>
    entry.path.endsWith('/contracts/src/index.js'),
  );
  assert(file);
  const bytes = await readFile(join(artifact, file.path));
  bytes[0] = bytes[0] === 120 ? 121 : 120;
  await writeFile(join(artifact, file.path), bytes);
  file.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, JSON.stringify(rewritten));
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /manifest|expected|identity/i,
  );
});

test('packaging refuses to replace an existing destination', async (t) => {
  const { root } = await relocated(t);
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep.txt'), 'original');
  await assert.rejects(
    packageCanonicalRuntime(existing),
    /exist|empty|destination/i,
  );
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'original');
});
