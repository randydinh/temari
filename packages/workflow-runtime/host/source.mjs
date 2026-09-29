import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readBoundedFile } from './stdio.mjs';

const sourceRevision = '959c8f7be3d7b684207d9e626263d41540d5ecdc';
const sourceEvidenceName = 'source';
const sourceClaimsName = 'source-requirements';
const lightweightStageRequirements = {
  investigate: ['lightweight.intake.inspect'],
  plan: ['lightweight.route.qualifies'],
  build: ['lightweight.build.smallest-complete-change'],
  review: ['lightweight.verify.direct-check'],
  verify: ['lightweight.verify.direct-check'],
  deliver: [],
};
const featureStageRequirements = {
  investigate: ['feature.shape.how'],
  plan: [
    'feature.shape.parallel-design',
    'feature.shape.throughput-checkpoint',
  ],
  build: ['feature.build.delegated-implementation'],
  review: ['feature.review.ordered-commits'],
  verify: ['feature.verify.matching-surface'],
  deliver: ['feature.delivery.pull-request'],
};
const sourceProfiles = {
  'lightweight-engineering-v1': {
    file: 'lightweight-engineering',
    profileSha256:
      '94370c4bbbd48666807630abd2866f0727ccf3ab614d23fd4b2d3c3b98d493e7',
    stageRequirements: lightweightStageRequirements,
    requirementIds: [
      'lightweight.intake.inspect',
      'lightweight.route.qualifies',
      'lightweight.build.smallest-complete-change',
      'lightweight.verify.direct-check',
    ],
    obligations: {
      workType: 'feature',
      delegation: 'none',
      review: 'self',
      evidence: 'revision-bound',
      delivery: 'local',
    },
  },
  'feature-v1': {
    file: 'feature',
    profileSha256:
      '27afa4044e7e1b0238b2ed6a33f7cff26417d7f905372bd6b5409f4d0462f959',
    stageRequirements: featureStageRequirements,
    requirementIds: Object.values(featureStageRequirements).flat(),
    obligations: {
      workType: 'feature',
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'pull-request',
    },
  },
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export async function loadSourceContract(
  contracts,
  runtimeRoot,
  sourceProfile,
  capabilities,
) {
  const selected = sourceProfiles[sourceProfile];
  assert(selected, 'Unsupported source profile.');
  if (sourceProfile === 'feature-v1')
    assert.deepEqual(
      contracts.missingOrUnprovenCapabilities(
        ['subagents', 'forge'],
        capabilities,
      ),
      [],
      'Feature source requires independently proven host capabilities.',
    );
  const root = dirname(runtimeRoot);
  const profileText = decode(
    await readBoundedFile(
      join(root, `source/${selected.file}.json`),
      64 * 1024,
    ),
  );
  const playbookText = decode(
    await readBoundedFile(join(root, `source/${selected.file}.md`), 64 * 1024),
  );
  const parsed = contracts.parseV41Profile({
    sourceRevision,
    profileText,
    expectedProfileSha256: selected.profileSha256,
  });
  assert.equal(parsed.status, 'valid', parsed.reason);
  const boundaries = ['final', 'commit', 'review', 'publish'].map((boundary) =>
    contracts.assessV41PlanBoundary({
      parsed: parsed.value,
      boundary,
      playbookText,
      workType: 'feature',
    }),
  );
  assert.deepEqual(
    boundaries.map((result) => result.status),
    sourceProfile === 'feature-v1'
      ? ['supported', 'supported', 'supported', 'blocked']
      : ['blocked', 'blocked', 'blocked', 'blocked'],
    'Pinned source boundary is incompatible.',
  );
  if (sourceProfile === 'lightweight-engineering-v1')
    assert(
      boundaries
        .slice(0, 3)
        .every(
          (result) =>
            result.reason ===
            'Verified lightweight source evidence is incomplete or incompatible.',
        ),
      'Source boundary did not require retained evidence.',
    );
  assert.deepEqual(boundaries[3].requiredGates, ['operator-approval']);
  const profile = parsed.value.profile;
  const requirements = new Map(
    profile.stages.flatMap((stage) =>
      stage.requirements.map((requirement) => [requirement.id, requirement]),
    ),
  );
  assert.deepEqual(
    [...requirements.keys()].sort(),
    [...selected.requirementIds].sort(),
  );
  return {
    requirements,
    stageRequirements: selected.stageRequirements,
    plan: contracts.reconcilePlan(selected.obligations),
    parsed: parsed.value,
    playbookText,
    contracts,
  };
}

export function attachSourceClaims(stage, result, input, contract) {
  const expected = contract.stageRequirements[stage];
  assert(expected, 'Unknown source stage.');
  assert(
    !result.evidence.some((item) => item.name === sourceClaimsName),
    'Source requirement attestation name is reserved.',
  );
  const sourcePayloads = result.evidence.filter(
    (item) => item.name === sourceEvidenceName,
  );
  assert(
    expected.length === 0
      ? sourcePayloads.length <= 1
      : sourcePayloads.length === 1,
    `Dedicated source evidence differs at ${stage}.`,
  );
  assert(
    sourcePayloads.every((item) => item.kind === 'other'),
    `Dedicated source evidence must have generic kind other at ${stage}.`,
  );
  const claims = result.sourceRequirements ?? [];
  assert.deepEqual(
    claims.map((claim) => claim.id).sort(),
    [...expected].sort(),
    `Source requirements missing at ${stage}.`,
  );
  const entries = claims.map((claim) => {
    const requirement = contract.requirements.get(claim.id);
    assert(
      requirement.allowedEvidenceKinds.includes(claim.sourceKind),
      `Unsupported source evidence kind for ${claim.id}.`,
    );
    assert.equal(
      claim.evidenceName,
      sourceEvidenceName,
      `Source claim must use dedicated evidence for ${claim.id}.`,
    );
    const payload = sourcePayloads[0];
    assert(
      payload && payload.content.byteLength > 0,
      `Missing source evidence for ${claim.id}.`,
    );
    return {
      id: claim.id,
      sourceKind: claim.sourceKind,
      evidenceName: claim.evidenceName,
      reference: {
        schema: 1,
        runId: input.runId,
        revision: input.revision,
        kind: payload.kind,
        sha256: digest(payload.content),
        bytes: payload.content.byteLength,
      },
    };
  });
  const { sourceRequirements: _claims, ...stageResult } = result;
  return {
    ...stageResult,
    evidence: [
      ...result.evidence,
      {
        name: sourceClaimsName,
        kind: 'other',
        content: Buffer.from(
          JSON.stringify({ schemaVersion: 1, stage, claims: entries }),
        ),
      },
    ],
  };
}

export async function assertSourceEvidence(
  record,
  store,
  contract,
  runtime,
  complete = false,
) {
  assert(record, 'Source evidence record is missing.');
  await runtime.verifyCandidateEvidenceRecord(
    record,
    record.runId,
    record.revision,
    store,
    complete,
    record.candidateBinding,
  );
  const satisfied = new Set();
  const verifiedEvidence = [];
  for (const stage of record.stages) {
    const expected = contract.stageRequirements[stage.stage];
    assert(expected, 'Unknown source evidence stage.');
    const attestationBytes = await store.loadPortable({
      ...stage.stageEvidence,
      runId: record.runId,
      revision: record.revision,
      kind: 'other',
    });
    const attestation = JSON.parse(decode(attestationBytes));
    const sourcePayloads = attestation.payloads.filter(
      (payload) => payload.name === sourceClaimsName,
    );
    assert.equal(
      sourcePayloads.length,
      1,
      `Missing retained source requirements at ${stage.stage}.`,
    );
    const sourcePayload = sourcePayloads[0];
    assert.equal(sourcePayload.reference.kind, 'other');
    const sourceBytes = await store.loadPortable(sourcePayload.reference);
    const source = JSON.parse(decode(sourceBytes));
    assert.equal(source.schemaVersion, 1);
    assert.equal(source.stage, stage.stage);
    assert.deepEqual(
      source.claims.map((claim) => claim.id).sort(),
      [...expected].sort(),
      `Retained source requirements differ at ${stage.stage}.`,
    );
    const dedicatedPayloads = attestation.payloads.filter(
      (payload) => payload.name === sourceEvidenceName,
    );
    assert(
      expected.length === 0
        ? dedicatedPayloads.length <= 1
        : dedicatedPayloads.length === 1,
      `Retained dedicated source evidence differs at ${stage.stage}.`,
    );
    assert(
      dedicatedPayloads.every((payload) => payload.reference.kind === 'other'),
      `Retained dedicated source kind differs at ${stage.stage}.`,
    );
    for (const claim of source.claims) {
      const requirement = contract.requirements.get(claim.id);
      assert(
        requirement?.allowedEvidenceKinds.includes(claim.sourceKind),
        `Retained source kind is unsupported for ${claim.id}.`,
      );
      assert.equal(
        claim.evidenceName,
        sourceEvidenceName,
        `Retained source claim must use dedicated evidence for ${claim.id}.`,
      );
      const payload = dedicatedPayloads[0];
      assert.deepEqual(
        claim.reference,
        payload.reference,
        `Retained source reference differs for ${claim.id}.`,
      );
      const content = await store.loadPortable(payload.reference);
      assert(
        content.byteLength > 0 && digest(content) === claim.reference.sha256,
        `Retained source bytes differ for ${claim.id}.`,
      );
      satisfied.add(claim.id);
      verifiedEvidence.push({
        id: claim.id,
        stage: stage.stage,
        sourceKind: claim.sourceKind,
        reference: payload.reference,
      });
    }
  }
  if (complete) {
    assert.deepEqual(
      [...satisfied].sort(),
      [...contract.requirements.keys()].sort(),
      'Final source requirement coverage is incomplete.',
    );
    for (const boundary of ['final', 'commit', 'review']) {
      const result = contract.contracts.assessV41PlanBoundary({
        parsed: contract.parsed,
        boundary,
        playbookText: contract.playbookText,
        workType: 'feature',
        sourceEvidence: verifiedEvidence,
      });
      assert.equal(result.status, 'supported', result.reason);
      assert.deepEqual(result.plan, contract.plan);
    }
  }
}
