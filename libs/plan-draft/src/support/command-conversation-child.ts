import { lstat, readFile, readdir } from 'node:fs/promises';
import { memoryFixture } from '../../../knowledge/src/support/fixtures.js';
import {
  createCommandJudgments,
  createConversationPlanDraft,
  type CommandJudgmentConfiguration,
  type ConversationDraftIntent,
} from '../index.js';

const [mode, manifest] = process.argv.slice(2);
const saved = JSON.parse(await readFile(manifest, 'utf8')) as {
  intent: ConversationDraftIntent;
  contents: [string, string][];
  configuration: CommandJudgmentConfiguration;
};
const { intent } = saved;
const memory = await memoryFixture();
memory.contents.clear();
saved.contents.forEach(([key, value]) => memory.contents.set(key, value));
const provider = {
  ...memory.provider,
  revalidate: async (
    evidence: Parameters<typeof memory.provider.revalidate>[0],
  ) => {
    if (
      mode === 'prepared-crash' &&
      !(await lstat(intent.destination).catch(() => null)) &&
      (await readdir(intent.task.directory)).some((name) =>
        name.endsWith('-prepared.json'),
      )
    )
      process.exit(73);
    return memory.provider.revalidate(evidence);
  },
};
const result = await createConversationPlanDraft(
  mode === 'resume'
    ? { kind: 'resume', task: intent.task, destination: intent.destination }
    : { kind: 'start', intent },
  { provider, ...createCommandJudgments(saved.configuration) },
);
process.stdout.write(JSON.stringify(result));
