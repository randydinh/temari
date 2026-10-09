import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageManagedWorkflow(output) {
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, '.archon', 'workflows'), { recursive: true });
  await mkdir(join(output, 'owned-process'), { recursive: true });
  await Promise.all([
    build({
      entryPoints: [
        'packages/workflow-runtime/host/reviewed-local-candidate.mjs',
      ],
      outfile: join(output, 'reviewed-local-candidate.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
    }),
    build({
      entryPoints: ['tools/managed-candidate-operation.mts'],
      outfile: join(output, 'managed-candidate-operation.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
    }),
    build({
      entryPoints: ['tools/dashboard-planner.mts'],
      outfile: join(output, 'dashboard-planner.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
    }),
    copyFile(
      'packages/workflow-runtime/host/.archon/workflows/temari-reviewed-local-candidate.yaml',
      join(
        output,
        '.archon',
        'workflows',
        'temari-reviewed-local-candidate.yaml',
      ),
    ),
    copyFile(
      'libs/host-adapters/src/lib/owned-process/guardian.mjs',
      join(output, 'owned-process', 'guardian.mjs'),
    ),
    copyFile(
      'libs/host-adapters/src/lib/owned-process/anchor.mjs',
      join(output, 'owned-process', 'anchor.mjs'),
    ),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await packageManagedWorkflow(
    process.argv[2] ?? 'apps/dashboard/generated-workflow-host',
  );
