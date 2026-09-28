import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRuntime } from '../packages/workflow-runtime/src/lib/workflow-runtime.ts';

async function bun(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn('bun', args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Bun verification exited ${code}.`)),
    );
  });
}

const root = await mkdtemp(join(tmpdir(), 'temari-native-regression-'));
try {
  const artifact = await packageRuntime('archon', join(root, 'runtime'));
  await bun(
    ['install', '--frozen-lockfile', '--production', '--ignore-scripts'],
    join(artifact.root, 'skills/poteto-mode/scripts'),
  );
  await bun(
    [
      'test',
      'integrations/archon/live.test.ts',
      'integrations/archon/lifecycle.test.ts',
    ],
    artifact.root,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
