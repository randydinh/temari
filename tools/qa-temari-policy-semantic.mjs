import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This is a finite policy predicate adapter, not a natural-language assessor.
// Authority is admitted by the host against its independently pinned artifact;
// hashes and caller-authored source fields do not authenticate that authority.
export const POLICY_PROFILE_ID = 'temari-public-policy-v1';
export const POLICY_APPROVED_OUTCOMES = Object.freeze({
  'qa-owner': Object.freeze({ owner: './qa-review' }),
  'read-only-contract': Object.freeze({
    allowedActions: Object.freeze([
      'read-source', 'read-candidate', 'read-evidence', 'run-local-check',
    ]),
    externalWrites: 'denied',
  }),
  'capability-admission': Object.freeze({
    callerDeclaredCapabilitiesAreNotProof: true,
  }),
});
export const POLICY_INTENT_REVISION = 'temari-public-feature-v2';
export const POLICY_AUTHORITY_REF = 'temari-public-policy-v2-approved';
export const POLICY_MAX_INPUT_BYTES = 256 * 1024;
export const POLICY_MAX_OUTPUT_BYTES = 256 * 1024;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Same finite, plain-object canonical algorithm as core qaProofDigest. Kept
// dependency-free so the relocated worker cannot import a source checkout.
export function policyProofDigest(value) {
  function canonical(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object' &&
        Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(Object.keys(item).sort().map((key) =>
        [key, canonical(item[key])]));
    throw new Error('Policy proof input must be finite JSON.');
  }
  return sha256(JSON.stringify(canonical(value)));
}

function exact(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error(`${label} has missing or unknown fields.`);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096)
    throw new Error(`${label} must be bounded nonempty text.`);
}

function list(value, label) {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error(`${label} must be a bounded array.`);
}

function same(value, expected) {
  try { return policyProofDigest(value) === policyProofDigest(expected); }
  catch { return false; }
}

function parseOutcome(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}

function uniqueRefs(refs) {
  return [...new Map(refs.map((ref) => [policyProofDigest(ref), ref])).values()];
}

/** @returns {import('../libs/temari-core/src/lib/qa-execution-proof.js').QaSemanticAssessment} */
export function assessTemariPolicy(input) {
  exact(input, ['binding', 'intents', 'review', 'observations',
    'canonicalEvidenceRefs', 'evaluatorLaunchId'], 'Semantic input');
  const { binding, intents, review, observations, canonicalEvidenceRefs,
    evaluatorLaunchId } = input;
  exact(binding, ['taskId', 'runId', 'revision', 'requestSha256',
    'manifestSha256', 'hostSelectionSha256', 'candidate', 'environmentRef',
    'intentSha256', 'frozenReviewSha256'], 'Binding');
  exact(binding.candidate, ['scopeId', 'root', 'revision',
    'artifactManifestSha256'], 'Candidate binding');
  for (const key of ['taskId', 'runId', 'revision', 'environmentRef'])
    text(binding[key], `Binding ${key}`);
  for (const key of ['requestSha256', 'manifestSha256', 'hostSelectionSha256',
    'intentSha256', 'frozenReviewSha256'])
    if (!/^[a-f0-9]{64}$/.test(binding[key]))
      throw new Error(`Binding ${key} is not a SHA256 pin.`);
  text(evaluatorLaunchId, 'Evaluator launch ID');
  for (const [label, values] of Object.entries({ intents, observations,
    canonicalEvidenceRefs, scenarios: review?.scenarios })) list(values, label);
  if (!intents.length) throw new Error('Approved outcome baseline is empty.');
  const intentMap = new Map();
  for (const intent of intents) {
    exact(intent, ['intentId', 'requirementRef', 'revision', 'authorityRef',
      'sourceSha256', 'expectedOutcome'], 'Approved outcome');
    for (const key of Object.keys(intent)) text(intent[key], `Intent ${key}`);
    if (intentMap.has(intent.intentId)) throw new Error('Duplicate intent ID.');
    intentMap.set(intent.intentId, intent);
  }
  const scenarioMap = new Map();
  const attemptMap = new Map();
  for (const scenario of review.scenarios) {
    text(scenario.scenarioId, 'Scenario ID');
    if (scenarioMap.has(scenario.scenarioId)) throw new Error('Duplicate scenario ID.');
    scenarioMap.set(scenario.scenarioId, scenario);
    list(scenario.requirementRefs, 'Scenario requirement refs');
    list(scenario.executions, 'Scenario executions');
    list(scenario.coverageBindings, 'Scenario coverage bindings');
    for (const execution of scenario.executions) {
      text(execution.attemptId, 'Attempt ID');
      if (attemptMap.has(execution.attemptId)) throw new Error('Duplicate frozen attempt ID.');
      attemptMap.set(execution.attemptId, { scenario, execution });
      list(execution.assertions, 'Assertions');
      list(execution.evidenceRefs, 'Execution evidence');
    }
  }
  const canonicalRefs = new Set(canonicalEvidenceRefs.map(policyProofDigest));
  const globalIssues = [];
  if (policyProofDigest(intents) !== binding.intentSha256)
    globalIssues.push('Approved outcome digest differs from the selected binding.');
  if (policyProofDigest(review) !== binding.frozenReviewSha256)
    globalIssues.push('Frozen review digest differs from the selected binding.');
  if (review.assignment?.candidateRef !== binding.revision ||
      binding.candidate.revision !== binding.revision ||
      review.assignment?.environmentRef !== binding.environmentRef ||
      review.assignment?.missingEnvironmentBlocker)
    globalIssues.push('Candidate or environment differs from the selected binding.');
  const approvedIds = Object.keys(POLICY_APPROVED_OUTCOMES);
  if (intents.length !== approvedIds.length ||
      approvedIds.some((id) => !intentMap.has(id)))
    globalIssues.push('This profile requires exactly all three approved policy predicates.');
  const sourcePins = new Set();
  for (const intent of intents) {
    sourcePins.add(intent.sourceSha256);
    if (!Object.hasOwn(POLICY_APPROVED_OUTCOMES, intent.intentId) ||
        intent.requirementRef !== `temari-public-policy#${intent.intentId}` ||
        intent.revision !== POLICY_INTENT_REVISION ||
        intent.authorityRef !== POLICY_AUTHORITY_REF ||
        !/^[a-f0-9]{64}$/.test(intent.sourceSha256) ||
        !same(parseOutcome(intent.expectedOutcome), POLICY_APPROVED_OUTCOMES[intent.intentId]))
      globalIssues.push(`Unsupported predicate, authority, source revision or approved value: ${intent.intentId}.`);
    const index = review.assignment?.requirementRefs?.indexOf(intent.requirementRef);
    if (!(index >= 0) || review.assignment.requirementRevisions[index] !== intent.revision ||
        !(review.intentSources ?? []).some((source) =>
          source.requirementRef === intent.requirementRef &&
          source.revision === intent.revision && source.authorityRef === intent.authorityRef &&
          same(parseOutcome(source.expectedOutcome), parseOutcome(intent.expectedOutcome))))
      globalIssues.push(`Approved intent ${intent.intentId} differs from the frozen source assignment.`);
  }
  if (sourcePins.size !== 1)
    globalIssues.push('Approved outcomes do not share the selected host policy source pin.');

  const observationMap = new Map();
  for (const observation of observations) {
    exact(observation, ['scenarioId', 'attemptId', 'launchId', 'rawStdout',
      'rawStderr', 'exitCode', 'completion', 'stdoutRef', 'stderrRef'], 'Policy observation');
    for (const key of ['scenarioId', 'attemptId', 'launchId']) text(observation[key], key);
    if (observationMap.has(observation.attemptId))
      throw new Error('Duplicate observed attempt ID.');
    observationMap.set(observation.attemptId, observation);
    const attempt = attemptMap.get(observation.attemptId);
    if (!attempt || attempt.scenario.scenarioId !== observation.scenarioId)
      globalIssues.push('Control observation has an unknown scenario/attempt join.');
    for (const stream of ['stdout', 'stderr']) {
      const raw = observation[stream === 'stdout' ? 'rawStdout' : 'rawStderr'];
      const ref = observation[`${stream}Ref`];
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024)
        throw new Error('Control observation exceeds the policy stream limit.');
      exact(ref, ['schema', 'runId', 'revision', 'kind', 'sha256', 'bytes'], 'Raw evidence reference');
      if (ref.schema !== 1 || ref.kind !== stream || ref.runId !== binding.runId ||
          ref.revision !== binding.revision || ref.bytes !== Buffer.byteLength(raw) ||
          ref.sha256 !== sha256(raw) || !canonicalRefs.has(policyProofDigest(ref)) ||
          (attempt && !attempt.execution.evidenceRefs.some((item) => same(item, ref))))
        globalIssues.push('Raw control bytes differ from admitted, frozen evidence references.');
    }
  }
  const findings = [];
  const add = (kind, reason, minimumCorrection, scenarioIds, intentIds,
    attemptIds = [], evidenceRefs = []) => {
    const findingId = `policy-finding-${String(findings.length + 1).padStart(4, '0')}`;
    findings.push({ findingId, kind, severity: 'Important', reason,
      minimumCorrection, scenarioIds, intentIds, attemptIds, evidenceRefs });
    return findingId;
  };
  if (globalIssues.length)
    add('intent-conflict', [...new Set(globalIssues)].join(' ').slice(0, 4096),
      'Re-admit the exact approved source, candidate and raw capture; freeze a matching review.',
      [...scenarioMap.keys()], [...intentMap.keys()]);

  const assessments = review.scenarios.map((scenario) => {
    const linked = intents.filter((intent) => scenario.requirementRefs.includes(intent.requirementRef));
    const intentIds = linked.map((intent) => intent.intentId);
    const attemptIds = scenario.executions.map((execution) => execution.attemptId);
    const evidenceRefs = uniqueRefs(scenario.executions.flatMap((execution) => execution.evidenceRefs));
    let assertionAssessment = 'sufficient';
    let assessment = 'unresolved';
    let rationale = 'The selected policy predicate has no complete executed observation.';
    const scopeValid = linked.length === 1 && scenario.requirementRefs.length === 1 &&
      scenario.sourceRevision === linked[0].revision &&
      Object.hasOwn(POLICY_APPROVED_OUTCOMES, linked[0].intentId) &&
      same(parseOutcome(scenario.expectedBehavior), parseOutcome(linked[0].expectedOutcome));
    if (!scopeValid) {
      assertionAssessment = 'unresolved';
      add('scope-gap', `Scenario ${scenario.scenarioId} is outside the one-predicate approved policy scope.`,
        'Use exactly one assigned approved predicate and its pinned expected JSON value.',
        [scenario.scenarioId], intentIds);
    } else {
      const token = `policy:${linked[0].intentId}`;
      const selected = scenario.coverageBindings.some((coverage) =>
        coverage.designState === 'Selected' && coverage.kind !== 'Gap' &&
        ['Existing', 'Added', 'Updated'].includes(coverage.implementationState) &&
        coverage.assertionSummary === token);
      const weak = !selected || scenario.executions.some((execution) =>
        execution.state === 'Executed' && !execution.assertions.includes(token));
      if (weak) {
        assertionAssessment = 'weak';
        rationale = 'Assertions do not independently name the selected approved policy predicate.';
        add('weak-assertion', rationale,
          `Select implemented coverage and assert the exact token ${token} on every executed attempt.`,
          [scenario.scenarioId], intentIds, attemptIds, evidenceRefs);
      }
      const results = scenario.executions.map((execution) => {
        const observation = observationMap.get(execution.attemptId);
        if (execution.state !== 'Executed' || !observation ||
            observation.completion !== 'completed' || observation.exitCode !== 0)
          return 'unresolved';
        if (execution.candidateRef !== binding.revision || execution.environmentRef !== binding.environmentRef)
          return 'unresolved';
        let output;
        try { output = JSON.parse(observation.rawStdout); } catch { return 'unresolved'; }
        if (!output || output.schemaVersion !== 1 || output.entry !== 'temari' ||
            output.status !== 'described' || typeof output.policyId !== 'string' || !output.policyId)
          return 'unresolved';
        const contract = output.qaContract;
        let supported = false;
        if (linked[0].intentId === 'qa-owner')
          supported = contract?.owner === POLICY_APPROVED_OUTCOMES['qa-owner'].owner;
        else if (linked[0].intentId === 'read-only-contract')
          supported = Array.isArray(contract?.allowedActions) &&
            contract.allowedActions.every((action) => typeof action === 'string') &&
            same(contract.allowedActions, POLICY_APPROVED_OUTCOMES['read-only-contract'].allowedActions) &&
            contract.externalWrites === 'denied';
        else if (linked[0].intentId === 'capability-admission')
          supported = contract?.callerDeclaredCapabilitiesAreNotProof === true;
        return supported ? 'outcome-supported' : 'violation-supported';
      });
      if (!globalIssues.length && !weak && results.length && !results.includes('unresolved')) {
        assessment = results.includes('violation-supported') ? 'violation-supported' : 'outcome-supported';
        rationale = assessment === 'outcome-supported'
          ? `Actual policy JSON satisfies the independently approved ${linked[0].intentId} predicate.`
          : `Actual policy JSON violates the independently approved ${linked[0].intentId} predicate.`;
        if (assessment === 'violation-supported')
          add('product-violation', rationale,
            'Correct the advertised CLI policy contract, then execute and freeze a new observation.',
            [scenario.scenarioId], intentIds, attemptIds, evidenceRefs);
        const expectedResult = assessment === 'outcome-supported' ? 'Passed' : 'Failed';
        if (scenario.result !== expectedResult) {
          add('intent-conflict', 'Frozen scenario result contradicts its actual policy observation.',
            'Freeze the result derived from actual control output, then evaluate again.',
            [scenario.scenarioId], intentIds, attemptIds, evidenceRefs);
          assessment = 'unresolved';
          rationale = 'Frozen result contradicts actual observed policy behavior.';
        }
      }
    }
    if (assessment === 'unresolved' && !findings.some((finding) => finding.scenarioIds.includes(scenario.scenarioId)))
      add('scope-gap', rationale, 'Provide a complete successful actual policy control and matching candidate/environment.',
        [scenario.scenarioId], intentIds, attemptIds, evidenceRefs);
    return { scenarioId: scenario.scenarioId, assessment, assertionAssessment,
      rationale, intentIds, attemptIds, evidenceRefs };
  });
  const outcomes = intents.map((intent) => {
    const linked = assessments.filter((assessment) => assessment.intentIds.includes(intent.intentId));
    const scenarioIds = linked.map((assessment) => assessment.scenarioId);
    let coverage = linked.length ? 'covered' : 'missing';
    if (!linked.length)
      add('missing-outcome', `Approved outcome ${intent.intentId} is absent from authored scenarios.`,
        'Add an independently asserted scenario for this approved outcome and execute the actual control.',
        [], [intent.intentId]);
    else if (linked.some((assessment) => assessment.assessment === 'unresolved')) {
      coverage = 'unresolved';
      if (!findings.some((finding) => finding.intentIds.includes(intent.intentId)))
        add('scope-gap', 'Approved outcome has unresolved execution or assertions.',
          'Resolve the exact execution/assertion gap before acceptance.', scenarioIds, [intent.intentId]);
    }
    return { intentId: intent.intentId, coverage, scenarioIds,
      rationale: coverage === 'covered' ? 'All linked scenarios were independently assessed against actual policy JSON.'
        : coverage === 'missing' ? 'No authored scenario covers this approved outcome.'
          : 'A linked scenario or pinned source remains unresolved.',
      findingIds: findings.filter((finding) => finding.intentIds.includes(intent.intentId)).map((finding) => finding.findingId) };
  });
  return { schemaVersion: 1, bindingSha256: policyProofDigest(binding),
    frozenReviewSha256: binding.frozenReviewSha256, evaluatorLaunchId,
    scenarios: assessments, outcomes, findings };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error('Semantic policy worker accepts stdin only.');
    const timeout = setTimeout(() => process.stdin.destroy(new Error('Semantic input timed out.')), 10_000);
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of process.stdin) {
        bytes += chunk.byteLength;
        if (bytes > POLICY_MAX_INPUT_BYTES) throw new Error('Semantic input exceeds 256 KiB.');
        chunks.push(chunk);
      }
    } finally { clearTimeout(timeout); }
    const output = `${JSON.stringify(assessTemariPolicy(JSON.parse(Buffer.concat(chunks).toString('utf8'))))}\n`;
    if (Buffer.byteLength(output) > POLICY_MAX_OUTPUT_BYTES) throw new Error('Semantic output exceeds 256 KiB.');
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
