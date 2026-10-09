import { fileURLToPath } from 'node:url';
import { runDashboardLifecycleCommand } from './lifecycle.js';
import { runTaskCommand } from '../../../tools/task-continuity.mjs';
import { configureGoalPlannerSupervisor } from '../../../tools/dashboard-planner.mjs';

const managedWorkflowSource = fileURLToPath(
  new URL('./workflow-host', import.meta.url),
);
configureGoalPlannerSupervisor(
  fileURLToPath(
    new URL('./workflow-host/dashboard-planner.mjs', import.meta.url),
  ),
);
const task = (args: readonly string[]) =>
  runTaskCommand(args, { managedWorkflowSource });

try {
  const args = process.argv.slice(2);
  const result = await runDashboardLifecycleCommand(args, {
    executablePath: process.argv[1]!,
    managedWorkflowSource,
    runTaskCommand: task,
  });
  console.log(
    result && typeof result === 'object' && 'help' in result
      ? result.help
      : JSON.stringify(result, null, 2),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
