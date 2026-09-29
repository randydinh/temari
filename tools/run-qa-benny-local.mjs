import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { createLocalCategorySearchControl } from '../libs/host-adapters/src/index.ts';
import { FileEvidenceStore } from '../libs/runtime/src/index.ts';
import { runQaCategorySearchReproduction } from '../libs/temari-core/src/index.ts';

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !['--request', '--evidence-root', '--base-url'].includes(flag) ||
      !value ||
      values.has(flag)
    ) {
      throw new Error(
        'Usage: run-qa-benny-local.mjs --request ABSOLUTE_JSON --evidence-root ABSOLUTE_DIRECTORY --base-url http://127.0.0.1:PORT/',
      );
    }
    values.set(flag, value);
  }
  if (values.size !== 3) {
    throw new Error(
      'The local QA request, evidence root and base URL are required.',
    );
  }
  if (
    !isAbsolute(values.get('--request')) ||
    !isAbsolute(values.get('--evidence-root'))
  ) {
    throw new Error('Request and evidence-root paths must be absolute.');
  }
  return {
    requestPath: values.get('--request'),
    evidenceRoot: values.get('--evidence-root'),
    baseUrl: values.get('--base-url'),
  };
}

const options = argumentsFrom(process.argv.slice(2));
const request = JSON.parse(await readFile(options.requestPath, 'utf8'));
const control = createLocalCategorySearchControl({ baseUrl: options.baseUrl });
const evidence = await FileEvidenceStore.create(options.evidenceRoot);
const result = await runQaCategorySearchReproduction(
  request,
  control,
  evidence,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.verdict === 'Blocked') process.exitCode = 2;
