import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkTemariReleaseRoot } from './temari-release-verify.mjs';
import { inspectTemariInstall } from './temari-install-state.mjs';

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      'prior-root',
      'prior-release-sha256',
      'prior-manifest-sha256',
      'candidate-root',
      'candidate-release-sha256',
      'candidate-manifest-sha256',
      'scratch-root',
      'codex-bin',
    ].map((key) => [key, { type: 'string' }]),
  ),
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = [];
let journal;

async function retain() {
  if (journal)
    await writeFile(
      journal,
      `${JSON.stringify({ schemaVersion: 1, purpose: 'isolated native installation verification; no canonical Temari receipt', records }, null, 2)}\n`,
    );
}

function command(bin, args, env, expectedExit = 0) {
  let stdout = '',
    stderr = '',
    exitCode = 0;
  try {
    stdout = execFileSync(bin, args, {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    stdout = error.stdout?.toString() ?? '';
    stderr = error.stderr?.toString() ?? '';
    exitCode = error.status ?? -1;
  }
  records.push({
    at: new Date().toISOString(),
    bin,
    args,
    exitCode,
    stdout,
    stderr,
  });
  assert.equal(
    exitCode,
    expectedExit,
    `Unexpected command exit: ${args.join(' ')}`,
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function main() {
  for (const key of Object.keys(values))
    assert(values[key], `Missing --${key}`);
  assert.equal(
    Object.keys(values).length,
    8,
    'All eight selection arguments are required',
  );
  for (const key of [
    'prior-root',
    'candidate-root',
    'scratch-root',
    'codex-bin',
  ])
    assert(isAbsolute(values[key]), `--${key} must be absolute`);
  for (const key of [
    'prior-release-sha256',
    'prior-manifest-sha256',
    'candidate-release-sha256',
    'candidate-manifest-sha256',
  ])
    assert.match(values[key], /^[a-f0-9]{64}$/, `Invalid --${key}`);
  const prior = {
    root: values['prior-root'],
    releaseSha256: values['prior-release-sha256'],
    manifestSha256: values['prior-manifest-sha256'],
  };
  const candidate = {
    root: values['candidate-root'],
    releaseSha256: values['candidate-release-sha256'],
    manifestSha256: values['candidate-manifest-sha256'],
  };
  await checkTemariReleaseRoot(
    prior.root,
    prior.releaseSha256,
    prior.manifestSha256,
    { historical: true },
  );
  await checkTemariReleaseRoot(
    candidate.root,
    candidate.releaseSha256,
    candidate.manifestSha256,
  );
  const catalog = JSON.parse(
    await readFile(
      join(candidate.root, '.agents/plugins/marketplace.json'),
      'utf8',
    ),
  );
  const priorCatalog = JSON.parse(
    await readFile(
      join(prior.root, '.agents/plugins/marketplace.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    catalog,
    priorCatalog,
    'Marketplace identity changes across this upgrade',
  );
  assert.equal(catalog.plugins.length, 1);
  const selector = `${catalog.plugins[0].name}@${catalog.name}`;
  const scratch = resolve(values['scratch-root']);
  assert.equal(
    await realpath(dirname(scratch)),
    dirname(scratch),
    'Scratch parent must be canonical',
  );
  await mkdir(scratch, { mode: 0o700 });
  journal = join(scratch, 'journey.json');
  const codexHome = join(scratch, 'codex-home');
  await mkdir(codexHome, { mode: 0o700 });
  const codexBin = values['codex-bin'];
  const env = { ...process.env, CODEX_HOME: codexHome };
  records.push({
    at: new Date().toISOString(),
    selection: { prior, candidate, codexHome, codexBin },
    cliVersion: execFileSync(codexBin, ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
  });
  const inspect = async (label) => {
    const state = await inspectTemariInstall({
      codexHome,
      codexBin,
      candidate,
      prior,
    });
    records.push({ at: new Date().toISOString(), checkpoint: label, state });
    await retain();
    return state;
  };
  const cli = (args, expectedExit) =>
    command(codexBin, args, env, expectedExit);
  const installed = () => {
    const state = cli(['plugin', 'list', '--available', '--json']);
    assert(Array.isArray(state.installed) && Array.isArray(state.available));
    assert(
      !state.installed.some(
        (item) => item.name === 'temari' && item.pluginId !== selector,
      ),
      'Foreign installed Temari in isolated home',
    );
    return state.installed.filter((item) => item.pluginId === selector);
  };
  const assertVersion = (version) => {
    const own = installed();
    assert.equal(own.length, 1);
    assert.equal(own[0].version, version);
    assert.equal(own[0].enabled, true);
  };
  await inspect('fresh home');
  cli(['plugin', 'marketplace', 'add', prior.root, '--json']);
  const first = cli(['plugin', 'add', selector, '--json']);
  assertVersion('0.15.4+codex.2');
  await inspect('prior installed');
  const repeated = cli(['plugin', 'add', selector, '--json']);
  assert.equal(repeated.installedPath, first.installedPath);
  assertVersion('0.15.4+codex.2');
  await inspect('repeat install');
  cli(['plugin', 'remove', selector, '--json']);
  assert.equal(installed().length, 0);
  await inspect('user removal retained');
  cli(['plugin', 'add', selector, '--json']);
  assertVersion('0.15.4+codex.2');
  await inspect('explicit reinstall');
  cli(['plugin', 'marketplace', 'add', candidate.root, '--json'], 1);
  assertVersion('0.15.4+codex.2');
  await inspect('different-root collision refused');
  cli(['plugin', 'remove', selector, '--json']);
  cli(['plugin', 'marketplace', 'remove', catalog.name, '--json']);
  assert.equal(installed().length, 0);
  await inspect('upgrade interruption after removal');
  cli(['plugin', 'marketplace', 'add', prior.root, '--json']);
  cli(['plugin', 'add', selector, '--json']);
  assertVersion('0.15.4+codex.2');
  await inspect('retained prior release restored');
  cli(['plugin', 'remove', selector, '--json']);
  cli(['plugin', 'marketplace', 'remove', catalog.name, '--json']);
  cli(['plugin', 'marketplace', 'add', candidate.root, '--json']);
  const next = cli(['plugin', 'add', selector, '--json']);
  assertVersion('0.15.5');
  const verifiedCurrent = await inspect('candidate installed');
  assert.equal(verifiedCurrent.state, 'installed-current');
  assert.equal(verifiedCurrent.readiness, 'current-verified');
  const configPath = join(codexHome, 'config.toml');
  const config = await readFile(configPath, 'utf8');
  const pluginBlock = `[plugins.\"${selector}\"]\nenabled = true`;
  assert(config.includes(pluginBlock), 'Unexpected native plugin config shape');
  const disabledConfig = config.replace(
    pluginBlock,
    `[plugins.\"${selector}\"]\nenabled = false`,
  );
  await writeFile(configPath, disabledConfig);
  const disabled = await inspect('explicitly disabled current plugin');
  assert.equal(disabled.state, 'disabled-current');
  assert.equal(disabled.readiness, 'explicit-reinstall-required');
  assert.deepEqual(disabled.commands.install, []);
  assert.deepEqual(disabled.commands.upgrade, []);
  assert.equal(
    await readFile(configPath, 'utf8'),
    disabledConfig,
    'Inspector changed user enablement',
  );
  cli(['plugin', 'remove', selector, '--json']);
  cli(['plugin', 'add', selector, '--json']);
  assertVersion('0.15.5');
  await inspect('explicit reinstall after disablement');
  assert(
    isAbsolute(next.installedPath),
    'Native installed cache path is missing',
  );
  const cache = next.installedPath;
  assert((await lstat(cache)).isDirectory());
  assert.equal(
    sha256(await readFile(join(cache, 'public-entry-manifest.json'))),
    candidate.manifestSha256,
  );
  const skills = (await readdir(join(cache, 'skills'))).sort();
  assert.deepEqual(skills, [
    'closeout',
    'poteto-mode',
    'qa-review-verification',
    'qa-triage',
    'temari',
    'temari-knowledge',
  ]);
  const method = JSON.parse(
    await readFile(join(cache, 'method/pstack/catalog.json'), 'utf8'),
  );
  assert.deepEqual(
    [
      method.skills.length,
      method.principles.length,
      method.playbooks.length,
      method.agents.length,
    ],
    [53, 23, 24, 3],
  );
  const publicPolicy = JSON.parse(
    await readFile(join(cache, 'policy.json'), 'utf8'),
  );
  const priorPolicy = JSON.parse(
    await readFile(join(prior.root, 'plugins/temari/policy.json'), 'utf8'),
  );
  assert.deepEqual(
    publicPolicy,
    priorPolicy,
    'Public admission changed during installation work',
  );
  for (const entry of ['temari', 'poteto-mode', 'closeout']) {
    const result = command(
      process.execPath,
      [join(cache, `bin/${entry}.mjs`), 'policy'],
      env,
    );
    assert.equal(result.status, 'described');
  }
  const standalone = command(
    process.execPath,
    [
      join(candidate.root, 'temari-release-verify.mjs'),
      '--root',
      candidate.root,
      '--expected-release-sha256',
      candidate.releaseSha256,
      '--expected-manifest-sha256',
      candidate.manifestSha256,
    ],
    env,
  );
  records.push({
    at: new Date().toISOString(),
    result: 'PASS',
    cache,
    skills,
    method,
    standalone,
    scope:
      'native local CLI installation only; no desktop activation or canonical workflow closeout',
  });
  await retain();
  console.log(
    JSON.stringify(
      { status: 'PASS', journal, cache, skills, releaseVersion: '0.15.5' },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  records.push({
    at: new Date().toISOString(),
    result: 'FAIL',
    error: error.message,
  });
  await retain();
  console.error(error.message);
  process.exitCode = 1;
}
