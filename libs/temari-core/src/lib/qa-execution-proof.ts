import { createHash } from 'node:crypto';
import type { WorkerEvidenceReference } from '@temari/contracts';

import type { QaReviewDraft } from './qa-evaluator.js';
import {
  createQaReviewRecord,
  validateQaReviewRecord,
} from './qa-review-record.js';

/** Host-selected identities, pinned before product control or evaluation. */
export interface QaExecutionBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly revision: string;
  readonly requestSha256: string;
  readonly manifestSha256: string;
  readonly hostSelectionSha256: string;
  readonly candidate: {
    readonly scopeId: string;
    readonly root: string;
    readonly revision: string;
    readonly artifactManifestSha256: string;
  };
  readonly environmentRef: string;
  readonly intentSha256: string;
  readonly frozenReviewSha256: string;
}

/** One approved outcome; several outcomes may share a requirement revision. */
export interface QaApprovedOutcome {
  readonly intentId: string;
  readonly requirementRef: string;
  readonly revision: string;
  readonly authorityRef: string;
  readonly sourceSha256: string;
  readonly expectedOutcome: string;
}

/**
 * Observed by the admitted host. PID/session, output and authority cannot be
 * authenticated by this pure module. Raw output is retained separately from
 * outputSha256, which binds the canonical parsed adapter result.
 */
export interface QaObservedLaunch {
  readonly launchId: string;
  readonly role: 'product-control' | 'semantic-evaluator';
  readonly profileId: string;
  readonly implementationSha256: string;
  readonly runtimeSha256: string;
  readonly artifactManifestSha256: string;
  readonly actorId: string;
  readonly contextId: string;
  readonly processId: number | null;
  readonly invocationSha256: string;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly completion: 'completed' | 'unavailable';
  readonly exitCode: number | null;
  readonly stdoutRef: WorkerEvidenceReference;
  readonly stderrRef: WorkerEvidenceReference;
}

/** This selection must come from actual admitted host capture, not the request. */
export interface QaAdmittedLaunchSelection {
  readonly launchId: string;
  readonly launchSha256: string;
}

export interface QaProductAttemptProof {
  readonly scenarioId: string;
  readonly attemptId: string;
  readonly executionSha256: string;
  readonly launchId: string | null;
}

export type QaSemanticFindingKind =
  | 'missing-outcome'
  | 'weak-assertion'
  | 'intent-conflict'
  | 'scope-gap'
  | 'product-violation'
  | 'other';

export interface QaSemanticFinding {
  readonly findingId: string;
  readonly kind: QaSemanticFindingKind;
  readonly severity: 'Blocking' | 'Important' | 'Minor';
  readonly reason: string;
  readonly minimumCorrection: string;
  readonly scenarioIds: readonly string[];
  readonly intentIds: readonly string[];
  readonly attemptIds: readonly string[];
  readonly evidenceRefs: readonly WorkerEvidenceReference[];
}

export interface QaScenarioAssessment {
  readonly scenarioId: string;
  readonly assessment: 'outcome-supported' | 'violation-supported' | 'unresolved';
  readonly assertionAssessment: 'sufficient' | 'weak' | 'unresolved';
  readonly rationale: string;
  readonly intentIds: readonly string[];
  readonly attemptIds: readonly string[];
  readonly evidenceRefs: readonly WorkerEvidenceReference[];
}

/** Explicitly checks approved outcomes absent from the author's inventory. */
export interface QaOutcomeCoverageAssessment {
  readonly intentId: string;
  readonly coverage: 'covered' | 'missing' | 'unresolved';
  readonly scenarioIds: readonly string[];
  readonly rationale: string;
  readonly findingIds: readonly string[];
}

export interface QaSemanticAssessment {
  readonly schemaVersion: 1;
  readonly bindingSha256: string;
  readonly frozenReviewSha256: string;
  readonly evaluatorLaunchId: string;
  readonly scenarios: readonly QaScenarioAssessment[];
  readonly outcomes: readonly QaOutcomeCoverageAssessment[];
  readonly findings: readonly QaSemanticFinding[];
}

export interface QaExecutionProof {
  readonly schemaVersion: 1;
  readonly binding: QaExecutionBinding;
  readonly launches: readonly QaObservedLaunch[];
  readonly attempts: readonly QaProductAttemptProof[];
  readonly semantic: QaSemanticAssessment;
}

/**
 * Independently selected host context. No caller flag such as `proven` belongs
 * here. The host admits authority and real launch capture before supplying it.
 */
export interface QaExecutionProofContext {
  readonly binding: QaExecutionBinding;
  readonly review: QaReviewDraft;
  readonly intents: readonly QaApprovedOutcome[];
  readonly canonicalEvidenceRefs: readonly WorkerEvidenceReference[];
  readonly admittedLaunches: readonly QaAdmittedLaunchSelection[];
  readonly semanticInputSha256: string;
}

export interface QaExecutionProofValidation {
  readonly status: 'valid' | 'invalid' | 'unavailable';
  readonly issues: readonly string[];
  readonly productResult: 'passed' | 'failed' | 'blocked';
  readonly qaDisposition: 'Passed' | 'Failed' | 'BlockedOrIncomplete';
}

/** Stable JSON hash. No final evaluation record/receipt enters the proof hash. */
export function qaProofDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean')
      return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object' &&
        Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.keys(input).sort().map((key) =>
        [key, canonical((input as Record<string, unknown>)[key])],
      ));
    }
    throw new Error('QA proof hashing requires finite JSON values.');
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

type JsonObject = Record<string, unknown>;
const DIGEST = /^[0-9a-f]{64}$/;

function exactObject(value: unknown, fields: readonly string[], label: string,
  issues: string[]): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    issues.push(`${label} must be a JSON object.`);
    return false;
  }
  const object = value as JsonObject;
  if (fields.some((key) => !Object.hasOwn(object, key)) ||
      Object.keys(object).some((key) => !fields.includes(key)))
    issues.push(`${label} has unknown or missing fields.`);
  return true;
}

function text(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096)
    issues.push(`${label} must be bounded nonempty text.`);
}

function digest(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== 'string' || !DIGEST.test(value))
    issues.push(`${label} must be a lowercase SHA-256 digest.`);
}

function choice(value: unknown, choices: readonly string[], label: string,
  issues: string[]): void {
  if (typeof value !== 'string' || !choices.includes(value))
    issues.push(`${label} has an unsupported value.`);
}

function list(value: unknown, label: string, issues: string[]): value is unknown[] {
  if (!Array.isArray(value) || value.length > 4096) {
    issues.push(`${label} must be a bounded array.`);
    return false;
  }
  return true;
}

function textList(value: unknown, label: string, issues: string[]): void {
  if (!list(value, label, issues)) return;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    text(item, `${label}[${index}]`, issues);
    if (typeof item === 'string') {
      if (seen.has(item)) issues.push(`${label} contains duplicate ${item}.`);
      seen.add(item);
    }
  });
}

function reference(value: unknown, label: string, issues: string[]): void {
  if (!exactObject(value, ['schema', 'runId', 'revision', 'kind', 'sha256', 'bytes'], label, issues)) return;
  if (value.schema !== 1) issues.push(`${label}.schema must be 1.`);
  text(value.runId, `${label}.runId`, issues);
  text(value.revision, `${label}.revision`, issues);
  choice(value.kind, ['stdout', 'stderr', 'worker-result', 'verification', 'other'], `${label}.kind`, issues);
  digest(value.sha256, `${label}.sha256`, issues);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0)
    issues.push(`${label}.bytes must be a nonnegative safe integer.`);
}

function references(value: unknown, label: string, issues: string[]): void {
  if (list(value, label, issues)) value.forEach((item, index) =>
    reference(item, `${label}[${index}]`, issues));
}

function bindingShape(value: unknown, label: string, issues: string[]): void {
  if (!exactObject(value, ['taskId', 'runId', 'revision', 'requestSha256', 'manifestSha256',
    'hostSelectionSha256', 'candidate', 'environmentRef', 'intentSha256', 'frozenReviewSha256'], label, issues)) return;
  for (const key of ['taskId', 'runId', 'revision', 'environmentRef']) text(value[key], `${label}.${key}`, issues);
  for (const key of ['requestSha256', 'manifestSha256', 'hostSelectionSha256', 'intentSha256', 'frozenReviewSha256'])
    digest(value[key], `${label}.${key}`, issues);
  if (exactObject(value.candidate, ['scopeId', 'root', 'revision', 'artifactManifestSha256'], `${label}.candidate`, issues)) {
    for (const key of ['scopeId', 'root', 'revision']) text(value.candidate[key], `${label}.candidate.${key}`, issues);
    digest(value.candidate.artifactManifestSha256, `${label}.candidate.artifactManifestSha256`, issues);
  }
}

function launchShape(value: unknown, label: string, issues: string[]): void {
  if (!exactObject(value, ['launchId', 'role', 'profileId', 'implementationSha256', 'runtimeSha256',
    'artifactManifestSha256', 'actorId', 'contextId', 'processId', 'invocationSha256', 'inputSha256',
    'outputSha256', 'startedAt', 'endedAt', 'completion', 'exitCode', 'stdoutRef', 'stderrRef'], label, issues)) return;
  for (const key of ['launchId', 'profileId', 'actorId', 'contextId']) text(value[key], `${label}.${key}`, issues);
  for (const key of ['implementationSha256', 'runtimeSha256', 'artifactManifestSha256', 'invocationSha256', 'inputSha256', 'outputSha256'])
    digest(value[key], `${label}.${key}`, issues);
  choice(value.role, ['product-control', 'semantic-evaluator'], `${label}.role`, issues);
  choice(value.completion, ['completed', 'unavailable'], `${label}.completion`, issues);
  if (value.processId !== null && (!Number.isSafeInteger(value.processId) || (value.processId as number) <= 0))
    issues.push(`${label}.processId must be null or a positive safe integer.`);
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    issues.push(`${label}.exitCode must be null or a safe integer.`);
  for (const key of ['startedAt', 'endedAt'])
    if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key] as string)))
      issues.push(`${label}.${key} must be a timestamp.`);
  if (typeof value.startedAt === 'string' && typeof value.endedAt === 'string' &&
      Date.parse(value.endedAt) < Date.parse(value.startedAt)) issues.push(`${label} ends before it starts.`);
  reference(value.stdoutRef, `${label}.stdoutRef`, issues);
  reference(value.stderrRef, `${label}.stderrRef`, issues);
}

function proofShape(value: unknown, issues: string[]): void {
  if (!exactObject(value, ['schemaVersion', 'binding', 'launches', 'attempts', 'semantic'], 'proof', issues)) return;
  if (value.schemaVersion !== 1) issues.push('proof.schemaVersion must be 1.');
  bindingShape(value.binding, 'proof.binding', issues);
  if (list(value.launches, 'proof.launches', issues)) value.launches.forEach((launch, i) => launchShape(launch, `proof.launches[${i}]`, issues));
  if (list(value.attempts, 'proof.attempts', issues)) value.attempts.forEach((attempt, i) => {
    const label = `proof.attempts[${i}]`;
    if (!exactObject(attempt, ['scenarioId', 'attemptId', 'executionSha256', 'launchId'], label, issues)) return;
    text(attempt.scenarioId, `${label}.scenarioId`, issues);
    text(attempt.attemptId, `${label}.attemptId`, issues);
    digest(attempt.executionSha256, `${label}.executionSha256`, issues);
    if (attempt.launchId !== null) text(attempt.launchId, `${label}.launchId`, issues);
  });
  if (!exactObject(value.semantic, ['schemaVersion', 'bindingSha256', 'frozenReviewSha256',
    'evaluatorLaunchId', 'scenarios', 'outcomes', 'findings'], 'proof.semantic', issues)) return;
  const semantic = value.semantic;
  if (semantic.schemaVersion !== 1) issues.push('proof.semantic.schemaVersion must be 1.');
  digest(semantic.bindingSha256, 'proof.semantic.bindingSha256', issues);
  digest(semantic.frozenReviewSha256, 'proof.semantic.frozenReviewSha256', issues);
  text(semantic.evaluatorLaunchId, 'proof.semantic.evaluatorLaunchId', issues);
  if (list(semantic.scenarios, 'proof.semantic.scenarios', issues)) semantic.scenarios.forEach((assessment, i) => {
    const label = `proof.semantic.scenarios[${i}]`;
    if (!exactObject(assessment, ['scenarioId', 'assessment', 'assertionAssessment', 'rationale', 'intentIds', 'attemptIds', 'evidenceRefs'], label, issues)) return;
    text(assessment.scenarioId, `${label}.scenarioId`, issues);
    text(assessment.rationale, `${label}.rationale`, issues);
    choice(assessment.assessment, ['outcome-supported', 'violation-supported', 'unresolved'], `${label}.assessment`, issues);
    choice(assessment.assertionAssessment, ['sufficient', 'weak', 'unresolved'], `${label}.assertionAssessment`, issues);
    textList(assessment.intentIds, `${label}.intentIds`, issues);
    textList(assessment.attemptIds, `${label}.attemptIds`, issues);
    references(assessment.evidenceRefs, `${label}.evidenceRefs`, issues);
  });
  if (list(semantic.outcomes, 'proof.semantic.outcomes', issues)) semantic.outcomes.forEach((outcome, i) => {
    const label = `proof.semantic.outcomes[${i}]`;
    if (!exactObject(outcome, ['intentId', 'coverage', 'scenarioIds', 'rationale', 'findingIds'], label, issues)) return;
    text(outcome.intentId, `${label}.intentId`, issues);
    text(outcome.rationale, `${label}.rationale`, issues);
    choice(outcome.coverage, ['covered', 'missing', 'unresolved'], `${label}.coverage`, issues);
    textList(outcome.scenarioIds, `${label}.scenarioIds`, issues);
    textList(outcome.findingIds, `${label}.findingIds`, issues);
  });
  if (list(semantic.findings, 'proof.semantic.findings', issues)) semantic.findings.forEach((finding, i) => {
    const label = `proof.semantic.findings[${i}]`;
    if (!exactObject(finding, ['findingId', 'kind', 'severity', 'reason', 'minimumCorrection', 'scenarioIds', 'intentIds', 'attemptIds', 'evidenceRefs'], label, issues)) return;
    for (const key of ['findingId', 'reason', 'minimumCorrection']) text(finding[key], `${label}.${key}`, issues);
    choice(finding.kind, ['missing-outcome', 'weak-assertion', 'intent-conflict', 'scope-gap', 'product-violation', 'other'], `${label}.kind`, issues);
    choice(finding.severity, ['Blocking', 'Important', 'Minor'], `${label}.severity`, issues);
    for (const key of ['scenarioIds', 'intentIds', 'attemptIds']) textList(finding[key], `${label}.${key}`, issues);
    references(finding.evidenceRefs, `${label}.evidenceRefs`, issues);
  });
}

function blocked(status: 'invalid' | 'unavailable', issues: readonly string[]): QaExecutionProofValidation {
  return { status, issues, productResult: 'blocked', qaDisposition: 'BlockedOrIncomplete' };
}

function uniqueMap<T>(values: readonly T[], key: (value: T) => string,
  label: string, issues: string[]): Map<string, T> {
  const result = new Map<string, T>();
  values.forEach((value) => {
    const id = key(value);
    if (result.has(id)) issues.push(`${label} contains duplicate ${id}.`);
    result.set(id, value);
  });
  return result;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((id) => actual.includes(id));
}

/**
 * Integrity/relationship validation only. Passing fabricated but coherent data
 * here never authenticates authority, observation, independence or a receipt.
 * The public host must derive context from actual admitted selection/capture.
 */
export function validateQaExecutionProof(proof: unknown,
  context: QaExecutionProofContext): QaExecutionProofValidation {
  if (proof === null || proof === undefined) return blocked('unavailable', ['QA execution proof is unavailable.']);
  const issues: string[] = [];
  try {
    proofShape(proof, issues);
    bindingShape(context.binding, 'context.binding', issues);
    digest(context.semanticInputSha256, 'context.semanticInputSha256', issues);
    references(context.canonicalEvidenceRefs, 'context.canonicalEvidenceRefs', issues);
    if (issues.length) return blocked('invalid', issues);
    const value = proof as QaExecutionProof;
    const binding = context.binding;
    const review = context.review;
    if (qaProofDigest(value.binding) !== qaProofDigest(binding)) issues.push('Proof differs from the selected current task/run/request/candidate binding.');
    if (binding.candidate.revision !== binding.revision || review.assignment.candidateRef !== binding.revision)
      issues.push('Candidate/review revision differs from the invocation.');
    if (review.assignment.environmentRef !== binding.environmentRef || review.assignment.missingEnvironmentBlocker)
      issues.push('Review environment differs from the selected environment or is unavailable.');
    if (qaProofDigest(review) !== binding.frozenReviewSha256) issues.push('Pre-evaluation frozen review digest differs.');
    if (qaProofDigest(context.intents) !== binding.intentSha256) issues.push('Approved outcome baseline digest differs.');
    if (value.semantic.bindingSha256 !== qaProofDigest(binding) || value.semantic.frozenReviewSha256 !== binding.frozenReviewSha256)
      issues.push('Semantic assessment differs from the frozen review/binding.');
    const draftRecord = createQaReviewRecord({ ...review,
      evaluationRounds: [{ round: 1, evaluatorId: 'qa-proof-draft-validation',
        freshContextAttestation: 'draft integrity only; no evaluator invocation',
        verdict: 'BLOCKED', findingIds: [], evidenceRefs: [] }],
      qaDisposition: 'BlockedOrIncomplete', dispositionBasis: 'pre-evaluation draft integrity',
      externalWriteReceipts: [] });
    issues.push(...validateQaReviewRecord(draftRecord).map((issue) => `Frozen review: ${issue}`));
    if (review.assignment.requestKind !== 'full') issues.push('Execution proof requires a full QA assignment.');
    const evidence = uniqueMap(context.canonicalEvidenceRefs, qaProofDigest, 'Canonical evidence inventory', issues);
    const checkRefs = (refs: readonly WorkerEvidenceReference[], label: string): void => {
      const seen = new Set<string>();
      refs.forEach((ref) => {
        const key = qaProofDigest(ref);
        if (seen.has(key)) issues.push(`${label} repeats evidence.`);
        seen.add(key);
        if (!evidence.has(key) || ref.runId !== binding.runId || ref.revision !== binding.revision)
          issues.push(`${label} has unknown or differently bound evidence.`);
      });
    };
    const intents = uniqueMap(context.intents, (intent) => intent.intentId, 'Approved outcomes', issues);
    if (!intents.size) issues.push('Approved outcome baseline is empty.');
    context.intents.forEach((intent) => {
      const keys = ['intentId', 'requirementRef', 'revision', 'authorityRef', 'sourceSha256', 'expectedOutcome'];
      exactObject(intent, keys, `Intent ${intent.intentId}`, issues);
      for (const key of ['intentId', 'requirementRef', 'revision', 'authorityRef', 'expectedOutcome'] as const)
        text(intent[key], `Intent ${intent.intentId}.${key}`, issues);
      digest(intent.sourceSha256, `Intent ${intent.intentId}.sourceSha256`, issues);
      const index = review.assignment.requirementRefs.indexOf(intent.requirementRef);
      if (index < 0 || review.assignment.requirementRevisions[index] !== intent.revision)
        issues.push(`Intent ${intent.intentId} is not an assigned requirement revision.`);
      if (!(review.intentSources ?? []).some((source) => source.requirementRef === intent.requirementRef &&
          source.revision === intent.revision && source.authorityRef === intent.authorityRef))
        issues.push(`Intent ${intent.intentId} differs from the frozen intent source.`);
    });
    const scenarios = uniqueMap(review.scenarios, (scenario) => scenario.scenarioId, 'Frozen scenarios', issues);
    const executions = new Map<string, { scenarioId: string; execution: typeof review.scenarios[number]['executions'][number] }>();
    review.scenarios.forEach((scenario) => scenario.executions.forEach((execution) => {
      if (executions.has(execution.attemptId)) issues.push(`Frozen attempts contain duplicate ${execution.attemptId}.`);
      executions.set(execution.attemptId, { scenarioId: scenario.scenarioId, execution });
      checkRefs(execution.evidenceRefs, `Attempt ${execution.attemptId}`);
    }));
    const launches = uniqueMap(value.launches, (launch) => launch.launchId, 'Observed launches', issues);
    const admitted = uniqueMap(context.admittedLaunches, (selection) => selection.launchId, 'Admitted launch selections', issues);
    context.admittedLaunches.forEach((selection) => {
      exactObject(selection, ['launchId', 'launchSha256'], 'Admitted launch selection', issues);
      text(selection.launchId, 'Admitted launch ID', issues);
      digest(selection.launchSha256, 'Admitted launch digest', issues);
    });
    let unavailable = false;
    value.launches.forEach((launch) => {
      const selection = admitted.get(launch.launchId);
      if (!selection) unavailable = true;
      else if (selection.launchSha256 !== qaProofDigest(launch)) issues.push(`Launch ${launch.launchId} differs from host capture.`);
      if (launch.artifactManifestSha256 !== binding.candidate.artifactManifestSha256)
        issues.push(`Launch ${launch.launchId} uses a different product artifact.`);
      checkRefs([launch.stdoutRef, launch.stderrRef], `Launch ${launch.launchId}`);
      if (launch.stdoutRef.kind !== 'stdout' || launch.stderrRef.kind !== 'stderr') issues.push(`Launch ${launch.launchId} lacks raw stdout/stderr references.`);
    });
    if ([...admitted.keys()].some((id) => !launches.has(id)))
      issues.push('Proof omits an admitted launch selection.');
    const attempts = uniqueMap(value.attempts, (attempt) => attempt.attemptId, 'Product attempt proofs', issues);
    if (!sameIds([...attempts.keys()], [...executions.keys()])) issues.push('Product attempt proofs do not exactly cover frozen attempts.');
    const usedLaunches = new Set<string>();
    value.attempts.forEach((attempt) => {
      const frozen = executions.get(attempt.attemptId);
      if (!frozen || frozen.scenarioId !== attempt.scenarioId || !scenarios.has(attempt.scenarioId)) {
        issues.push(`Attempt ${attempt.attemptId} has an unknown scenario/attempt join.`); return;
      }
      if (qaProofDigest(frozen.execution) !== attempt.executionSha256) issues.push(`Attempt ${attempt.attemptId} differs from frozen execution.`);
      if (frozen.execution.state === 'Executed') {
        const launch = attempt.launchId === null ? undefined : launches.get(attempt.launchId);
        if (!launch || launch.role !== 'product-control') issues.push(`Executed attempt ${attempt.attemptId} lacks a product-control launch.`);
        else {
          usedLaunches.add(launch.launchId);
          if (launch.completion !== 'completed') unavailable = true;
          if (!frozen.execution.evidenceRefs.some((ref) => qaProofDigest(ref) === qaProofDigest(launch.stdoutRef)))
            issues.push(`Attempt ${attempt.attemptId} does not join its raw control observation.`);
        }
      } else if (attempt.launchId !== null) issues.push(`Unexecuted attempt ${attempt.attemptId} claims a launch.`);
    });
    const evaluator = launches.get(value.semantic.evaluatorLaunchId);
    if (!evaluator || evaluator.role !== 'semantic-evaluator') issues.push('Semantic assessment lacks its evaluator launch.');
    else {
      usedLaunches.add(evaluator.launchId);
      if (evaluator.actorId === review.authorId) issues.push('QA author cannot be the semantic evaluator.');
      if (evaluator.completion !== 'completed' || (evaluator.exitCode !== null && evaluator.exitCode !== 0)) unavailable = true;
      if (evaluator.inputSha256 !== context.semanticInputSha256 || evaluator.outputSha256 !== qaProofDigest(value.semantic))
        issues.push('Semantic evaluator input/output differs from selected capture.');
      value.launches.filter((launch) => launch.role === 'product-control').forEach((launch) => {
        if (launch.contextId === evaluator.contextId ||
            (launch.processId !== null && launch.processId === evaluator.processId))
          issues.push('Semantic evaluator reused a product-control process/context.');
      });
    }
    if (usedLaunches.size !== launches.size) issues.push('Proof contains unused or additional evaluator launches.');
    const assessments = uniqueMap(value.semantic.scenarios, (assessment) => assessment.scenarioId, 'Semantic scenario assessments', issues);
    if (!sameIds([...assessments.keys()], [...scenarios.keys()])) issues.push('Semantic assessment must cover every frozen scenario exactly once.');
    const outcomes = uniqueMap(value.semantic.outcomes, (outcome) => outcome.intentId, 'Semantic outcome assessments', issues);
    if (!sameIds([...outcomes.keys()], [...intents.keys()])) issues.push('Semantic assessment must cover every approved outcome exactly once.');
    const findings = uniqueMap(value.semantic.findings, (finding) => finding.findingId, 'Semantic findings', issues);
    value.semantic.findings.forEach((finding) => {
      if (!finding.scenarioIds.length && !finding.intentIds.length) issues.push(`Finding ${finding.findingId} has no known scope.`);
      finding.scenarioIds.forEach((id) => { if (!scenarios.has(id)) issues.push(`Finding ${finding.findingId} references unknown scenario ${id}.`); });
      finding.intentIds.forEach((id) => {
        const intent = intents.get(id);
        if (!intent) issues.push(`Finding ${finding.findingId} references unknown intent ${id}.`);
        else if (finding.scenarioIds.length && !finding.scenarioIds.some((scenarioId) => {
          const scenario = scenarios.get(scenarioId);
          return scenario?.requirementRefs.includes(intent.requirementRef) && scenario.sourceRevision === intent.revision;
        })) issues.push(`Finding ${finding.findingId} references an unrelated intent ${id}.`);
      });
      if (['product-violation', 'weak-assertion'].includes(finding.kind) && !finding.intentIds.length)
        issues.push(`Finding ${finding.findingId} lacks its approved outcome join.`);
      finding.attemptIds.forEach((id) => {
        const frozen = executions.get(id);
        if (!frozen || !finding.scenarioIds.includes(frozen.scenarioId)) issues.push(`Finding ${finding.findingId} references an unrelated attempt ${id}.`);
      });
      checkRefs(finding.evidenceRefs, `Finding ${finding.findingId}`);
      const observationRefs = finding.attemptIds.flatMap((id) =>
        executions.get(id)?.execution.evidenceRefs ?? []).map(qaProofDigest);
      if (finding.attemptIds.length && finding.evidenceRefs.some((ref) =>
        !observationRefs.includes(qaProofDigest(ref))))
        issues.push(`Finding ${finding.findingId} adds unrelated observation evidence.`);
      if (finding.kind === 'product-violation' &&
          (!finding.attemptIds.length || !finding.evidenceRefs.length ||
           !finding.attemptIds.some((id) => executions.get(id)?.execution.state === 'Executed')))
        issues.push(`Product violation ${finding.findingId} lacks executed observation evidence.`);
    });
    value.semantic.scenarios.forEach((assessment) => {
      const scenario = scenarios.get(assessment.scenarioId);
      if (!scenario) return;
      if (!sameIds(assessment.attemptIds, scenario.executions.map((execution) => execution.attemptId)))
        issues.push(`Scenario ${scenario.scenarioId} omits or adds frozen attempts.`);
      if (!assessment.intentIds.length || assessment.intentIds.some((id) => {
        const intent = intents.get(id);
        return !intent || !scenario.requirementRefs.includes(intent.requirementRef) || intent.revision !== scenario.sourceRevision;
      }) || scenario.requirementRefs.some((ref) => !assessment.intentIds.some((id) => intents.get(id)?.requirementRef === ref)))
        issues.push(`Scenario ${scenario.scenarioId} has an incomplete or unknown intent join.`);
      checkRefs(assessment.evidenceRefs, `Scenario ${scenario.scenarioId} assessment`);
      const expectedRefs = scenario.executions.flatMap((execution) => execution.evidenceRefs).map(qaProofDigest);
      if (!sameIds(assessment.evidenceRefs.map(qaProofDigest), [...new Set(expectedRefs)]))
        issues.push(`Scenario ${scenario.scenarioId} assessment omits or adds its observation evidence.`);
      if (assessment.assessment !== 'unresolved' && (!scenario.executions.some((execution) => execution.state === 'Executed') || assessment.assertionAssessment !== 'sufficient'))
        issues.push(`Scenario ${scenario.scenarioId} claims a supported outcome without executed sufficient assertions.`);
      if (assessment.assessment !== 'unresolved' && !scenario.coverageBindings.some((coverage) =>
          coverage.designState === 'Selected' && coverage.kind !== 'Gap' &&
          ['Existing', 'Added', 'Updated'].includes(coverage.implementationState)))
        issues.push(`Scenario ${scenario.scenarioId} lacks selected implemented coverage for its supported conclusion.`);
      if (assessment.assessment === 'outcome-supported' && scenario.result !== 'Passed')
        issues.push(`Scenario ${scenario.scenarioId} outcome contradicts the frozen result.`);
      if (assessment.assessment === 'violation-supported' && scenario.result !== 'Failed')
        issues.push(`Scenario ${scenario.scenarioId} violation contradicts the frozen result.`);
      if (assessment.assertionAssessment === 'weak' && !value.semantic.findings.some((finding) => finding.kind === 'weak-assertion' && finding.scenarioIds.includes(scenario.scenarioId) && finding.severity !== 'Minor'))
        issues.push(`Scenario ${scenario.scenarioId} weak assertions lack an important semantic finding.`);
      if (assessment.assessment === 'violation-supported' && !value.semantic.findings.some((finding) => finding.kind === 'product-violation' && finding.scenarioIds.includes(scenario.scenarioId)))
        issues.push(`Scenario ${scenario.scenarioId} violation lacks a semantic finding.`);
    });
    value.semantic.outcomes.forEach((outcome) => {
      if (!intents.has(outcome.intentId)) return;
      outcome.scenarioIds.forEach((id) => { if (!assessments.get(id)?.intentIds.includes(outcome.intentId)) issues.push(`Outcome ${outcome.intentId} references an unrelated scenario.`); });
      outcome.findingIds.forEach((id) => { if (!findings.get(id)?.intentIds.includes(outcome.intentId)) issues.push(`Outcome ${outcome.intentId} references an unrelated finding.`); });
      if (outcome.coverage === 'covered' && !outcome.scenarioIds.length) issues.push(`Covered outcome ${outcome.intentId} has no scenario.`);
      if (outcome.coverage !== 'covered' && !outcome.findingIds.some((id) => {
        const finding = findings.get(id);
        return finding && finding.severity !== 'Minor' && (outcome.coverage !== 'missing' || finding.kind === 'missing-outcome');
      })) issues.push(`Missing/unresolved outcome ${outcome.intentId} lacks an important semantic challenge.`);
      if (outcome.coverage === 'covered' && [...assessments.values()].some((assessment) => assessment.intentIds.includes(outcome.intentId) && !outcome.scenarioIds.includes(assessment.scenarioId)))
        issues.push(`Outcome ${outcome.intentId} omits a linked scenario.`);
    });
    if (issues.length) return blocked('invalid', issues);
    if (unavailable) return blocked('unavailable', ['Admitted independent launch/control evidence is unavailable.']);
    const required = review.scenarios.filter((scenario) => scenario.obligation === 'Required');
    const incomplete = !required.length || required.some((scenario) => {
      const assessment = assessments.get(scenario.scenarioId)!;
      return assessment.assessment === 'unresolved' || assessment.assertionAssessment !== 'sufficient' ||
        !scenario.executions.some((execution) => execution.state === 'Executed');
    }) || value.semantic.outcomes.some((outcome) => outcome.coverage !== 'covered') ||
      value.semantic.findings.some((finding) => finding.kind !== 'product-violation' && finding.severity !== 'Minor') ||
      review.areaDecisions.some((decision) => decision.status === 'NeedsInvestigation');
    const productResult = incomplete ? 'blocked' : required.some((scenario) => assessments.get(scenario.scenarioId)!.assessment === 'violation-supported') ? 'failed' : 'passed';
    return { status: 'valid', issues: [], productResult,
      qaDisposition: productResult === 'passed' ? 'Passed' : productResult === 'failed' ? 'Failed' : 'BlockedOrIncomplete' };
  } catch {
    return blocked('invalid', [...issues, 'QA proof/context is malformed or cannot be hashed/validated.']);
  }
}
