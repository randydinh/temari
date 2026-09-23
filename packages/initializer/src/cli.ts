import {
  doctor,
  formatInitialization,
  formatReport,
  initialize,
} from './lib/initializer.js';

interface CliOptions {
  readonly command: 'init' | 'doctor';
  readonly workspaceRoot?: string;
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage: temari <init|doctor> [--workspace <path>] [--json]',
    '',
    'init     install locked dependencies, provision pinned Archon, and write a receipt',
    'doctor   verify tools, lockfiles, and the managed Archon runtime without installing',
  ].join('\n');
}

function parseArgs(args: readonly string[]): CliOptions {
  const command = args[0] ?? 'doctor';
  if (command !== 'init' && command !== 'doctor') {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  let workspaceRoot: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--workspace') {
      const value = args[index + 1];
      if (!value) throw new Error('--workspace requires a path.');
      workspaceRoot = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  return { command, workspaceRoot, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'doctor') {
    const report = await doctor({ workspaceRoot: options.workspaceRoot });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatReport(report),
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const result = await initialize({ workspaceRoot: options.workspaceRoot });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatInitialization(result),
  );
  if (result.receipt.status !== 'SUCCEEDED') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Temari initializer error: ${message}\n`);
  process.exitCode = 1;
});
