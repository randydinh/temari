import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { checkPublicEntryArtifact, manifestSha256, packagePublicEntries } from './public-entry-runtime.mjs';

const run = promisify(execFile);

test('area entry uses the real Registrar with separate search, identities and read-only MCP', async (t) => {
  const providerHome = process.env.TEMARI_KNOWLEDGE_TEST_HOME;
  assert(providerHome && isAbsolute(providerHome),
    'Select an existing installed provider with TEMARI_KNOWLEDGE_TEST_HOME; no personal registry is used.');
  const root = await mkdtemp(join(tmpdir(), 'temari-area-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  const home = join(root, 'state');
  const manifest = await packagePublicEntries(artifact);
  await checkPublicEntryArtifact(artifact, manifestSha256(manifest));
  await mkdir(home);
  const launcher = join(artifact, 'bin', 'temari-knowledge.mjs');
  await symlink(join(providerHome, 'venv'), join(home, 'venv'));
  await cp(join(providerHome, 'installation.json'), join(home, 'installation.json'));
  await cp(join(providerHome, 'provider-selection.json'), join(home, 'provider-selection.json'));
  const command = async (args) => {
    const result = await run(process.execPath, [launcher, 'area', ...args, '--home', home],
      { timeout: 30000, maxBuffer: 1048576 });
    return JSON.parse(result.stdout);
  };
  const cold = await command(['status', '--area', 'work']);
  assert.equal(cold.initialized, false);
  assert.equal(cold.legacyIncluded, false);
  await assert.rejects(readFile(join(home, 'areas', 'work', 'workspace', 'registry.sqlite3')), { code: 'ENOENT' });
  const python = join(providerHome, 'venv', 'bin', 'python');
  const legacyDocs = join(root, 'legacy-docs');
  await mkdir(legacyDocs);
  await writeFile(join(legacyDocs, 'notes.md'), 'partitionmarker legacyonly\n');
  const legacyCommand = async (args) => JSON.parse((await run(python,
    ['-m', 'knowledge_agent.cli', 'sources', '--workspace', join(home, 'workspace'), ...args],
    { timeout: 30000, maxBuffer: 1048576 })).stdout);
  const legacySource = await legacyCommand(['add', legacyDocs]);
  await legacyCommand(['refresh', legacySource.id]);
  assert.match(JSON.stringify(await legacyCommand(['search', 'partitionmarker'])), /legacyonly/);
  const sources = {};
  for (const area of ['work', 'personal']) {
    await assert.rejects(command(['sources', '--area', area, 'search', 'partitionmarker']),
      (error) => {
        assert.equal(error.code, 2);
        const empty = JSON.parse(error.stdout);
        assert.equal(empty.status, 'partial');
        assert.deepEqual(empty.records, []);
        assert.deepEqual(empty.sources, []);
        assert.doesNotMatch(JSON.stringify(empty), /legacyonly|workonly|personalonly/);
        return true;
      });
    assert.equal((await command(['sources', '--area', area, 'list'])).sources.length, 0);
    const docs = join(root, area);
    await mkdir(docs);
    await writeFile(join(docs, 'notes.md'), `partitionmarker ${area}only\n`);
    sources[area] = await command(['sources', '--area', area, 'add', docs]);
    await command(['sources', '--area', area, 'refresh', sources[area].id]);
    const found = await command(['sources', '--area', area, 'search', 'partitionmarker']);
    assert.match(JSON.stringify(found), new RegExp(`${area}only`));
    assert.doesNotMatch(JSON.stringify(found), /legacyonly/);
    assert.doesNotMatch(JSON.stringify(found), new RegExp(`${area === 'work' ? 'personal' : 'work'}only`));
    assert.equal((await command(['sources', '--area', area, 'list'])).sources.length, 1);
  }
  await assert.rejects(command(['sources', '--area', 'personal', 'read', sources.work.id, 'notes.md']),
    (error) => error.code === 2 && JSON.parse(error.stdout).error === 'unknown source ID');
  for (const args of [
    ['sources', 'list'], ['status', '--area', 'both'],
    ['status', '--area', 'work', '--area', 'personal'],
    ['status', '--area', 'work', '--workspace', root],
    ['status', '--area', 'work', '--workspace=' + root],
  ]) await assert.rejects(command(args));
  assert.match(JSON.stringify(await legacyCommand(['search', 'partitionmarker'])), /legacyonly/);
  await assert.rejects(command(['mcp', '--area', 'work']), /Area MCP requires --source/);
  for (const layer of ['areas', 'personal', 'workspace']) {
    const aliasHome = join(root, `alias-${layer}`);
    const linkPath = layer === 'areas' ? join(aliasHome, 'areas') :
      layer === 'personal' ? join(aliasHome, 'areas', 'personal') :
        join(aliasHome, 'areas', 'personal', 'workspace');
    const target = layer === 'areas' ? join(home, 'areas') :
      layer === 'personal' ? join(home, 'areas', 'work') :
        join(home, 'areas', 'work', 'workspace');
    await mkdir(join(linkPath, '..'), { recursive: true });
    await symlink(target, linkPath);
    await assert.rejects(run(process.execPath,
      [launcher, 'area', 'status', '--area', 'personal', '--home', aliasHome]),
    /separate regular directories/);
  }
  const excludedDocs = join(root, 'work-excluded');
  await mkdir(excludedDocs);
  await writeFile(join(excludedDocs, 'notes.md'), 'partitionmarker excludedworkonly\n');
  const excluded = await command(['sources', '--area', 'work', 'add', excludedDocs]);
  await command(['sources', '--area', 'work', 'refresh', excluded.id]);
  await run(python, ['-c', `
import asyncio, json, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def check():
    params = StdioServerParameters(command=sys.argv[1], args=[sys.argv[2], 'area', 'mcp', '--area', 'work', '--home', sys.argv[3], '--source', sys.argv[4]])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            tools = await client.list_tools()
            assert 'source_add' not in [tool.name for tool in tools.tools]
            found = await client.call_tool('knowledge_discover', {'query': 'partitionmarker'})
            assert not found.is_error
            assert sys.argv[6] not in json.dumps(found.model_dump(mode='json'))
            found = await client.call_tool('knowledge_read', {'source_id': sys.argv[4], 'path': 'notes.md'})
            value = json.dumps(found.model_dump(mode='json'))
            assert 'workonly' in value, value
            assert 'personalonly' not in value, value
            for source_id in [sys.argv[5], sys.argv[6]]:
                refused = await client.call_tool('knowledge_read', {'source_id': source_id, 'path': 'notes.md'})
                assert refused.is_error
asyncio.run(check())
`, process.execPath, launcher, home, sources.work.id, sources.personal.id, excluded.id], { timeout: 30000, maxBuffer: 1048576 });
});
