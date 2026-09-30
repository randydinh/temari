import {
  doctor,
  formatInitialization,
  formatReport,
  initialize,
} from './lib/initializer.js';
import { runLiveHostDoctor, type LiveDoctorHost } from '@temari/host-adapters';
import { platformInfo } from './lib/platform.js';

interface CliOptions {
  readonly command: 'init' | 'doctor';
  readonly workspaceRoot?: string;
  readonly json: boolean;
  readonly live: boolean;
  readonly host?: LiveDoctorHost;
}

function usage(): string {
  return [
    'Usage: temari <init|doctor> [--workspace <path>] [--json] [--live --host <codex|claude-code|cursor>]',
    '',
    'init     install locked dependencies, provision pinned Archon, and write a receipt',
    'doctor   verify tools, lockfiles, and Archon; --live runs an isolated host probe',
  ].join('\n');
}

function parseArgs(args: readonly string[]): CliOptions {
  const command = args[0] ?? 'doctor';
  if (command !== 'init' && command !== 'doctor') {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  let workspaceRoot: string | undefined;
  let json = false;
  let live = false;
  let host: LiveDoctorHost | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--live') {
      live = true;
      continue;
    }
    if (argument === '--host') {
      const value = args[index + 1];
      if (!value || !['codex', 'claude-code', 'cursor'].includes(value))
        throw new Error('--host requires codex, claude-code, or cursor.');
      host = value as LiveDoctorHost;
      index += 1;
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
  if (live && (command !== 'doctor' || !host))
    throw new Error('--live requires doctor and --host.');
  if (host && !live) throw new Error('--host requires --live.');
  return { command, workspaceRoot, json, live, host };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'doctor') {
    const report = await doctor({ workspaceRoot: options.workspaceRoot });
    if (options.live && options.host) {
      const live = await runLiveHostDoctor({
        host: options.host,
        dataDirectory: platformInfo().dataDirectory,
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ doctor: report, live }, null, 2)}\n`
          : `${formatReport(report)}host.${live.host}=${live.status.toLowerCase()} observed=${live.observedCapabilities.join(',') || 'none'} remaining=${live.unprovenCapabilities.join(',')} reason=${live.reason}\nproof=${live.runDirectory}/doctor-report.json\n`,
      );
      if (!report.ok || live.status !== 'OBSERVED') process.exitCode = 1;
      return;
    }
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
