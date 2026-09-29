import type {
  ExecutionPlan,
  HostCapabilityReport,
  WorkflowReceipt,
} from '@temari/contracts';
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

export interface TemporalControlInput {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
}

export type TemporalControlPhase = 'waiting' | 'running' | 'completed';

interface ControlActivities {
  executeCanonical(input: TemporalControlInput): Promise<WorkflowReceipt>;
}

const activities = proxyActivities<ControlActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export const releaseControl = defineSignal('temari-nx-release-control');
export const readControlPhase = defineQuery<TemporalControlPhase>(
  'temari-nx-control-phase',
);

/** Temporal retains the wait; the existing engine alone owns stage semantics. */
export async function temporalControlWorkflow(
  input: TemporalControlInput,
): Promise<WorkflowReceipt> {
  if (input.runId !== workflowInfo().workflowId) {
    throw new Error('Control run ID differs from the Temporal workflow ID.');
  }
  let phase: TemporalControlPhase = 'waiting';
  let released = false;
  setHandler(releaseControl, () => {
    released = true;
  });
  setHandler(readControlPhase, () => phase);
  await condition(() => released);
  phase = 'running';
  const receipt = await activities.executeCanonical(input);
  phase = 'completed';
  return receipt;
}
