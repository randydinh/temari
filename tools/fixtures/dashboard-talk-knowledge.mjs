import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function refreshTalkKnowledgeSource(python, workspace, sourceId) {
  await exec(python, [
    '-I',
    '-B',
    '-c',
    'import sys;from pathlib import Path;from knowledge_agent.source_registry import SourceRegistry;SourceRegistry(Path(sys.argv[1])).refresh(sys.argv[2])',
    workspace,
    sourceId,
  ]);
}
export async function prepareTalkKnowledge(root, python) {
  assert(python, 'Select the prepared Python with TEMARI_REGISTRAR_PYTHON.');
  const selected = await realpath(python);
  const allowedRoot = join(root, 'allowed-library');
  const deniedRoot = join(root, 'denied-library');
  const workspace = join(root, 'knowledge-registry');
  await mkdir(allowedRoot);
  await mkdir(deniedRoot);
  await writeFile(
    join(allowedRoot, 'welcome.md'),
    'Temari owns user intent. Archon executes native workflows.\n',
  );
  await writeFile(
    join(deniedRoot, 'private.md'),
    'Temari PRIVATE_SOURCE_MUST_NOT_LEAK.\n',
  );
  const seed = `import json,sys
from pathlib import Path
from knowledge_agent.source_registry import SourceRegistry
r=SourceRegistry(Path(sys.argv[1]));ids=[]
for path,label in [(sys.argv[2],'Allowed public library'),(sys.argv[3],'Denied source')]:
 s=r.add(path,label=label);r.set_sharing(s['id'],'local-only');r.refresh(s['id']);ids.append(s['id'])
print(json.dumps(ids))`;
  const result = await exec(python, [
    '-I',
    '-B',
    '-c',
    seed,
    workspace,
    allowedRoot,
    deniedRoot,
  ]);
  const [allowedSourceId, deniedSourceId] = JSON.parse(result.stdout);
  return {
    config: {
      python,
      pythonSha256: createHash('sha256')
        .update(await readFile(selected))
        .digest('hex'),
      workspace,
      sourceIds: [allowedSourceId],
    },
    allowedSourceId,
    deniedSourceId,
    allowedRoot,
    deniedRoot,
  };
}
