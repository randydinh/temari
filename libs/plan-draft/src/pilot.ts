import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createLocalRegistrar } from '@temari/knowledge';
import {
  createCommandJudgments,
  createConversationPlanDraft,
} from './index.js';
import { decodePilotConfiguration } from './pilot-config.js';

const help = `Usage: pnpm nx run plan-draft:pilot -- --config=/absolute/file.json
Direct: node --import @swc-node/register/esm-register libs/plan-draft/src/pilot.ts --config /absolute/file.json

The schema-1 JSON envelope contains registrar, judgments, and a start or resume command.
Supply prepared Registrar state and explicitly configured judgment commands.
JSON uses JSON.parse semantics, including last-member handling of duplicate keys.
Direct execution writes the complete outcome JSON to stdout and guidance to stderr.
Exit codes: 0 for help or draft PASS, 2 for other returned outcomes, 1 for entry failure.
Synthetic checks do not prove live semantics. Raw exchanges and launch attestation are not captured.
`;

async function main(): Promise<void> {
  let failure =
    'Pilot arguments: expected only --config with an absolute JSON file, or --help.';
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
      process.stdout.write(help);
      return;
    }
    const path =
      args.length === 2 && args[0] === '--config'
        ? args[1]
        : args.length === 1 && args[0].startsWith('--config=')
          ? args[0].slice('--config='.length)
          : '';
    if (!isAbsolute(path) || path.includes('\0')) throw new Error();

    failure =
      'Pilot config: expected a readable regular file of at most 1 MiB.';
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!(await file.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === buffer.length) throw new Error();
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    failure = 'Pilot config: expected valid UTF-8 JSON.';
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    failure = 'Pilot config: invalid schema-1 configuration shape.';
    const config = decodePilotConfiguration(value);

    failure = 'Pilot judgments: configuration rejected.';
    const judgments = createCommandJudgments(config.judgments);
    failure =
      'Pilot Registrar: construction failed; check the explicit prepared configuration.';
    const provider = await createLocalRegistrar(config.registrar);
    failure = 'Pilot entry: conversation execution failed unexpectedly.';
    const outcome = await createConversationPlanDraft(config.command, {
      provider,
      ...judgments,
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    const result = outcome.kind === 'draft' ? outcome.draft : outcome.result;
    process.stderr.write(
      `Investigation: ${outcome.investigation?.status ?? 'not returned'}; ${outcome.kind}: ${result.status}\n`,
    );
    process.stderr.write(
      `Checkpoint: ${JSON.stringify(outcome.checkpointPath)}\nEvidence: ${JSON.stringify(result.evidencePaths)}\n`,
    );
    process.exitCode =
      outcome.kind === 'draft' && outcome.draft.status === 'PASS' ? 0 : 2;
  } catch {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
}

await main();
