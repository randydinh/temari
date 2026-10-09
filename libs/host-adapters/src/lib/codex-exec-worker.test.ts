import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  chmod,
  mkdtemp,
  readFile,
  writeFile,
  open,
  stat,
  rm,
  mkdir,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCodexExecWorker,
  runCodexExecWriteWorker,
  resolveCodexExecutable,
  observeCodexModelSelection,
} from './codex-exec-worker.js';
import type { WorkerAssignment } from '@temari/contracts';

const assignment: WorkerAssignment = {
  id: 'review-one',
  role: 'reviewer',
  required: true,
  brief: {
    goal: 'Inspect the code',
    context: 'Local test',
    scope: 'One file',
    acceptanceCriteria: ['Report findings'],
    verificationCommand: null,
    reportFormat: 'json',
    forbiddenActions: ['Do not write files'],
  },
};

async function tomlParser(): Promise<string> {
  for (const command of ['python3', 'python3.11', 'python3.12']) {
    try {
      return await realpath(
        execFileSync(
          command,
          ['-c', 'import sys,tomllib;print(sys.executable)'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim(),
      );
    } catch {}
  }
  throw new Error(
    'A Python TOML parser is required for model admission tests.',
  );
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

test('model admission matches only stable or alpha CLI releases to release-format catalogs', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-catalog-version-')),
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const configHome = join(root, 'user-config');
  await mkdir(configHome);
  process.env.CODEX_HOME = configHome;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });
  const configPath = join(configHome, 'config.toml');
  const catalogPath = join(root, 'catalog.json');
  await writeFile(
    configPath,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\n',
  );
  let parserExecutable: string | undefined;
  for (const command of ['python3', 'python3.11', 'python3.12']) {
    try {
      parserExecutable = await realpath(
        execFileSync(
          command,
          ['-c', 'import sys,tomllib;print(sys.executable)'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim(),
      );
      break;
    } catch {}
  }
  assert(
    parserExecutable,
    'A Python TOML parser is required for model admission tests.',
  );
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const cases = [
    ['0.162.0', '0.162.0', true],
    ['0.154.0', '0.154.0', true],
    ['0.162.0-alpha.2', '0.162.0', true],
    ['0.162.0-alpha.0', '0.162.0', true],
    ['0.162.0-alpha.12', '0.162.0', true],
    ['0.162.0-alpha.2', '0.154.0', false],
    ['0.162.0-alpha.2', '0.162.1', false],
    ['0.162.0-alpha.2', '0.163.0', false],
    ['0.162.0-alpha.2', '1.162.0', false],
    ['0.162.0', '0.161.0', false],
    ['0.162.0-alpha.2', '0.162.0-alpha.2', false],
    ['0.162.0-beta.2', '0.162.0', false],
    ['0.162.0-rc.2', '0.162.0', false],
    ['0.162.0-alpha', '0.162.0', false],
    ['0.162.0-alpha.02', '0.162.0', false],
    ['0.162.0-alpha.2.extra', '0.162.0', false],
    ['0.162.0+build.2', '0.162.0', false],
    ['0.162.0-alpha.2+build', '0.162.0', false],
    ['00.162.0', '00.162.0', false],
    ['0.162', '0.162', false],
    ['fixture', 'fixture', false],
    ['0.162.0 ', '0.162.0', false],
    ['0.162.0\n', '0.162.0', false],
    ['0.162.0-alpha.2\n', '0.162.0', false],
    ['0.162.0', '0.162.0\n', false],
    ['0.162.0', 'v0.162.0', false],
    ['0.162.0', null, false],
    ['0.162.0', 162, false],
  ] as const;
  for (const [cliVersion, catalogVersion, accepted] of cases) {
    await t.test(
      `${cliVersion} / ${catalogVersion}: ${accepted ? 'admit' : 'refuse'}`,
      async () => {
        await writeFile(
          catalogPath,
          JSON.stringify({
            client_version: catalogVersion,
            fetched_at: new Date().toISOString(),
            models: [
              {
                slug: 'fixture-model',
                supported_reasoning_levels: [{ effort: 'high' }],
              },
            ],
          }),
        );
        const selection = {
          provider: 'codex' as const,
          executableSha256: 'a'.repeat(64),
          executableVersion: `codex-cli ${cliVersion}`,
          model: 'fixture-model',
          reasoning: 'high',
        };
        const input = {
          configPath,
          configSha256: sha(await readFile(configPath)),
          catalogPath,
          catalogSha256: sha(await readFile(catalogPath)),
          parserExecutable,
          parserSha256: sha(await readFile(parserExecutable)),
        };
        if (accepted) {
          const result = await observeCodexModelSelection(
            selection,
            input,
            root,
          );
          assert.equal(result.catalog.clientVersion, catalogVersion);
          assert.equal(
            result.catalog.executableVersion,
            selection.executableVersion,
          );
          assert.deepEqual(result.observed, { model: null, reasoning: null });
        } else {
          await assert.rejects(
            () => observeCodexModelSelection(selection, input, root),
            /different CLI version|Unsupported CLI\/catalog version format/,
          );
        }
      },
    );
  }
});

test('uses argv and stdin without shell interpolation and validates the final response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-worker-'));
  const executable = join(root, 'fake;$(touch injected)');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  if (args[0] !== 'exec' || !args.includes('--ignore-user-config') || !args.includes('--ephemeral') || args[args.indexOf('--sandbox') + 1] !== 'read-only' || !args.includes('--json') || args.at(-1) !== '-') process.exit(9);
  if (!JSON.parse(fs.readFileSync(schema, 'utf8')).required.includes('summary')) process.exit(8);
  fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:prompt.includes('Inspect the code') ? 'inspected' : 'missing prompt'}));
  console.log(JSON.stringify({type:'event',ok:true}));
});
`,
  );
  await chmod(executable, 0o755);
  assert.equal(await resolveCodexExecutable(executable), executable);
  const result = await runCodexExecWorker(assignment, {
    executable,
    workspaceRoot: root,
    evidenceDirectory: join(root, 'evidence'),
    timeoutMs: 1000,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.summary, 'inspected');
  assert.equal(
    (await readFile(join(root, 'evidence', 'process.json'), 'utf8')).includes(
      '"pid":',
    ),
    true,
  );
  await assert.rejects(() => readFile(join(root, 'injected')));
});

test('managed execution ignores live user config and passes the exact admitted selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-managed-worker-'));
  const configHome = join(root, 'codex-home');
  await mkdir(configHome);
  await writeFile(
    join(configHome, 'config.toml'),
    'model = "unrelated-live-model"\nmodel_reasoning_effort = "low"\n',
  );
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = configHome;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.154.0');process.exit(0);}
const expected=['exec','--ignore-user-config','--model','admitted-model','--config','model_provider="openai"','--config','model_reasoning_effort="high"'];
if(JSON.stringify(a.slice(0,expected.length))!==JSON.stringify(expected))process.exit(12);
if(process.env.CODEX_HOME!==${JSON.stringify(configHome)})process.exit(13);
let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'managed-fixture-thread'}));process.stdout.write('x'.repeat(2*1024*1024));fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({status:'PASS',summary:'explicit selection'}));});`,
    { mode: 0o700 },
  );
  const selection = {
    provider: 'codex' as const,
    executableSha256: sha256(await readFile(executable)),
    executableVersion: 'codex-cli 0.154.0',
    model: 'admitted-model',
    reasoning: 'high',
  };
  const result = await runCodexExecWorker(assignment, {
    executable,
    workspaceRoot: root,
    evidenceDirectory: join(root, 'evidence'),
    timeoutMs: 1000,
    providerSelection: selection,
    finalResponseLimitBytes: 1024,
    skipGitRepoCheck: true,
  });
  assert.equal(result.status, 'PASS');
  const evidence = JSON.parse(
    await readFile(join(root, 'evidence', 'process.json'), 'utf8'),
  );
  assert.equal(evidence.nativeThreadId, 'managed-fixture-thread');
  assert.equal(evidence.captureComplete, true);
  assert.equal(evidence.outputLimitExceeded, false);
  assert(evidence.stdoutWrittenBytes > 2 * 1024 * 1024);
  assert.deepEqual(evidence.argv.slice(0, 8), [
    'exec',
    '--ignore-user-config',
    '--model',
    'admitted-model',
    '--config',
    'model_provider="openai"',
    '--config',
    'model_reasoning_effort="high"',
  ]);
});

test('raw config drift is diagnostic while execution-critical drift is refused', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-config-projection-')),
  );
  const configHome = join(root, 'codex-home');
  await mkdir(configHome);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = configHome;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });
  const configPath = join(configHome, 'config.toml');
  const catalogPath = join(root, 'catalog.json');
  const parserExecutable = await tomlParser();
  const initial =
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\nnotify = ["initial"]\n';
  await writeFile(configPath, initial);
  await writeFile(
    catalogPath,
    JSON.stringify({
      client_version: '0.154.0',
      fetched_at: new Date().toISOString(),
      models: [
        {
          slug: 'fixture-model',
          supported_reasoning_levels: [{ effort: 'high' }],
        },
      ],
    }),
  );
  const selection = {
    provider: 'codex' as const,
    executableSha256: 'a'.repeat(64),
    executableVersion: 'codex-cli 0.154.0',
    model: 'fixture-model',
    reasoning: 'high',
  };
  const admission = {
    configPath,
    configSha256: sha256(Buffer.from(initial)),
    catalogPath,
    catalogSha256: sha256(await readFile(catalogPath)),
    parserExecutable,
    parserSha256: sha256(await readFile(parserExecutable)),
  };
  await writeFile(
    configPath,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\nnotify = ["changed"]\n',
  );
  const diagnostic = await observeCodexModelSelection(
    selection,
    admission,
    root,
  );
  assert.equal(diagnostic.config.initialSha256, admission.configSha256);
  assert.equal(diagnostic.config.drifted, true);
  assert.notEqual(diagnostic.config.currentSha256, admission.configSha256);
  assert.equal(diagnostic.config.critical.model, 'fixture-model');

  await writeFile(
    configPath,
    'model = "other-model"\nmodel_reasoning_effort = "high"\n',
  );
  await assert.rejects(
    () => observeCodexModelSelection(selection, admission, root),
    /differs from inherited user settings/,
  );
});

test('model admission parses the exact config bytes that it hashes', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-config-bytes-')),
  );
  const configHome = join(root, 'codex-home');
  await mkdir(configHome);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = configHome;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });
  const configPath = join(configHome, 'config.toml');
  const initial = 'model = "fixture-model"\nmodel_reasoning_effort = "high"\n';
  await writeFile(configPath, initial);
  const catalogPath = join(root, 'catalog.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      client_version: '0.154.0',
      fetched_at: new Date().toISOString(),
      models: [
        {
          slug: 'fixture-model',
          supported_reasoning_levels: [{ effort: 'high' }],
        },
      ],
    }),
  );
  const parserExecutable = join(root, 'parser');
  await writeFile(
    parserExecutable,
    `#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{if(!input.includes('model = "fixture-model"'))process.exit(9);fs.writeFileSync(${JSON.stringify(configPath)},'model = "other-model"\\nmodel_reasoning_effort = "low"\\n');console.log(JSON.stringify({model:'fixture-model',model_reasoning_effort:'high',model_provider:null,profile:null,model_catalog_json:null}));});`,
    { mode: 0o700 },
  );
  const result = await observeCodexModelSelection(
    {
      provider: 'codex',
      executableSha256: 'a'.repeat(64),
      executableVersion: 'codex-cli 0.154.0',
      model: 'fixture-model',
      reasoning: 'high',
    },
    {
      configPath,
      configSha256: sha256(Buffer.from(initial)),
      catalogPath,
      catalogSha256: sha256(await readFile(catalogPath)),
      parserExecutable,
      parserSha256: sha256(await readFile(parserExecutable)),
    },
    root,
  );
  assert.equal(result.config.currentSha256, sha256(Buffer.from(initial)));
  assert.equal(result.config.critical.model, 'fixture-model');
  assert.match(await readFile(configPath, 'utf8'), /other-model/);
});

test('missing executable fails before process launch', async () => {
  await assert.rejects(
    () => resolveCodexExecutable('/no/such/codex-executable'),
    /missing or not executable/,
  );
});

test('retains an actual start observation while the independently launched worker is still running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-worker-start-'));
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs'), args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'PASS',summary:'completed'})),500));
`,
  );
  await chmod(executable, 0o755);
  let completed = false;
  const running = runCodexExecWorker(assignment, {
    executable,
    workspaceRoot: root,
    evidenceDirectory: join(root, 'evidence'),
    timeoutMs: 5000,
  }).then((result) => {
    completed = true;
    return result;
  });
  let start: {
    pid: number;
    startedAt: string;
    assignmentId: string;
    workspaceRoot: string;
    executable: string;
  } | null = null;
  for (let attempt = 0; attempt < 50 && !start; attempt++) {
    try {
      start = JSON.parse(
        await readFile(join(root, 'evidence', 'process-start.json'), 'utf8'),
      );
    } catch {}
    if (!start) await new Promise((done) => setTimeout(done, 10));
  }
  assert(start && start.pid > 0 && start.pid !== process.pid);
  assert.equal(completed, false);
  assert.equal(start.assignmentId, assignment.id);
  assert.equal(start.workspaceRoot, root);
  assert.equal(start.executable, executable);
  await assert.rejects(
    readFile(join(root, 'evidence', 'process.json')),
    /ENOENT/,
  );
  assert.equal((await running).status, 'PASS');
  const terminal = JSON.parse(
    await readFile(join(root, 'evidence', 'process.json'), 'utf8'),
  );
  assert.equal(terminal.pid, start.pid);
  assert.equal(terminal.startedAt, start.startedAt);
});

test('write worker Git commands use its clone despite inherited Git routing variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-write-env-'));
  execFileSync('git', ['init', '-q', root]);
  const executable = join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  if (args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(8);
  if (!process.env.PATH || process.env.GIT_ASKPASS !== 'preserved-helper') process.exit(9);
  fs.writeFileSync('owned.txt', 'worker change\\n');
  execFileSync('git', ['add', 'owned.txt']);
  fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:'staged in clone'}));
});
`,
  );
  await chmod(executable, 0o755);
  const routed = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_ASKPASS',
  ] as const;
  const previous = Object.fromEntries(
    routed.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    GIT_DIR: join(root, 'nonexistent-git-dir'),
    GIT_WORK_TREE: join(root, 'wrong-worktree'),
    GIT_INDEX_FILE: join(root, 'wrong-index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: join(root, 'wrong-worktree'),
    GIT_ASKPASS: 'preserved-helper',
  });
  try {
    const result = await runCodexExecWriteWorker(
      {
        ...assignment,
        id: 'implement-one',
        role: 'implementer',
      },
      {
        executable,
        workspaceRoot: root,
        evidenceDirectory: join(root, 'evidence'),
        timeoutMs: 2000,
        baseCommit: 'test-base',
        owns: [{ kind: 'file', path: 'owned.txt' }],
      },
    );
    assert.equal(
      result.status,
      'PASS',
      await readFile(join(root, 'evidence', 'stderr.log'), 'utf8'),
    );
    assert.equal(result.summary, 'staged in clone');
  } finally {
    for (const name of routed) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(
    execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    'owned.txt',
  );
});

const diagnosticStdoutPrefix = 'PRIVATE_STDOUT_SENTINEL:';
const diagnosticStderrPrefix = 'PRIVATE_STDERR_SENTINEL:';
function diagnosticHash(prefix: string, value: number): string {
  const hashing = createHash('sha256').update(prefix);
  const chunk = Buffer.alloc(65_536, value);
  for (let index = 0; index < 256; index++) hashing.update(chunk);
  return hashing.update('!').digest('hex');
}
async function actualDiagnosticHash(path: string): Promise<string> {
  const hashing = createHash('sha256');
  const file = await open(path, 'r');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hashing.update(chunk);
  } finally {
    await file.close();
  }
  return hashing.digest('hex');
}
async function assertLargeDiagnostic(
  path: string,
  stderr = false,
): Promise<void> {
  const prefix = stderr ? diagnosticStderrPrefix : diagnosticStdoutPrefix;
  assert.equal((await stat(path)).size, 16_777_217 + Buffer.byteLength(prefix));
  assert.equal(
    await actualDiagnosticHash(path),
    diagnosticHash(prefix, stderr ? 122 : 97),
  );
}

test('Codex adapter retains both full raw streams on normal and nonzero exits beyond 16 MiB', async (t) => {
  for (const code of [0, 7])
    await t.test(`exit ${code}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'temari-codex-large-'));
      try {
        const executable = join(root, 'fake-codex');
        await writeFile(
          executable,
          `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),final=args[args.indexOf('--output-last-message')+1];
const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));};
process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(final,JSON.stringify({status:'PASS',summary:'known result'}));Promise.all([emit(process.stdout,97,'PRIVATE_STDOUT_SENTINEL:'),emit(process.stderr,122,'PRIVATE_STDERR_SENTINEL:')]).then(()=>process.exit(${code}));});
`,
        );
        await chmod(executable, 0o755);
        const evidenceDirectory = join(root, 'evidence');
        const result = await runCodexExecWorker(assignment, {
          executable,
          workspaceRoot: root,
          evidenceDirectory,
          timeoutMs: 10000,
          finalResponseLimitBytes: 1024,
        });
        assert.equal(result.status, code === 0 ? 'PASS' : 'BLOCKED');
        assert(!JSON.stringify(result).includes('PRIVATE_STD'));
        await assertLargeDiagnostic(join(evidenceDirectory, 'stdout.jsonl'));
        await assertLargeDiagnostic(
          join(evidenceDirectory, 'stderr.log'),
          true,
        );
        const observed = JSON.parse(
          await readFile(join(evidenceDirectory, 'process.json'), 'utf8'),
        );
        assert.equal(observed.outputLimitExceeded, false);
        assert.equal(observed.captureComplete, true);
        assert.equal(
          observed.stdoutSha256,
          diagnosticHash(diagnosticStdoutPrefix, 97),
        );
        assert.equal(
          observed.stderrSha256,
          diagnosticHash(diagnosticStderrPrefix, 122),
        );
        const start = JSON.parse(
          await readFile(join(evidenceDirectory, 'process-start.json'), 'utf8'),
        );
        assert.equal(observed.pid, start.pid);
        assert.equal(observed.startedAt, start.startedAt);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
});

test('final-response and legacy alias conflict is rejected before process launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-codex-alias-'));
  try {
    await assert.rejects(
      runCodexExecWorker(assignment, {
        executable: '/unused',
        workspaceRoot: root,
        evidenceDirectory: join(root, 'evidence'),
        timeoutMs: 1000,
        outputLimitBytes: 100,
        finalResponseLimitBytes: 200,
      }),
      /conflict/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
