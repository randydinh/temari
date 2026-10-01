import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actualFixture,
  documents,
  inputFor,
  assessFixture,
} from '../support/fixtures.js';
import {
  captureArchive,
  loadArchivePublication,
  rebindArchivePublication,
  ArchivePersistenceError,
  type ArchiveIntakeOptions,
  type ArchiveIntakeOutcome,
} from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { canonical, hash } from './codec.js';
import {
  collectKnowledge,
  loadRetrieval,
  type RetrievalOutcome,
} from './retrieval.js';
import { investigateDesignUpdate, loadInvestigation } from './investigation.js';

const exec = promisify(execFile);
async function fixture() {
  const f = await actualFixture();
  const options: ArchiveIntakeOptions = {
    task: {
      id: 'archive-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root',
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'v1',
  };
  return { ...f, options };
}
async function demo<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  command: string,
  input: unknown,
): Promise<T> {
  const inputPath = join(f.base, `demo-${command}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  return JSON.parse(
    (
      await exec(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          'libs/knowledge/src/demo.ts',
          command,
          '--input',
          inputPath,
        ],
        { cwd: process.cwd(), timeout: 60000, maxBuffer: 1_048_576 },
      )
    ).stdout,
  ) as T;
}
async function captured(useDemo = false) {
  const f = await fixture(),
    result = useDemo
      ? await demo<ArchiveIntakeOutcome>(f, 'capture', f.options)
      : await captureArchive(f.options);
  assert.equal(
    result.status,
    'published',
    await readFile(result.resultPath, 'utf8'),
  );
  assert(result.publicationPath);
  const publication = await loadArchivePublication(result.publicationPath),
    readerConfig = {
      publications: [result.publicationPath],
      readScope: 'source-root' as const,
    };
  return {
    ...f,
    result,
    publication,
    readerConfig,
    provider: await createArchiveRegistrar(readerConfig),
  };
}
async function capturedForRebind() {
  const f = await fixture();
  const registrarSource = join(f.base, 'registrar-runtime');
  await mkdir(registrarSource);
  await cp(
    join(f.config.registrarSource, 'src'),
    join(registrarSource, 'src'),
    {
      recursive: true,
    },
  );
  await cp(
    join(
      f.config.registrarSource,
      'docs/design/source-archive-contract-v1.json',
    ),
    join(registrarSource, 'docs/design/source-archive-contract-v1.json'),
  );
  for (const name of ['pyproject.toml', 'uv.lock'])
    await cp(join(f.config.registrarSource, name), join(registrarSource, name));
  const transport = { ...f.options.transport, registrarSource };
  const result = await captureArchive({ ...f.options, transport });
  assert(result.publicationPath, await readFile(result.resultPath, 'utf8'));
  return {
    ...f,
    transport,
    priorPath: result.publicationPath,
    prior: await loadArchivePublication(result.publicationPath),
  };
}
async function python(
  f: Awaited<ReturnType<typeof fixture>>,
  code: string,
  args: string[] = [],
) {
  return exec(f.config.python, ['-B', '-c', code, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      PYTHONPATH: join(f.config.registrarSource, 'src'),
      PYTHONNOUSERSITE: '1',
    },
    timeout: 60000,
    maxBuffer: 1_048_576,
  });
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const result = await exec(
    f.config.python,
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
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(f.config.registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
      },
      timeout: 60000,
      maxBuffer: 1_048_576,
    },
  );
  return JSON.parse(result.stdout);
}
function readRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  path = 'plan.txt',
) {
  return {
    document: { source: f.source, path },
    expectedSha256: null,
    maxCodePoints: 8000,
    maxBytes: 65536,
    continuation: null,
  };
}

test('ACTUAL ARCHIVE CLI: JSON demo capture, bounded search/read, v2 and fresh-process v1 resume after originals/cache loss', async () => {
  const f = await captured(true);
  const query = {
    scope: [f.source],
    query: 'proposal',
    limit: 1,
    maxBytes: 16000,
    continuation: null,
  };
  const found = await f.provider.discover(query);
  assert(found.ok, JSON.stringify(found));
  assert(found.value.next);
  assert.equal(found.value.coverage.indexed, 4);
  const next = await f.provider.discover({
    ...query,
    continuation: found.value.next,
  });
  assert(next.ok && next.value.coverage.exhausted);
  assert.equal(next.value.coverage.matched, 2);
  const empty = await f.provider.discover({
    ...query,
    query: 'no_such_matching_word',
  });
  assert(empty.ok && empty.value.coverage.matched === 0);
  const search = await demo<RetrievalOutcome>(f, 'archive-collect', {
    task: f.options.task,
    config: f.readerConfig,
    request: {
      scope: [f.source],
      query: 'proposal',
      selections: [],
      limits: {
        evidenceCodePoints: 10000,
        contextCodePoints: 16000,
        stateBytes: 65536,
      },
    },
    budget: {
      calls: 8,
      responseBytes: 100000,
      codePoints: 10000,
      codePointsPerRead: 8000,
      documentsPerPage: 1,
    },
  });
  const searchState = await loadRetrieval(search.checkpointPath);
  assert(search.complete);
  assert.equal(searchState.evidence.length, 0);
  assert.deepEqual(search.contextEvidenceIds, []);
  const input = {
    task: f.options.task,
    config: f.readerConfig,
    request: {
      scope: [f.source],
      query: null,
      selections: [
        {
          document: { source: f.source, path: 'plan.txt' },
          expectedSha256: hash(documents['plan.txt']),
        },
      ],
      limits: {
        evidenceCodePoints: 10000,
        contextCodePoints: 32000,
        stateBytes: 131072,
      },
    },
    budget: {
      calls: 2,
      responseBytes: 65536,
      codePoints: 10000,
      codePointsPerRead: 9,
      documentsPerPage: 1,
    },
  };
  const first = await demo<RetrievalOutcome>(f, 'archive-collect', input);
  assert(!first.complete);
  const checkpoint = await loadRetrieval(first.checkpointPath);
  assert.equal(checkpoint.evidence.length, 1);
  const savedBytes = await readFile(first.checkpointPath);
  await writeFile(join(f.base, 'sources/plan.txt'), 'v2 changed original');
  const replayV1 = await captureArchive(f.options);
  assert.equal(replayV1.publicationPath, f.result.publicationPath);
  assert.equal(
    (await loadArchivePublication(replayV1.publicationPath!)).generation,
    f.publication.generation,
  );
  const v2 = await demo<ArchiveIntakeOutcome>(f, 'capture', {
    ...f.options,
    requestKey: 'v2',
  });
  assert(v2.publicationPath);
  assert.notEqual(
    (await loadArchivePublication(v2.publicationPath)).generation,
    f.publication.generation,
  );
  await rm(join(f.base, 'sources'), { recursive: true });
  await rm(join(f.base, 'state/cache'), { recursive: true, force: true });
  const resumeInput = join(f.base, 'resume-archive.json');
  await writeFile(
    resumeInput,
    JSON.stringify({
      ...input,
      config: f.config && {
        publications: [f.result.publicationPath],
        readScope: 'source-root',
      },
      budget: { ...input.budget, calls: 100 },
    }),
  );
  const resumed = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          'libs/knowledge/src/demo.ts',
          'archive-collect',
          '--input',
          resumeInput,
          '--resume',
          first.checkpointPath,
        ],
        { cwd: process.cwd(), timeout: 60000, maxBuffer: 1_048_576 },
      )
    ).stdout,
  );
  assert(resumed.complete, JSON.stringify(resumed));
  const state = await loadRetrieval(resumed.checkpointPath);
  assert.equal(
    state.evidence.map((e) => e.excerpt).join(''),
    documents['plan.txt'],
  );
  for (const e of state.evidence) {
    assert.equal(e.archive?.generation, f.publication.generation);
    assert.equal(
      e.excerpt,
      Array.from(documents['plan.txt'])
        .slice(e.span.start, e.span.end)
        .join(''),
    );
  }
  assert.match(resumed.context, /not-checked/);
  assert(resumed.context.includes(f.publication.manifestSha256));
  assert(
    state.checks.every(
      (c) => c.basis === 'archive-snapshot' && c.state === 'unchanged',
    ),
  );
  assert.deepEqual(await readFile(first.checkpointPath), savedBytes);
  const check = await f.provider.revalidate(state.evidence[0]);
  assert.equal(check.state, 'unchanged');
  assert.match(check.detail, /current originals were not checked/);
});

test('ACTUAL ARCHIVE CLI: durable pre-capture binding, interrupted publication replay without originals, concurrency and changed bindings', async () => {
  const f = await fixture();
  const key = `temari-archive-v1:${hash(canonical({ task: f.options.task, key: f.options.requestKey }))}`;
  const publicationPath = join(
    f.options.task.directory,
    `archive-publication-${hash(key)}.json`,
  );
  await mkdir(publicationPath); // Fault injection: capture commits, local publication cannot link.
  await assert.rejects(captureArchive(f.options), ArchivePersistenceError);
  const binding = JSON.parse(
    await readFile(
      join(f.options.task.directory, `archive-binding-${hash(key)}.json`),
      'utf8',
    ),
  );
  assert.equal(binding.captureRequestKey, key);
  const generations = await cli(f, ['generations', f.source.id]);
  assert.equal(generations.generations.length, 1);
  const first = generations.generations[0];
  await rm(publicationPath, { recursive: true });
  await rm(join(f.base, 'sources'), { recursive: true });
  const attempts = await Promise.all([
    captureArchive(f.options),
    captureArchive(f.options),
  ]);
  assert(attempts.some((a) => a.status === 'published'));
  for (const a of attempts)
    assert(JSON.parse(await readFile(a.resultPath, 'utf8')).status);
  const intakeInput = join(f.base, 'intake.json');
  await writeFile(intakeInput, JSON.stringify(f.options));
  const replay = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          '--import',
          '@swc-node/register/esm-register',
          'libs/knowledge/src/demo.ts',
          'capture',
          '--input',
          intakeInput,
        ],
        { cwd: process.cwd(), timeout: 60000, maxBuffer: 1_048_576 },
      )
    ).stdout,
  );
  assert.equal(replay.status, 'published');
  const p = await loadArchivePublication(publicationPath);
  assert.equal(p.generation, first.generation);
  assert.equal(
    (await cli(f, ['generations', f.source.id])).generations.length,
    1,
  );
  const changed = await captureArchive({
    ...f.options,
    limits: { entries: 1 },
  });
  assert.equal(changed.status, 'blocked');
  assert((await readFile(changed.resultPath, 'utf8')).includes('collision'));
  const otherTask = { ...f.options.task, id: 'another-task' };
  const blocked = await captureArchive({ ...f.options, task: otherTask });
  assert.equal(blocked.status, 'blocked');
  assert(
    (await readdir(f.options.task.directory)).filter((n) =>
      n.startsWith('archive-attempt-'),
    ).length >= 6,
  );
  assert.deepEqual(
    Object.keys(
      await createArchiveRegistrar({
        publications: [publicationPath],
        readScope: 'source-root',
      }),
    ).sort(),
    ['discover', 'identity', 'read', 'revalidate'],
  );
});

test('ACTUAL ARCHIVE CLI: historical publications refuse changed or missing original capture bindings', async () => {
  const f = await capturedForRebind();
  const originalBytes = await readFile(f.priorPath);
  const bindingPath = join(
    f.prior.task.directory,
    `archive-binding-${f.prior.binding}.json`,
  );
  const bindingBytes = await readFile(bindingPath);
  const alteredPublication = JSON.parse(originalBytes.toString());
  alteredPublication.task.id = 'forged-task';
  await writeFile(f.priorPath, canonical(alteredPublication));
  await assert.rejects(loadArchivePublication(f.priorPath));
  await writeFile(f.priorPath, originalBytes);

  for (
    let version = 2, priorPublicationPath = f.priorPath;
    version <= 3;
    version++
  ) {
    await writeFile(
      join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
      `READER_VERSION = ${version}\n`,
    );
    priorPublicationPath = (
      await rebindArchivePublication({
        priorPublicationPath,
        transport: f.transport,
      })
    ).publicationPath;
    if (version !== 3) continue;

    for (const field of [
      'task',
      'source',
      'readScope',
      'transport',
      'implementation',
      'protocolSha256',
      'registration',
      'captureRequestKey',
    ]) {
      const alteredBinding = JSON.parse(bindingBytes.toString());
      alteredBinding[field] = 'forged';
      await writeFile(bindingPath, canonical(alteredBinding));
      await assert.rejects(
        loadArchivePublication(f.priorPath),
        /Original capture binding .* changed/,
        field,
      );
      await assert.rejects(
        loadArchivePublication(priorPublicationPath),
        /Original capture binding .* changed/,
        field,
      );
    }

    await rm(bindingPath);
    await assert.rejects(loadArchivePublication(f.priorPath));
    await assert.rejects(loadArchivePublication(priorPublicationPath));
    await writeFile(bindingPath, bindingBytes);
    assert.equal(
      (await loadArchivePublication(priorPublicationPath)).generation,
      f.prior.generation,
    );
  }
});

test('ACTUAL ARCHIVE CLI: rebind upgrades a retained generation after runtime change without originals or recapture', async () => {
  const f = await capturedForRebind();
  const priorBytes = await readFile(f.priorPath);
  await rm(join(f.base, 'sources'), { recursive: true });
  await writeFile(
    join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
    'READER_VERSION = 2\n',
  );
  await assert.rejects(
    createArchiveRegistrar({
      publications: [f.priorPath],
      readScope: 'source-root',
    }),
    /Publication implementation changed/,
  );
  const first = await rebindArchivePublication({
    priorPublicationPath: f.priorPath,
    transport: f.transport,
  });
  const publication = await loadArchivePublication(first.publicationPath);
  assert.notEqual(first.publicationPath, f.priorPath);
  assert.equal(publication.generation, f.prior.generation);
  assert.equal(publication.manifestSha256, f.prior.manifestSha256);
  assert.equal(publication.captureFingerprint, f.prior.captureFingerprint);
  assert.notEqual(publication.implementation, f.prior.implementation);
  assert.equal(publication.rebind?.priorPublicationSha256, hash(priorBytes));
  assert.deepEqual(await readFile(f.priorPath), priorBytes);
  const audit = JSON.parse(await readFile(first.auditPath, 'utf8'));
  assert.equal(audit.priorPublicationPath, f.priorPath);
  assert.equal(audit.currentOriginal, 'not-checked');
  const provider = await createArchiveRegistrar({
    publications: [first.publicationPath],
    readScope: 'source-root',
  });
  const read = await provider.read(readRequest(f));
  assert(read.ok, JSON.stringify(read));
  assert.equal(read.value.evidence.excerpt, documents['plan.txt']);
  assert.equal(read.value.evidence.archive?.generation, f.prior.generation);
  const second = await rebindArchivePublication({
    priorPublicationPath: f.priorPath,
    transport: f.transport,
  });
  assert.deepEqual(second, first);
  await writeFile(
    join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
    'READER_VERSION = 3\n',
  );
  await assert.rejects(
    createArchiveRegistrar({
      publications: [first.publicationPath],
      readScope: 'source-root',
    }),
    /Publication implementation changed/,
  );
  const third = await rebindArchivePublication({
    priorPublicationPath: first.publicationPath,
    transport: f.transport,
  });
  assert.notEqual(third.publicationPath, first.publicationPath);
  assert.equal(
    (await loadArchivePublication(third.publicationPath)).rebind
      ?.priorPublicationPath,
    first.publicationPath,
  );
  assert(
    (
      await createArchiveRegistrar({
        publications: [third.publicationPath],
        readScope: 'source-root',
      })
    ).identity,
  );
  const auditBytes = await readFile(first.auditPath);
  await rm(first.auditPath);
  await assert.rejects(
    createArchiveRegistrar({
      publications: [third.publicationPath],
      readScope: 'source-root',
    }),
  );
  await writeFile(first.auditPath, auditBytes);
  const firstBytes = await readFile(first.publicationPath);
  const altered = JSON.parse(firstBytes.toString());
  altered.task.id = 'different-authority';
  await writeFile(first.publicationPath, canonical(altered));
  await assert.rejects(
    rebindArchivePublication({
      priorPublicationPath: first.publicationPath,
      transport: f.transport,
    }),
    /Rebound publication changed/,
  );
  await assert.rejects(
    createArchiveRegistrar({
      publications: [third.publicationPath],
      readScope: 'source-root',
    }),
  );
  await writeFile(first.publicationPath, firstBytes);
  const generations = await cli(f, ['generations', f.source.id]);
  assert.equal(generations.generations.length, 1);
});

test('ACTUAL ARCHIVE CLI: rebind refuses an unreadable seventeenth ancestry entry', async () => {
  const f = await capturedForRebind();
  await rm(join(f.base, 'sources'), { recursive: true });
  let priorPublicationPath = f.priorPath;
  for (let version = 2; version <= 16; version++) {
    await writeFile(
      join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
      `READER_VERSION = ${version}\n`,
    );
    priorPublicationPath = (
      await rebindArchivePublication({
        priorPublicationPath,
        transport: f.transport,
      })
    ).publicationPath;
  }
  assert(
    (
      await createArchiveRegistrar({
        publications: [priorPublicationPath],
        readScope: 'source-root',
      })
    ).identity,
  );
  await writeFile(
    join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
    'READER_VERSION = 17\n',
  );
  await assert.rejects(
    rebindArchivePublication({ priorPublicationPath, transport: f.transport }),
    /Rebind ancestry limit/,
  );
});

test('ACTUAL ARCHIVE CLI: rebind checks bounded prior bytes and every audit provenance field', async () => {
  const f = await capturedForRebind();
  await writeFile(
    join(f.transport.registrarSource, 'src/knowledge_agent/rebind_marker.py'),
    'READER_VERSION = 2\n',
  );
  const rebound = await rebindArchivePublication({
    priorPublicationPath: f.priorPath,
    transport: f.transport,
  });
  const auditBytes = await readFile(rebound.auditPath);
  for (const field of [
    'priorImplementation',
    'priorProtocolSha256',
    'currentOriginal',
  ]) {
    const audit = JSON.parse(auditBytes.toString());
    audit[field] = field === 'currentOriginal' ? 'checked' : '0'.repeat(64);
    await writeFile(rebound.auditPath, canonical(audit));
    await assert.rejects(loadArchivePublication(rebound.publicationPath));
  }
  await writeFile(rebound.auditPath, auditBytes);
  const oversized = join(f.prior.task.directory, 'oversized-prior.json');
  await writeFile(oversized, 'x'.repeat(1_048_577));
  const publication = JSON.parse(
    await readFile(rebound.publicationPath, 'utf8'),
  );
  publication.rebind.priorPublicationPath = oversized;
  const audit = JSON.parse(auditBytes.toString());
  audit.priorPublicationPath = oversized;
  audit.publicationSha256 = hash(canonical(publication));
  await writeFile(rebound.publicationPath, canonical(publication));
  await writeFile(rebound.auditPath, canonical(audit));
  await assert.rejects(
    loadArchivePublication(rebound.publicationPath),
    /Artifact exceeds bound/,
  );
});

test('ACTUAL ARCHIVE CLI: rebind refuses changed or disabled registration and tampered manifest', async () => {
  for (const mode of ['disabled', 'changed', 'manifest']) {
    const f = await capturedForRebind();
    if (mode === 'manifest') {
      await python(
        f,
        'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE archive_generations SET manifest=x\'7b7d\'"); db.commit()',
        [join(f.base, 'state/registry.sqlite3')],
      );
    } else {
      await python(
        f,
        "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[3],)).fetchone()[0]); row.update({'enabled':False} if sys.argv[2]=='disabled' else {'exclude':['*.txt']}); db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[3])); db.commit()",
        [join(f.base, 'state/registry.sqlite3'), mode, f.source.id],
      );
    }
    await assert.rejects(
      rebindArchivePublication({
        priorPublicationPath: f.priorPath,
        transport: f.transport,
      }),
    );
    const artifacts = await readdir(f.options.task.directory);
    assert(!artifacts.some((name) => name.startsWith('archive-rebind-')));
    assert.equal(
      artifacts.filter((name) => name.startsWith('archive-publication-'))
        .length,
      1,
    );
  }
});

test('ACTUAL ARCHIVE CLI: reader scope denial precedes process invocation; traversal, symlinks and cursor mismatches refuse', async () => {
  const f = await captured();
  const request = readRequest(f),
    first = await f.provider.read({ ...request, maxCodePoints: 9 });
  assert(first.ok && first.value.next);
  const bad = await f.provider.read({
    ...request,
    expectedSha256: '0'.repeat(64),
    continuation: first.value.next,
  });
  assert(!bad.ok);
  const discovery = await f.provider.discover({
    scope: [f.source],
    query: 'proposal',
    limit: 1,
    maxBytes: 16000,
    continuation: null,
  });
  assert(discovery.ok && discovery.value.next);
  assert(
    !(
      await f.provider.discover({
        scope: [f.source],
        query: 'changed query',
        limit: 1,
        maxBytes: 16000,
        continuation: discovery.value.next,
      })
    ).ok,
  );
  const db = join(f.base, 'state/registry.sqlite3');
  await rename(db, `${db}.saved`); // Any process preflight would fail; scope refusal must happen earlier.
  for (const path of [
    '../private-decoy',
    '/private/decoy',
    'a/../plan.txt',
    'a\\b',
    'a//b',
  ]) {
    const r = await f.provider.read({
      ...request,
      document: { source: f.source, path },
    });
    assert(!r.ok && r.gap.kind === 'scope-refused');
    assert(!canonical(r).includes('private-decoy'));
  }
  const denied = await f.provider.read({
    ...request,
    document: {
      source: { ...f.source, id: 'UNADMITTED-SECRET' },
      path: 'plan.txt',
    },
  });
  assert(!denied.ok && denied.gap.kind === 'scope-refused');
  assert(!canonical(denied).includes('UNADMITTED-SECRET'));
  await rename(`${db}.saved`, db);
  await symlink(
    join(f.base, 'sources/plan.txt'),
    join(f.base, 'sources/link.txt'),
  );
  const v2 = await captureArchive({ ...f.options, requestKey: 'symlinks' });
  assert(v2.publicationPath);
  const reader = await createArchiveRegistrar({
    publications: [v2.publicationPath],
    readScope: 'source-root',
  });
  assert(
    !(await reader.read({ ...request, continuation: first.value.next })).ok,
  );
  const originalPublication = await readFile(f.result.publicationPath!);
  await writeFile(
    f.result.publicationPath!,
    canonical({ ...f.publication, manifestSha256: '0'.repeat(64) }),
  );
  const forgedReader = await createArchiveRegistrar(f.readerConfig);
  const forged = await forgedReader.read(request);
  assert(!forged.ok && forged.gap.kind === 'unavailable');
  assert.match(forged.gap.detail, /integrity/);
  await writeFile(f.result.publicationPath!, originalPublication);
  assert(!(await reader.read(readRequest(f, 'link.txt'))).ok);
  const alias = join(f.options.task.directory, 'alias.json');
  await symlink(f.result.publicationPath!, alias);
  await assert.rejects(
    createArchiveRegistrar({ publications: [alias], readScope: 'source-root' }),
  );
});

test('ACTUAL ARCHIVE CLI: disabled and changed exclusions revoke access without exposing prior membership', async () => {
  for (const mode of ['disabled', 'exclude']) {
    const f = await captured();
    const before = await f.provider.read(readRequest(f));
    assert(before.ok);
    await python(
      f,
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[3],)).fetchone()[0]); row.update({'enabled':False} if sys.argv[2]=='disabled' else {'exclude':['*.txt']}); db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[3])); db.commit()",
      [join(f.base, 'state/registry.sqlite3'), mode, f.source.id],
    );
    const denied = await f.provider.read(readRequest(f));
    assert(
      !denied.ok && denied.gap.kind === 'scope-refused',
      JSON.stringify(denied),
    );
    assert.equal(
      (await f.provider.revalidate(before.value.evidence)).state,
      'unavailable',
    );
  }
});

test('ACTUAL ARCHIVE CLI: corrupt blobs/manifests and missing archive fail with retained-integrity gaps', async () => {
  for (const mode of ['blob', 'manifest', 'representation', 'missing']) {
    const f = await captured();
    const sql =
      mode === 'blob'
        ? "UPDATE archive_blobs SET data=x'0001'"
        : mode === 'manifest'
          ? "UPDATE archive_generations SET manifest=x'7b7d'"
          : 'DELETE FROM archive_generations';
    if (mode === 'representation')
      await python(
        f,
        `import sqlite3,sys,json,hashlib
db=sqlite3.connect(sys.argv[1])
id,raw=db.execute('SELECT id,manifest FROM archive_generations').fetchone()
m=json.loads(raw); m['documents'][0]['representation']['original_sha256']='0'*64
raw=json.dumps(m,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
db.execute('UPDATE archive_generations SET manifest=?,manifest_sha256=? WHERE id=?',(raw,hashlib.sha256(raw).hexdigest(),id)); db.commit()`,
        [join(f.base, 'state/registry.sqlite3')],
      );
    else
      await python(
        f,
        'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(sys.argv[2]); db.commit()',
        [join(f.base, 'state/registry.sqlite3'), sql],
      );
    await assert.rejects(
      cli(f, [
        'read',
        f.source.id,
        f.publication.generation,
        'plan.txt',
        '--manifest-sha256',
        f.publication.manifestSha256,
      ]),
    );
    const result = await f.provider.read(readRequest(f));
    assert(
      !result.ok && result.gap.kind === 'unavailable',
      JSON.stringify(result),
    );
    if (mode !== 'missing') assert.match(result.gap.detail, /integrity/);
  }
});

test('ACTUAL ARCHIVE CLI: actual DOCX, searchable/scanned PDF and image retain originals and honest capability omissions', async () => {
  const f = await fixture();
  await exec(
    f.config.python,
    [
      '-B',
      fileURLToPath(new URL('../support/archive-corpus.py', import.meta.url)),
      join(f.base, 'sources'),
    ],
    { timeout: 60000 },
  );
  const originals = new Map(
    await Promise.all(
      [
        'office.docx',
        'searchable.pdf',
        'scanned.pdf',
        'pixel.png',
        'visual.md',
      ].map(
        async (p) => [p, await readFile(join(f.base, 'sources', p))] as const,
      ),
    ),
  );
  const result = await captureArchive(f.options);
  assert(result.publicationPath, await readFile(result.resultPath, 'utf8'));
  assert.equal(result.preservation, 'complete-admitted');
  const p = await loadArchivePublication(result.publicationPath);
  const provider = await createArchiveRegistrar({
    publications: [result.publicationPath],
    readScope: 'source-root',
  });
  for (const [path, bytes] of originals) {
    const recovered = join(f.base, `recovered-${path}`);
    await cli(f, ['recover', f.source.id, p.generation, path, recovered]);
    assert.deepEqual(await readFile(recovered), bytes);
  }
  const office = await provider.read(readRequest(f, 'office.docx'));
  assert(office.ok, JSON.stringify(office));
  assert.match(
    office.value.evidence.excerpt,
    /ArchiveSignal office café 😀 caption/,
  );
  assert(
    office.value.evidence.archive?.omissions.some(
      (g) => g.detail === 'visual-evidence-unavailable',
    ),
  );
  const inspected = await cli(f, [
    'inspect',
    f.source.id,
    p.generation,
    '--limit',
    '100',
    '--max-bytes',
    '100000',
  ]);
  const document = (path: string) => {
    const doc = inspected.documents.find(
      (d: { path: string }) => d.path === path,
    );
    assert(doc, `Missing captured document ${path}`);
    assert.equal(doc.original.sha256, hash(originals.get(path)!));
    return doc;
  };
  const pdf = await provider.read(readRequest(f, 'searchable.pdf'));
  const searchable = document('searchable.pdf');
  if (process.platform === 'darwin') {
    assert(!pdf.ok, JSON.stringify(pdf));
    assert.equal(searchable.representation, null);
    assert(
      searchable.gaps.includes('pdf-memory-boundary-unavailable'),
      JSON.stringify(searchable),
    );
  } else if (process.platform === 'linux') {
    assert(pdf.ok, JSON.stringify(pdf));
    assert.match(pdf.value.evidence.excerpt, /ArchiveSignal searchable PDF/);
    assert.equal(
      pdf.value.evidence.sha256,
      hash(originals.get('searchable.pdf')!),
    );
    assert.equal(pdf.value.evidence.representation.method, 'pdf-text');
    assert.equal(
      pdf.value.evidence.archive?.representationSha256,
      searchable.representation.sha256,
    );
    assert.equal(pdf.value.evidence.archive?.generation, p.generation);
    assert.deepEqual(pdf.value.evidence.span, {
      unit: 'unicode-codepoint',
      start: 0,
      end: Array.from(pdf.value.evidence.excerpt).length,
    });
  } else {
    assert.fail(`PDF extraction boundary not evaluated on ${process.platform}`);
  }
  const discovered = await provider.discover({
    scope: [f.source],
    query: 'searchable',
    limit: 20,
    maxBytes: 16000,
    continuation: null,
  });
  assert(discovered.ok, JSON.stringify(discovered));
  assert.deepEqual(
    discovered.value.documents.map((d) => d.document.path),
    process.platform === 'linux' ? ['searchable.pdf'] : [],
  );
  for (const path of ['scanned.pdf', 'pixel.png']) {
    const doc = document(path);
    assert.equal(doc.representation, null, JSON.stringify(doc));
    const read = await provider.read(readRequest(f, path));
    assert(!read.ok, JSON.stringify(read));
    assert.equal(read.gap.kind, 'unsupported');
  }
  assert(p.gaps.some((g) => g.detail === 'visual-evidence-unavailable'));
  const request = {
    scope: [f.source],
    query: null,
    selections: [
      {
        document: { source: f.source, path: 'office.docx' },
        expectedSha256: hash(originals.get('office.docx')!),
      },
    ],
    limits: {
      evidenceCodePoints: 10000,
      contextCodePoints: 32000,
      stateBytes: 131072,
    },
  };
  const input = {
    task: f.options.task,
    provider,
    request,
    budget: {
      calls: 10,
      responseBytes: 100000,
      codePoints: 10000,
      codePointsPerRead: 8000,
      documentsPerPage: 10,
    },
  };
  const collection = await collectKnowledge(input);
  assert(!collection.complete);
  assert.match(collection.context, /visual-evidence-unavailable/);
  const resumed = await collectKnowledge({
    ...input,
    resumeFrom: collection.checkpointPath,
  });
  assert(!resumed.complete);
  assert.match(resumed.context, /visual-evidence-unavailable/);
});

test('ACTUAL ARCHIVE CLI: partial preservation is inspectable but never fully ready; failed capture has no publication', async () => {
  const f = await fixture();
  const partial = await captureArchive({
    ...f.options,
    limits: { file_bytes: 1 },
  });
  assert.equal(
    partial.status,
    'published',
    await readFile(partial.resultPath, 'utf8'),
  );
  assert.equal(partial.preservation, 'incomplete');
  assert(partial.gaps.some((g) => g.kind === 'unavailable'));
  const failed = await captureArchive({
    ...f.options,
    requestKey: 'overflow',
    limits: { entries: 1 },
  });
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.publicationPath, null);
  assert(JSON.parse(await readFile(failed.resultPath, 'utf8')).error);
  const p = await loadArchivePublication(partial.publicationPath!);
  assert.equal(p.counts['limited'], 4);
  const reader = await createArchiveRegistrar({
    publications: [partial.publicationPath!],
    readScope: 'source-root',
  });
  assert(!(await reader.read(readRequest(f))).ok);
});

test('ACTUAL ARCHIVE CLI: two explicit source publications preserve separate origins for equal bytes', async () => {
  const f = await captured();
  const otherRoot = join(f.base, 'other-source');
  await mkdir(otherRoot);
  await writeFile(join(otherRoot, 'plan.txt'), documents['plan.txt']);
  const added = await python(
    f,
    'from pathlib import Path; import json,sys; from knowledge_agent.source_registry import SourceRegistry; print(json.dumps(SourceRegistry(Path(sys.argv[1])).add(Path(sys.argv[2]))))',
    [join(f.base, 'state'), otherRoot],
  );
  const otherSource = {
    ...f.source,
    id: JSON.parse(added.stdout).id,
    locator: new URL(`file://${otherRoot}`).href,
  };
  const second = await captureArchive({
    ...f.options,
    source: otherSource,
    requestKey: 'other-source',
  });
  assert(second.publicationPath, await readFile(second.resultPath, 'utf8'));
  const provider = await createArchiveRegistrar({
    publications: [f.result.publicationPath!, second.publicationPath],
    readScope: 'source-root',
  });
  const found = await provider.discover({
    scope: [f.source, otherSource],
    query: 'proposal',
    limit: 10,
    maxBytes: 65536,
    continuation: null,
  });
  assert(found.ok, JSON.stringify(found));
  assert.equal(found.value.sources.length, 2);
  assert.equal(found.value.coverage.matched, 3);
  const a = await provider.read(readRequest(f)),
    b = await provider.read({
      ...readRequest(f),
      document: { source: otherSource, path: 'plan.txt' },
    });
  assert(a.ok && b.ok);
  assert.equal(a.value.evidence.sha256, b.value.evidence.sha256);
  assert.notEqual(a.value.evidence.id, b.value.evidence.id);
});

test('ACTUAL ARCHIVE CLI: competing first captures converge and reader operations leave Registrar state unchanged', async () => {
  const f = await fixture();
  const concurrent = await Promise.all([
    captureArchive(f.options),
    captureArchive(f.options),
  ]);
  assert(concurrent.some((r) => r.status === 'published'));
  for (const attempt of concurrent) {
    assert.equal(
      JSON.parse(await readFile(attempt.resultPath, 'utf8')).status,
      attempt.status,
    );
    assert.equal(
      JSON.parse(await readFile(attempt.attemptPath, 'utf8')).state,
      'started',
    );
  }
  const replay = await captureArchive(f.options);
  assert(replay.publicationPath);
  const generations = await cli(f, ['generations', f.source.id]);
  assert.equal(generations.generations.length, 1);
  const publication = await loadArchivePublication(replay.publicationPath);
  assert.equal(publication.generation, generations.generations[0].generation);
  const databaseDump = async () =>
    (
      await python(
        f,
        'import sqlite3,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print("\\n".join(db.iterdump()))',
        [join(f.base, 'state/registry.sqlite3')],
      )
    ).stdout;
  const before = await databaseDump();
  const provider = await createArchiveRegistrar({
    publications: [replay.publicationPath],
    readScope: 'source-root',
  });
  assert.deepEqual(Object.keys(provider).sort(), [
    'discover',
    'identity',
    'read',
    'revalidate',
  ]);
  assert(
    (
      await provider.discover({
        scope: [f.source],
        query: 'proposal',
        limit: 10,
        maxBytes: 65536,
        continuation: null,
      })
    ).ok,
  );
  const read = await provider.read(readRequest(f));
  assert(read.ok);
  assert.equal(
    (await provider.revalidate(read.value.evidence)).state,
    'unchanged',
  );
  const denied = await provider.discover({
    scope: [{ ...f.source, id: 'UNADMITTED-SECRET' }],
    query: 'proposal',
    limit: 10,
    maxBytes: 65536,
    continuation: null,
  });
  assert(!denied.ok && denied.gap.kind === 'scope-refused');
  assert(!canonical(denied).includes('UNADMITTED-SECRET'));
  assert.equal(await databaseDump(), before);
});

test('ACTUAL ARCHIVE CLI: reader callback receives historical qualifiers and assessed citations stay separate from read context', async () => {
  const f = await captured();
  await rm(join(f.base, 'sources'), { recursive: true });
  const input = inputFor(f.source, f.options.task.directory);
  let called = false;
  const result = await investigateDesignUpdate({
    ...input,
    provider: f.provider,
    assess: async ({ brief, checkpoint }) => {
      called = true;
      assert.equal(brief.context, checkpoint.suppliedContext);
      assert(brief.context.includes(f.publication.generation));
      assert(brief.context.includes(f.publication.manifestSha256));
      assert.match(brief.context, /not-checked/);
      assert(checkpoint.checks.every((c) => c.basis === 'archive-snapshot'));
      return assessFixture(checkpoint);
    },
  });
  assert(called);
  assert.equal(result.status, 'ISSUES');
  const state = await loadInvestigation(result.evidencePaths.at(-1)!);
  assert.equal(state.evidence.length, 4);
  assert.equal(state.contextEvidenceIds.length, 4);
  assert.equal(state.assessment?.findings[0].supports.length, 2);
  assert(
    state.assessment?.findings[0].supports.every((id) =>
      state.contextEvidenceIds.includes(id),
    ),
  );
  const { basis: _basis, ...withoutBasis } = state.checks[0];
  const invalid = {
    ...state,
    checks: [withoutBasis, ...state.checks.slice(1)],
  };
  const checkpointPath = join(
    f.options.task.directory,
    `knowledge-${hash(canonical(invalid))}.json`,
  );
  await writeFile(checkpointPath, canonical(invalid));
  await assert.rejects(loadInvestigation(checkpointPath));
});
