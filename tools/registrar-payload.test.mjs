import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  REGISTRAR_PAYLOAD_FILES,
  REGISTRAR_PAYLOAD_ROOT,
  getRegistrarPayloadFileMap,
  verifyRegistrarPayload,
} from './registrar-payload.mjs';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'temari-registrar-payload-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'registrar');
  await cp(REGISTRAR_PAYLOAD_ROOT, root, { recursive: true });
  return root;
}

test('reviewed payload exposes a stable packager file map', async () => {
  const result = await verifyRegistrarPayload();
  const files = await getRegistrarPayloadFileMap();
  assert.equal(result.upstream.commit, '760926907669ae34bd1861732edbbf8f5afaf588');
  assert.equal(files.length, REGISTRAR_PAYLOAD_FILES.length);
  assert(files.some(({ path, source }) => path === 'src/knowledge_agent/mcp_server.py' &&
    source === 'packages/workflow-runtime/registrar/src/knowledge_agent/mcp_server.py'));
  assert(files.some(({ path }) => path === 'uv.lock'));
});

test('rejects modified source, added files, and altered manifest', async (t) => {
  await t.test('source hash', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'src/knowledge_agent/__init__.py'), '# changed\n');
    await assert.rejects(verifyRegistrarPayload(root), /hash drift/);
  });
  await t.test('extra file', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'src/knowledge_agent/extra.py'), 'pass\n');
    await assert.rejects(verifyRegistrarPayload(root), /inventory drift/);
  });
  await t.test('manifest', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'UPSTREAM.json'), '{}\n');
    await assert.rejects(verifyRegistrarPayload(root), /manifest differs/);
  });
});

test('rejects a symlink in the package tree', async (t) => {
  const root = await fixture(t);
  await symlink(join(root, 'pyproject.toml'), join(root, 'src/knowledge_agent/link.py'));
  await assert.rejects(verifyRegistrarPayload(root), /symlink/);
});
