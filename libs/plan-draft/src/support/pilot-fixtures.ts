import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeSource } from '@temari/contracts';
import { inputFor } from '../../../knowledge/src/support/fixtures.js';
import type {
  ConversationDraftIntent,
  ConversationDraftOutcome,
} from '../index.js';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = 'libs/plan-draft/src/pilot.ts';

export function runPilot(args: string[], imports: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      ...imports.flatMap((path) => ['--import', path]),
      '--import',
      '@swc-node/register/esm-register',
      entry,
      ...args,
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

export function runPilotNx(args: string[]) {
  const result = spawnSync(
    'pnpm',
    ['nx', 'run', 'plan-draft:pilot', '--output-style=static', '--', ...args],
    {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        NX_DAEMON: 'false',
        NX_ISOLATE_PLUGINS: 'false',
        NX_NO_CLOUD: 'true',
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

export function outcome(stdout: string): ConversationDraftOutcome {
  return JSON.parse(stdout);
}

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function pilotIntent(
  source: KnowledgeSource,
  directory: string,
): Promise<ConversationDraftIntent> {
  const base = inputFor(source, directory);
  const path = join(directory, 'authority.json');
  const task = { ...base.task, authorityRef: path };
  const destination = join(directory, 'draft.md');
  const authority = JSON.stringify({
    schema: 1,
    operation: 'create-local-plan-draft',
    taskId: task.id,
    taskDirectory: directory,
    destination,
    taskEvidence: true,
  });
  await writeFile(path, authority, { flag: 'wx' });
  return {
    task,
    destination,
    title: 'Proposed pilot draft',
    authority: { path, sha256: digest(authority) },
    brief: { ...base.brief, verificationCommand: null },
    request: {
      ...base.request,
      budget: { ...base.request.budget, documentsPerPage: 10 },
    },
  };
}
