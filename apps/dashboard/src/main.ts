import { runTaskCommand } from '../../../tools/task-continuity.mjs';

try {
  const result = await runTaskCommand(process.argv.slice(2));
  console.log(
    result && typeof result === 'object' && 'help' in result
      ? result.help
      : JSON.stringify(result, null, 2),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
