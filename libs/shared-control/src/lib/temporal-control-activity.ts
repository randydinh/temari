import {
  assertCanonicalStageSequence,
  runPlanWithReceipt,
} from '@temari/workflow-engine';
import type { TemporalControlInput } from './temporal-control-workflow.js';

/** Fixture activity for local service recovery, not a shared-control provider. */
export function createProofActivities(workerId: string) {
  return {
    async executeCanonical(input: TemporalControlInput) {
      assertCanonicalStageSequence(input.plan);
      return runPlanWithReceipt({
        ...input,
        handler: (stage) => ({
          status: 'PASS',
          summary: `${stage} handled by ${workerId}`,
        }),
      });
    },
  };
}
