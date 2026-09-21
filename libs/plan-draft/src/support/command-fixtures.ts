import { copyFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandJudgmentConfiguration,
  CommandJudgmentRole,
  JudgmentRole,
} from '../index.js';
import { sha256 } from '../lib/data.js';

const wrapper = fileURLToPath(
  new URL('./command-judgment.mjs', import.meta.url),
);
const executable = await realpath(process.execPath);
const executableHash = sha256(await readFile(executable));

export async function commandConfiguration(
  directory: string,
  modes: Partial<Record<JudgmentRole, string>> = {},
): Promise<CommandJudgmentConfiguration> {
  const script = join(directory, 'judgment.mjs');
  await copyFile(wrapper, script);
  const scriptHash = sha256(await readFile(script));
  const role = (name: JudgmentRole): CommandJudgmentRole => ({
    executable,
    args: [
      script,
      modes[name] ?? 'valid',
      join(directory, 'command-events.jsonl'),
      'literal $(touch never) ; *',
    ],
    cwd: directory,
    environment: { FIXTURE_DECLARED: 'nonsecret' },
    artifacts: { [executable]: executableHash, [script]: scriptHash },
    behaviorRevision: 'synthetic-v1',
    service: { id: 'synthetic-local', configurationRevision: 'fixture-v1' },
    timeoutMs: 5000,
  });
  return {
    instance: 'synthetic-command-fixture',
    roles: {
      assess: role('assess'),
      propose: role('propose'),
      review: role('review'),
    },
  };
}

export async function commandEvents(directory: string) {
  const body = await readFile(
    join(directory, 'command-events.jsonl'),
    'utf8',
  ).catch(() => '');
  return body.trim()
    ? body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
