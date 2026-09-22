import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { KnowledgeSource } from '@temari/contracts';
import type { LocalRegistrarOptions } from '../lib/registrar.js';
import { hash, object, text } from '../lib/codec.js';

export async function prepareRegistrar(options: { readonly python: string; readonly registrarSource: string;
  readonly documents: readonly { readonly path: string; readonly bytes: Uint8Array; readonly origin?: string; readonly sha256?: string }[];
}): Promise<{ readonly base: string; readonly config: LocalRegistrarOptions; readonly source: KnowledgeSource }> {
  assert(isAbsolute(options.python) && isAbsolute(options.registrarSource));
  assert(options.documents.length > 0 && options.documents.length <= 32);
  const names = new Set<string>();
  for (const doc of options.documents) {
    assert(!isAbsolute(doc.path) && !doc.path.split(/[\\/]/).some(p => ['', '.', '..'].includes(p)) && !names.has(doc.path));
    names.add(doc.path); assert(/\.(txt|md|markdown)$/.test(doc.path));
    if (doc.sha256) assert.equal(hash(doc.bytes), doc.sha256, 'Snapshot hash differs from manifest');
  }
  const base = await mkdtemp(join(await realpath(tmpdir()), 'temari-knowledge-'));
  const state = join(base, 'state'), root = join(base, 'sources');
  await mkdir(state); await mkdir(root); await mkdir(join(base, 'task'));
  for (const doc of options.documents) {
    const path = join(root, doc.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, doc.bytes, { flag: 'wx', mode: 0o600 });
  }
  const { stdout } = await promisify(execFile)(options.python,
    ['-B', fileURLToPath(new URL('./prepare.py', import.meta.url)), state, root], {
      timeout: 60000, maxBuffer: 1_048_576,
      env: { PYTHONPATH: join(options.registrarSource, 'src'), PYTHONDONTWRITEBYTECODE: '1', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    });
  const setup = object(JSON.parse(stdout)), sourceId = text(setup['sourceId']);
  const instance = `temari-isolated-${sourceId}`;
  const preparation = join(base, 'preparation.json');
  await writeFile(preparation, JSON.stringify({ kind: 'temari-knowledge-isolated', schema: 1, state, root,
    sourceId, instance, receipt: setup['receipt'], documents: options.documents.map(d => ({ path: d.path,
      origin: d.origin ?? 'synthetic test input', sha256: hash(d.bytes) })), originalCurrency: 'not-established-by-snapshot-revalidation' }, null, 2), { flag: 'wx' });
  return { base, config: { python: options.python, registrarSource: options.registrarSource, preparation, readScope: 'source-root' },
    source: { provider: instance, id: sourceId, locator: pathToFileURL(root).href } };
}
