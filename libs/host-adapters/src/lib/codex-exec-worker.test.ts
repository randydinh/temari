import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCodexExecWorker,
  resolveCodexExecutable,
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

test('missing executable fails before process launch', async () => {
  await assert.rejects(
    () => resolveCodexExecutable('/no/such/codex-executable'),
    /missing or not executable/,
  );
});
