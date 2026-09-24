import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reconcilePlan,
  type HostCapabilityReport,
  type WorkflowStageId,
} from '@temari/contracts';
import {
  runPlanWithReceipt,
  type StageReceiptResult,
} from '../lib/workflow-engine.js';

interface FacilitiesIncident {
  readonly id: string;
  readonly title: string;
  readonly impact: string;
  readonly signal: string;
  readonly objective: string;
  readonly owner: string;
  readonly guardrails: readonly string[];
}

interface DemoOutput {
  readonly scenario: FacilitiesIncident;
  readonly plan: ReturnType<typeof reconcilePlan>;
  readonly capabilities: HostCapabilityReport;
  readonly receipt: Awaited<ReturnType<typeof runPlanWithReceipt>>;
  readonly evidenceDirectory: string;
}

const SCENARIO: FacilitiesIncident = Object.freeze({
  id: 'FAC-2026-09-24-001',
  title: 'AHU-4 stopped serving the third-floor operating suite',
  impact: 'Operating-room temperature is trending toward the approved limit.',
  signal:
    'The building-management system reported an air-handler fault and a rising temperature trend.',
  objective:
    'Restore airflow safely, protect affected rooms, and retain a reviewable handoff.',
  owner: 'Site operations manager',
  guardrails: [
    'Do not change control setpoints without an authorized facilities decision.',
    'Escalate clinical impact before the temperature limit is crossed.',
    'Close the incident only after the restore check has evidence.',
  ],
});

const STAGE_RESULTS: Readonly<Record<WorkflowStageId, StageReceiptResult>> = {
  investigate: {
    status: 'PASS',
    summary:
      'Correlated the alarm, temperature trend, affected rooms, and current owner. Unknowns remain visible.',
  },
  plan: {
    status: 'PASS',
    summary:
      'Sequenced sensor verification, HVAC dispatch, room protection, escalation, and the restore check.',
  },
  build: {
    status: 'PASS',
    summary:
      'Prepared an operator checklist with owners, guardrails, and the evidence needed for closeout.',
  },
  review: {
    status: 'PASS',
    summary:
      'The coordinator reviewed the scope against the stated safety guardrails in serial mode.',
  },
  verify: {
    status: 'PASS',
    summary:
      'Defined the restore proof as stable telemetry, acceptable room conditions, and owner acknowledgment.',
  },
  deliver: {
    status: 'PASS',
    summary:
      'Published a bounded handoff with the current owner, open unknowns, and the next review point.',
  },
};

const HELP = `Facilities uptime demo

Run with:
  pnpm nx run workflow-engine:demo
  pnpm nx run workflow-engine:demo -- --json

This is a deterministic walkthrough. It does not connect to a building-management system,
dispatch a vendor, change a control setpoint, or make a clinical decision.`;

function serialCapabilities(): HostCapabilityReport {
  return {
    host: 'local-serial-demo',
    available: [],
    missing: [],
    notes: {
      subagents: 'Not requested by this walkthrough.',
      parallelism: 'Not requested by this walkthrough.',
    },
  };
}

async function writeEvidence(
  directory: string,
  stage: WorkflowStageId,
  summary: string,
): Promise<string> {
  const path = join(directory, `${stage}.md`);
  await writeFile(
    path,
    [
      `# ${stage}`,
      '',
      `Incident: ${SCENARIO.id}`,
      `Owner: ${SCENARIO.owner}`,
      '',
      'Guardrails:',
      ...SCENARIO.guardrails.map((guardrail) => `- ${guardrail}`),
      '',
      summary,
      '',
      'Synthetic evidence for the facilities uptime walkthrough.',
    ].join('\n'),
    'utf8',
  );
  return path;
}

async function runDemo(): Promise<DemoOutput> {
  const plan = reconcilePlan({
    workType: 'investigation',
    evidence: 'revision-bound',
    delivery: 'local',
  });
  const capabilities = serialCapabilities();
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), 'temari-facilities-uptime-'),
  );
  const receipt = await runPlanWithReceipt({
    runId: SCENARIO.id,
    revision: 'synthetic-facilities-demo-v1',
    plan,
    capabilities,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    handler: async (stage) => {
      const result = STAGE_RESULTS[stage];
      const evidencePath = await writeEvidence(
        evidenceDirectory,
        stage,
        result.summary,
      );
      return { ...result, evidencePaths: [evidencePath] };
    },
  });

  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.stages.length, 6);
  for (const stage of receipt.stages) {
    const evidencePath = stage.evidencePaths[0];
    assert(evidencePath);
    assert((await readFile(evidencePath, 'utf8')).includes(SCENARIO.id));
  }

  return { scenario: SCENARIO, plan, capabilities, receipt, evidenceDirectory };
}

function printHuman(output: DemoOutput): void {
  const { scenario, plan, capabilities, receipt } = output;
  console.log('Temari facilities uptime demo');
  console.log(`Scenario: ${scenario.title}`);
  console.log(`Impact: ${scenario.impact}`);
  console.log(`Signal: ${scenario.signal}`);
  console.log(`Objective: ${scenario.objective}`);
  console.log(`Owner: ${scenario.owner}`);
  console.log('Guardrails:');
  for (const guardrail of scenario.guardrails) console.log(`  - ${guardrail}`);
  console.log('');
  console.log(
    `Plan: ${plan.workType}, ${plan.evidence} evidence, ${plan.delivery} delivery`,
  );
  console.log(`Host mode: ${capabilities.host} with no delegated workers`);
  console.log('');
  for (const stage of receipt.stages) {
    console.log(
      `  ${stage.stage.padEnd(11)} ${stage.status}  ${stage.summary}`,
    );
  }
  console.log('');
  console.log(`Result: ${receipt.status}`);
  console.log(`Run: ${receipt.runId}`);
  console.log(`Evidence: ${output.evidenceDirectory}`);
  console.log('No live facility system was queried or changed.');
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2).filter((arg) => arg !== '--'));
  if (args.has('--help')) {
    console.log(HELP);
    return;
  }
  const output = await runDemo();
  if (args.has('--json')) console.log(JSON.stringify(output, null, 2));
  else printHuman(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { runDemo };
