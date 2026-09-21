import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { createLocalPlanDraft } from '../index.js';
import type { LocalPlanDraftInput } from '../index.js';
import { memoryFixture } from '../../../knowledge/src/support/fixtures.js';
import { approve } from './fixtures.js';

const [mode, path] = process.argv.slice(2);
assert(mode === 'crash' || mode === 'recover');
const saved = JSON.parse(await readFile(path, 'utf8')) as {
  input: LocalPlanDraftInput;
  contents: [string, string][];
};
const memory = await memoryFixture();
memory.contents.clear();
saved.contents.forEach(([key, value]) => memory.contents.set(key, value));
const revalidate = memory.provider.revalidate.bind(memory.provider);
const result = await createLocalPlanDraft({
  ...saved.input,
  provider: {
    ...memory.provider,
    async revalidate(evidence) {
      if (
        mode === 'crash' &&
        (await lstat(saved.input.destination).catch(() => null))?.isFile()
      )
        process.exit(73);
      return revalidate(evidence);
    },
  },
  reviewer: {
    ...saved.input.reviewer,
    review:
      mode === 'crash'
        ? approve
        : async () => {
            throw new Error('Recovery must reuse the pinned review');
          },
  },
});
process.stdout.write(JSON.stringify(result));
