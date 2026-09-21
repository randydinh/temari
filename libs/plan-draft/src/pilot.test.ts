import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  commandConfiguration,
  commandEvents,
} from './support/command-fixtures.js';
import { pilotIntent, runPilot, runPilotNx } from './support/pilot-fixtures.js';

async function fixture() {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'pilot-input-'),
  );
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, 'state'));
  await mkdir(join(directory, 'sources'));
  await writeFile(join(directory, 'state', 'registry.sqlite3'), 'synthetic');
  await writeFile(join(directory, 'pyproject.toml'), 'synthetic');
  await writeFile(join(directory, 'uv.lock'), 'synthetic');
  const python = join(directory, 'registrar.sh');
  await writeFile(
    python,
    '#!/bin/sh\nprintf "list\\n" >> "$(dirname "$0")/registrar-events.txt"\nprintf \'{"status":"invalid","error":"PRIVATE_SENTINEL"}\'\n',
  );
  await chmod(python, 0o700);
  const preparation = join(directory, 'preparation.json');
  await writeFile(
    preparation,
    JSON.stringify({
      kind: 'temari-knowledge-isolated',
      schema: 1,
      state: join(directory, 'state'),
      root: join(directory, 'sources'),
      instance: 'synthetic-refusal',
      sourceId: 'synthetic',
    }),
  );
  const intent = await pilotIntent(
    { provider: 'synthetic', id: 'synthetic', locator: 'synthetic:input' },
    directory,
  );
  const config = {
    schema: 1,
    registrar: {
      python,
      registrarSource: directory,
      preparation,
      readScope: 'source-root',
    },
    judgments: await commandConfiguration(directory),
    command: { kind: 'start', intent },
  };
  const path = join(directory, 'config with spaces.json');
  await writeFile(path, JSON.stringify(config));
  return { directory, path, config, intent };
}

test('direct help and actual Nx forwarding accept only the advertised arguments', async () => {
  for (const args of [[], ['--help'], ['--', '--help']]) {
    const result = runPilot(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: pnpm nx run plan-draft:pilot/);
    assert.equal(result.stderr, '');
  }
  const f = await fixture();
  for (const args of [
    ['--unknown'],
    ['--config'],
    ['--config=relative.json'],
    ['--config', 'relative.json'],
    ['--config='],
    ['--help', '--config', f.path],
    ['--config', f.path, '--help'],
    ['--config', f.path, '--config', f.path],
    [`--config=${f.path}`, `--config=${f.path}`],
    ['--', '--', '--help'],
  ]) {
    const result = runPilot(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'Pilot arguments: expected only --config with an absolute JSON file, or --help.\n',
    );
  }
  const nx = runPilotNx(['--help']);
  assert.equal(nx.status, 0, nx.stderr + nx.stdout);
  assert.match(nx.stdout, /Usage: pnpm nx run plan-draft:pilot/);
  const rejected = runPilotNx(['--unexpected']);
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stdout + rejected.stderr,
    /Pilot arguments: expected only --config/,
  );
  assert.equal(
    await lstat(join(f.directory, 'registrar-events.txt')).catch(() => null),
    null,
  );
  assert.deepEqual(await commandEvents(f.directory), []);
  const configured = runPilotNx(['--config', f.path]);
  assert.equal(configured.status, 1);
  assert.match(
    configured.stdout + configured.stderr,
    /Pilot Registrar: construction failed/,
  );
  assert.equal(
    await readFile(join(f.directory, 'registrar-events.txt'), 'utf8'),
    'list\n',
  );
});

test('input files are bounded regular UTF-8 JSON and failures omit supplied values', async () => {
  const f = await fixture();
  const fifo = join(f.directory, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  for (const path of [
    join(f.directory, 'MISSING_PRIVATE_SENTINEL'),
    f.directory,
    fifo,
  ]) {
    const result = runPilot(['--config', path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'Pilot config: expected a readable regular file of at most 1 MiB.\n',
    );
  }
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from('{"PRIVATE_SENTINEL":'),
    Buffer.from('\ufeff{}'),
    Buffer.alloc(0),
  ]) {
    await writeFile(f.path, bytes);
    const result = runPilot([`--config=${f.path}`]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Pilot config: expected valid UTF-8 JSON.\n');
  }
  await writeFile(f.path, ' '.repeat(1024 * 1024 + 1));
  const over = runPilot(['--config', f.path]);
  assert.equal(over.status, 1);
  assert.equal(
    over.stderr,
    'Pilot config: expected a readable regular file of at most 1 MiB.\n',
  );
  assert.equal(
    await lstat(join(f.directory, 'registrar-events.txt')).catch(() => null),
    null,
  );
  const body = JSON.stringify(f.config);
  await writeFile(
    f.path,
    body + ' '.repeat(1024 * 1024 - Buffer.byteLength(body)),
  );
  const exact = runPilot(['--', '--config', f.path]);
  assert.equal(exact.status, 1);
  assert.equal(exact.stdout, '');
  assert.equal(
    exact.stderr,
    'Pilot Registrar: construction failed; check the explicit prepared configuration.\n',
  );
  assert.equal(
    await readFile(join(f.directory, 'registrar-events.txt'), 'utf8'),
    'list\n',
  );
  assert.deepEqual(await commandEvents(f.directory), []);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
});

test('closed domain shapes are rejected before Registrar or judgments can execute', async (t) => {
  const f = await fixture();
  const mutations: [string, (value: ReturnType<typeof JSON.parse>) => void][] =
    [
      [
        'extra envelope field',
        (v) => {
          v.PRIVATE_SENTINEL = true;
        },
      ],
      [
        'missing envelope field',
        (v) => {
          delete v.registrar;
        },
      ],
      [
        'schema',
        (v) => {
          v.schema = 2;
        },
      ],
      [
        'callback',
        (v) => {
          v.registrar.onCommand = 'PRIVATE_SENTINEL';
        },
      ],
      [
        'registrar path type',
        (v) => {
          v.registrar.python = 7;
        },
      ],
      [
        'read scope',
        (v) => {
          v.registrar.readScope = 'document';
        },
      ],
      [
        'registrar option type',
        (v) => {
          v.registrar.timeoutMs = '100';
        },
      ],
      [
        'extra role',
        (v) => {
          v.judgments.roles.other = {};
        },
      ],
      [
        'missing role',
        (v) => {
          delete v.judgments.roles.assess;
        },
      ],
      [
        'command role field',
        (v) => {
          v.judgments.roles.review.extra = 1;
        },
      ],
      [
        'arguments',
        (v) => {
          v.judgments.roles.review.args = [1];
        },
      ],
      [
        'environment value',
        (v) => {
          v.judgments.roles.review.environment.KEY = {};
        },
      ],
      [
        'artifact value',
        (v) => {
          v.judgments.roles.review.artifacts = { path: 5 };
        },
      ],
      [
        'service field',
        (v) => {
          v.judgments.roles.review.service.extra = true;
        },
      ],
      [
        'timeout type',
        (v) => {
          v.judgments.roles.review.timeoutMs = null;
        },
      ],
      [
        'command discriminant',
        (v) => {
          v.command.kind = 'restart';
        },
      ],
      [
        'start fields',
        (v) => {
          v.command.destination = '/replacement';
        },
      ],
      [
        'intent field',
        (v) => {
          v.command.intent.extra = true;
        },
      ],
      [
        'task field',
        (v) => {
          v.command.intent.task.extra = true;
        },
      ],
      [
        'brief field',
        (v) => {
          delete v.command.intent.brief.context;
        },
      ],
      [
        'brief format',
        (v) => {
          v.command.intent.brief.reportFormat = 'text';
        },
      ],
      [
        'criteria type',
        (v) => {
          v.command.intent.brief.acceptanceCriteria = 'criterion';
        },
      ],
      [
        'authority field',
        (v) => {
          v.command.intent.authority.extra = 1;
        },
      ],
      [
        'request field',
        (v) => {
          v.command.intent.request.extra = 1;
        },
      ],
      [
        'source field',
        (v) => {
          v.command.intent.request.scope[0].extra = 1;
        },
      ],
      [
        'selection field',
        (v) => {
          v.command.intent.request.selections[0].extra = 1;
        },
      ],
      [
        'document field',
        (v) => {
          v.command.intent.request.selections[0].document.extra = 1;
        },
      ],
      [
        'selection role',
        (v) => {
          v.command.intent.request.selections[0].role = 'owner';
        },
      ],
      [
        'requires type',
        (v) => {
          v.command.intent.request.selections[0].requires = [false];
        },
      ],
      [
        'budget field',
        (v) => {
          delete v.command.intent.request.budget.responseBytes;
        },
      ],
      [
        'budget type',
        (v) => {
          v.command.intent.request.budget.discoveryPages = '2';
        },
      ],
      [
        'resume replacement intent',
        (v) => {
          v.command = {
            kind: 'resume',
            task: f.intent.task,
            destination: f.intent.destination,
            intent: f.intent,
          };
        },
      ],
    ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const changed = JSON.parse(JSON.stringify(f.config));
      mutate(changed);
      await writeFile(f.path, JSON.stringify(changed));
      const result = runPilot(['--config', f.path]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'Pilot config: invalid schema-1 configuration shape.\n',
      );
    });
  }
  const invalidJudgments = JSON.parse(JSON.stringify(f.config));
  invalidJudgments.judgments.roles.review.timeoutMs = 0;
  await writeFile(f.path, JSON.stringify(invalidJudgments));
  const invalid = runPilot(['--config', f.path]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, 'Pilot judgments: configuration rejected.\n');
  assert.equal(
    await lstat(join(f.directory, 'registrar-events.txt')).catch(() => null),
    null,
  );
  assert.deepEqual(await commandEvents(f.directory), []);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
});

test('ordinary JSON duplicate members use the last value and preserve constructor diagnostics', async () => {
  const f = await fixture();
  await writeFile(f.path, `{"schema":9,${JSON.stringify(f.config).slice(1)}`);
  const result = runPilot([`--config=${f.path}`]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Pilot Registrar: construction failed; check the explicit prepared configuration.\n',
  );
  assert.equal(
    await readFile(join(f.directory, 'registrar-events.txt'), 'utf8'),
    'list\n',
  );
  assert.deepEqual(await commandEvents(f.directory), []);
});
