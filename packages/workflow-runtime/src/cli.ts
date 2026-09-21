import {
  checkArtifact,
  checkPayload,
  packageRuntime,
  payloadRoot,
  readInventory,
} from './lib/workflow-runtime.js';

const usage =
  'Usage: workflow-runtime check [--artifact ABSOLUTE_PATH --lane portable|archon] | package [--lane portable|archon] [--output ABSOLUTE_PATH]';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command !== 'check' && command !== 'package') throw new Error(usage);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--lane', '--output', '--artifact'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    )
      throw new Error(usage);
    options.set(key, value);
  }
  const lane = options.get('--lane') ?? 'portable';
  if (lane !== 'portable' && lane !== 'archon')
    throw new Error('Lane must be portable or archon');
  if (command === 'package') {
    if (options.has('--artifact')) throw new Error(usage);
    console.log(
      JSON.stringify(await packageRuntime(lane, options.get('--output'))),
    );
  } else {
    if (options.has('--output')) throw new Error(usage);
    const inventory = await readInventory();
    const artifact = options.get('--artifact');
    if (artifact) await checkArtifact(artifact, inventory, lane);
    else await checkPayload(payloadRoot, inventory.files);
    console.log(
      JSON.stringify({
        status: 'passed',
        scope: artifact ?? payloadRoot,
        lane: artifact ? lane : 'all',
        inventoryFiles: inventory.files.length,
      }),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
