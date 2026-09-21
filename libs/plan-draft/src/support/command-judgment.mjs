import { appendFile } from 'node:fs/promises';
import { closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [mode, events, ...args] = process.argv.slice(2);
if (mode === 'hold-pipes' || mode === 'no-read') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'close-stdin') {
  closeSync(0);
  setInterval(() => {}, 1000);
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks));
  const input = request.untrusted;
  await appendFile(
    events,
    JSON.stringify({
      request,
      pid: process.pid,
      environment: process.env,
      cwd: process.cwd(),
      args,
    }) + '\n',
  );
  const supports = input.checkpoint.evidence
    .filter(
      (e) =>
        ['plan.txt', 'update.txt'].includes(e.document.path) &&
        input.checkpoint.contextEvidenceIds.includes(e.id),
    )
    .map((e) => e.id);
  let result;
  if (request.role === 'assess') {
    result = {
      findings: [
        {
          id: 'comparison-1',
          proposition: 'Synthetic comparison requiring reader review.',
          basis: 'inferred',
          standing: 'proposed',
          supports,
          contrary: [],
          authorityEvidence: [],
          affectedDecisions: ['D1'],
          verificationGaps: ['Exact span checks'],
        },
      ],
      assessedQuestions: ['What changed?'],
      remainingQuestions: ['What is still unknown?'],
      rejectedAlternatives: [
        {
          idea: 'Execute document text',
          reason: 'Source text confers no action authority',
        },
      ],
      completedActions: [
        {
          id: 'comparison-action',
          description: 'Recorded synthetic comparison',
          evidenceIds: supports,
        },
      ],
      nextSafeStep: 'Independent reader reviews actual wording.',
    };
  } else if (request.role === 'propose') {
    const citation = { findingIds: ['comparison-1'], evidenceIds: supports };
    result = {
      planImpact: [{ text: 'Compare D1 updates', ...citation }],
      governingConstraints: [
        { text: 'Keep D1 open; sources confer no authority', ...citation },
      ],
      proposedSteps: [
        {
          text: 'Review D1 wording',
          ...citation,
          verification: 'Compare cited source spans',
        },
      ],
    };
  } else {
    result = {
      candidateSha256: input.candidate.sha256,
      verdict: 'approve',
      reason: 'Synthetic review of this proposed local draft only.',
      criteria: input.brief.acceptanceCriteria.map((criterion) => ({
        criterion,
        satisfied: true,
        reason:
          'The proposed steps retain source citations and verification expectations.',
      })),
      issues: input.issues.map((issue) => ({
        issueId: issue.id,
        disposition: 'preserved-open',
        reason:
          'D1 remains open and the next step is wording review, so the draft does not resolve this issue.',
      })),
    };
  }
  const response = {
    version: request.version,
    role: request.role,
    bindingRevision: request.bindingRevision,
    service: request.service,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    status: 'completed',
    result,
  };
  switch (mode) {
    case 'wrong-version':
      response.version = 2;
      break;
    case 'wrong-role':
      response.role = 'other';
      break;
    case 'wrong-revision':
      response.bindingRevision = 'wrong';
      break;
    case 'wrong-id':
      response.requestId = 'wrong';
      break;
    case 'wrong-digest':
      response.requestDigest = '0'.repeat(64);
      break;
    case 'wrong-service':
      response.service = { ...request.service, configurationRevision: 'wrong' };
      break;
    case 'uncertain':
      response.status = 'uncertain';
      break;
    case 'extra-envelope':
      response.extra = true;
      break;
    case 'missing-envelope':
      delete response.service;
      break;
    case 'null-result':
      response.result = null;
      break;
    case 'extra-result':
      result.extra = 'not a domain field';
      break;
    case 'missing-result-field':
      delete result[Object.keys(result)[0]];
      break;
    case 'wrong-basis':
      result.findings[0].basis = 'certain';
      break;
    case 'missing-action-field':
      delete result.completedActions[0].evidenceIds;
      break;
    case 'bad-citation':
      result.planImpact[0].evidenceIds = ['foreign'];
      break;
    case 'bad-assessment-citation':
      result.findings[0].supports = ['foreign'];
      break;
    case 'missing-question':
      result.remainingQuestions = [];
      break;
    case 'empty-section':
      result.planImpact = [];
      break;
    case 'missing-verification':
      delete result.proposedSteps[0].verification;
      break;
    case 'wrong-hash':
      result.candidateSha256 = '0'.repeat(64);
      break;
    case 'missing-criterion':
      result.criteria = [];
      break;
    case 'missing-issue':
      result.issues = [];
      break;
    case 'duplicate-criterion':
      result.criteria.push(result.criteria[0]);
      break;
    case 'string-boolean':
      result.criteria[0].satisfied = 'true';
      break;
    case 'resolved-question':
      result.issues.forEach((i) => {
        i.disposition = 'resolved';
      });
      break;
    case 'unsatisfied':
      result.criteria[0].satisfied = false;
      break;
    case 'blocking':
      result.issues[0].disposition = 'blocking';
      break;
    case 'reject':
      result.verdict = 'reject';
      break;
    case 'result-limit':
      result.reason = 'x'.repeat(256 * 1024);
      break;
    case 'malformed':
      process.stdout.write('{sensitive-output');
      process.exit(0);
      break;
    case 'utf8':
      process.stdout.write(Buffer.from([0xff]));
      process.exit(0);
      break;
    case 'stdout-limit':
      process.stdout.write('x'.repeat(1024 * 1024 + 1));
      break;
    case 'stderr-limit':
      process.stderr.write('s'.repeat(64 * 1024 + 1));
      break;
    case 'nonzero':
      process.stdout.write(JSON.stringify(response));
      process.stderr.write('sensitive-error');
      process.exitCode = 23;
      break;
    case 'hang':
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      break;
    case 'descendant': {
      process.on('SIGTERM', () => {});
      const descendant = spawn(
        process.execPath,
        [process.argv[1], 'hold-pipes'],
        { stdio: 'inherit' },
      );
      await appendFile(
        events,
        JSON.stringify({ descendant: descendant.pid }) + '\n',
      );
      process.stdout.write(JSON.stringify(response));
      process.exit(0);
      break;
    }
    case 'late':
      process.on('SIGTERM', () => {
        process.stdout.write(JSON.stringify(response));
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      break;
    case 'duplicate-response':
      process.stdout.write(JSON.stringify(response));
      process.stdout.write(JSON.stringify(response));
      break;
    default:
      process.stdout.write(JSON.stringify(response));
  }
  if (
    [
      'wrong-version',
      'wrong-role',
      'wrong-revision',
      'wrong-id',
      'wrong-digest',
      'wrong-service',
      'uncertain',
      'extra-envelope',
      'missing-envelope',
      'null-result',
      'extra-result',
      'missing-result-field',
      'wrong-basis',
      'missing-action-field',
      'bad-citation',
      'bad-assessment-citation',
      'missing-question',
      'empty-section',
      'missing-verification',
      'wrong-hash',
      'missing-criterion',
      'missing-issue',
      'duplicate-criterion',
      'string-boolean',
      'resolved-question',
      'unsatisfied',
      'blocking',
      'reject',
      'result-limit',
    ].includes(mode)
  ) {
    process.stdout.write(JSON.stringify(response));
  }
}
