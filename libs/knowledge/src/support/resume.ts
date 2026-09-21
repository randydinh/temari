import { readFile } from 'node:fs/promises';
import { createLocalRegistrar } from '../lib/registrar.js';
import {
  investigateDesignUpdate,
  loadInvestigation,
} from '../lib/investigation.js';

const { config, resumeFrom } = JSON.parse(
  await readFile(process.argv[2], 'utf8'),
);
const previous = await loadInvestigation(resumeFrom);
const result = await investigateDesignUpdate({
  task: previous.task,
  brief: previous.trustedBrief,
  request: previous.request,
  provider: await createLocalRegistrar(config),
  resumeFrom,
  assess: async () => {
    throw new Error('DUPLICATE ASSESSMENT IN FRESH PROCESS');
  },
});
process.stdout.write(JSON.stringify(result));
