import type { WorkerEvidenceReference } from '@temari/contracts';

import { assertQaAssignment, type QaFullAssignment } from './qa-assignment.js';
import type {
  QaExecutionEvidence,
  QaScenarioRecord,
  QaScenarioResult,
} from './qa-review-record.js';

export const BENNY_PATTERN_SOURCE =
  'cursor/plugins@adf3218ca2f5b9971eedc07a76bef22df7701539/pstack/automations/benny';

export interface QaCategorySearchIntent {
  readonly requirementRef: string;
  readonly requirementRevision: string;
  readonly authorityRef: string;
  readonly authorityEvidenceRef: string;
  readonly authorityStatus: 'Approved' | 'Unresolved';
  readonly expectedBehavior: string;
  readonly selectedCategory: string;
  readonly searchTerm: string;
  readonly expectedFixtureIds: readonly string[];
}

export interface QaExistingWork {
  readonly ownerRef?: string;
  readonly patchRef?: string;
}

export interface QaPriorConclusion {
  readonly requirementRevision: string;
  readonly candidateRef: string;
  readonly conclusionRef: string;
}

export interface QaCategorySearchReproductionRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly assignment: QaFullAssignment;
  readonly scenario: Pick<
    QaScenarioRecord,
    'scenarioId' | 'requirementRefs' | 'sourceRevision' | 'expectedBehavior'
  >;
  readonly intent: QaCategorySearchIntent;
  readonly reportRef: string;
  readonly operation: 'reproduce' | 'verify-fix';
  readonly fixtureRefs: readonly string[];
  readonly existingWork?: QaExistingWork;
  readonly priorConclusion?: QaPriorConclusion;
}

export interface QaCategorySearchObservation {
  readonly candidateRef: string;
  readonly environmentRef: string;
  readonly items: readonly {
    readonly id: string;
    readonly category: string;
  }[];
}

export interface QaCategorySearchControl {
  readonly id: string;
  search(request: {
    readonly candidateRef: string;
    readonly environmentRef: string;
    readonly selectedCategory: string;
    readonly searchTerm: string;
  }): Promise<QaCategorySearchObservation>;
}

export interface QaReproductionEvidenceSink {
  put(request: {
    readonly runId: string;
    readonly revision: string;
    readonly kind: 'verification';
    readonly content: string;
  }): Promise<WorkerEvidenceReference>;
}

export type QaReproductionVerdict =
  | 'Reproduced'
  | 'NotObserved'
  | 'VerifiedOnCandidate'
  | 'StillFailing'
  | 'Blocked';

export type QaReproductionBlocker =
  | 'environment-unavailable'
  | 'intent-unresolved'
  | 'action-not-authorized'
  | 'control-unavailable'
  | 'candidate-binding-mismatch'
  | 'evidence-store-unavailable';

export interface QaCategorySearchReproductionResult {
  readonly schemaVersion: 1;
  readonly scope: 'local-reproduction-evidence-only';
  readonly sourcePattern: typeof BENNY_PATTERN_SOURCE;
  readonly runId: string;
  readonly scenarioId: string;
  readonly requirementRef: string;
  readonly requirementRevision: string;
  readonly candidateRef: string;
  readonly environmentRef: string | null;
  readonly adapterId: string;
  readonly verdict: QaReproductionVerdict;
  readonly suggestedScenarioResult: QaScenarioResult;
  readonly blocker: QaReproductionBlocker | null;
  readonly priorConclusionStale: boolean;
  readonly ownershipAction:
    'verify-existing-patch' | 'handoff-existing-owner' | 'no-existing-work';
  readonly execution: QaExecutionEvidence;
  readonly finding:
    'suspected-product-defect' | 'no-symptom-observed' | 'unresolved';
  readonly qaDisposition: null;
}

export class QaControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaControlUnavailableError';
  }
}

const FIXTURE_ID = /^fixture-[A-Za-z0-9._-]+$/;

function required(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} is required.`);
}

function assertRequest(request: QaCategorySearchReproductionRequest): void {
  if (request.schemaVersion !== 1) throw new Error('Unsupported QA request.');
  assertQaAssignment(request.assignment);
  if (request.assignment.requestKind !== 'full') {
    throw new Error('Local reproduction requires a full QA assignment.');
  }
  required(request.runId, 'runId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.runId)) {
    throw new Error('runId must be a safe evidence identifier.');
  }
  required(request.attemptId, 'attemptId');
  required(request.reportRef, 'reportRef');
  required(request.scenario.scenarioId, 'scenarioId');
  required(request.intent.authorityRef, 'intent.authorityRef');
  required(request.intent.authorityEvidenceRef, 'intent.authorityEvidenceRef');
  if (
    request.intent.authorityStatus !== 'Approved' &&
    request.intent.authorityStatus !== 'Unresolved'
  ) {
    throw new Error('Intent authority status must be Approved or Unresolved.');
  }
  required(request.intent.expectedBehavior, 'intent.expectedBehavior');
  required(request.intent.selectedCategory, 'intent.selectedCategory');
  required(request.intent.searchTerm, 'intent.searchTerm');
  if (
    !/^category-[A-Za-z0-9._-]+$/.test(request.intent.selectedCategory) ||
    !/^[A-Za-z0-9._-]+$/.test(request.intent.searchTerm) ||
    request.fixtureRefs.some((ref) => !FIXTURE_ID.test(ref))
  ) {
    throw new Error(
      'Local reproduction accepts synthetic fixture inputs only.',
    );
  }
  if (
    !request.assignment.requirementRefs.includes(
      request.intent.requirementRef,
    ) ||
    request.assignment.requirementRevisions[
      request.assignment.requirementRefs.indexOf(request.intent.requirementRef)
    ] !== request.intent.requirementRevision ||
    !request.scenario.requirementRefs.includes(request.intent.requirementRef) ||
    request.scenario.sourceRevision !== request.intent.requirementRevision ||
    request.scenario.expectedBehavior !== request.intent.expectedBehavior
  ) {
    throw new Error(
      'Intent and scenario must match the assigned requirement revision.',
    );
  }
  if (request.intent.expectedFixtureIds.length === 0) {
    throw new Error('At least one expected fixture ID is required.');
  }
  if (
    request.intent.expectedFixtureIds.some((id) => !FIXTURE_ID.test(id)) ||
    new Set(request.intent.expectedFixtureIds).size !==
      request.intent.expectedFixtureIds.length ||
    request.intent.expectedFixtureIds.some(
      (id) => !request.fixtureRefs.includes(id),
    )
  ) {
    throw new Error(
      'Expected IDs must be unique synthetic IDs in the assigned fixture set.',
    );
  }
  if (request.operation !== 'reproduce' && request.operation !== 'verify-fix') {
    throw new Error('Unsupported QA reproduction operation.');
  }
}

function ownershipAction(
  existingWork: QaExistingWork | undefined,
): QaCategorySearchReproductionResult['ownershipAction'] {
  if (existingWork?.patchRef) return 'verify-existing-patch';
  if (existingWork?.ownerRef) return 'handoff-existing-owner';
  return 'no-existing-work';
}

function portableEvidence(
  reference: WorkerEvidenceReference,
): WorkerEvidenceReference {
  return {
    schema: reference.schema,
    runId: reference.runId,
    revision: reference.revision,
    kind: reference.kind,
    sha256: reference.sha256,
    bytes: reference.bytes,
  };
}

export async function runQaCategorySearchReproduction(
  request: QaCategorySearchReproductionRequest,
  control: QaCategorySearchControl,
  evidenceSink: QaReproductionEvidenceSink,
): Promise<QaCategorySearchReproductionResult> {
  assertRequest(request);
  required(control.id, 'control.id');
  const ownership = ownershipAction(request.existingWork);
  const priorConclusionStale =
    request.priorConclusion !== undefined &&
    request.priorConclusion.requirementRevision !==
      request.intent.requirementRevision;
  const candidateRef = request.assignment.candidateRef;
  const environmentRef = request.assignment.environmentRef ?? null;

  const blocked = (
    blocker: QaReproductionBlocker,
  ): QaCategorySearchReproductionResult => ({
    schemaVersion: 1,
    scope: 'local-reproduction-evidence-only',
    sourcePattern: BENNY_PATTERN_SOURCE,
    runId: request.runId,
    scenarioId: request.scenario.scenarioId,
    requirementRef: request.intent.requirementRef,
    requirementRevision: request.intent.requirementRevision,
    candidateRef,
    environmentRef,
    adapterId: control.id,
    verdict: 'Blocked',
    suggestedScenarioResult: 'BlockedOrIncomplete',
    blocker,
    priorConclusionStale,
    ownershipAction: ownership,
    execution: {
      attemptId: request.attemptId,
      candidateRef,
      environmentRef: environmentRef ?? 'unavailable',
      fixtureRefs: request.fixtureRefs,
      correlationRef: request.reportRef,
      boundedObservation: blocker,
      assertions: [],
      observations: [],
      evidenceRefs: [],
      state: 'Blocked',
    },
    finding: 'unresolved',
    qaDisposition: null,
  });

  if (request.intent.authorityStatus === 'Unresolved') {
    return blocked('intent-unresolved');
  }
  if (!environmentRef) return blocked('environment-unavailable');
  if (
    !request.assignment.authority.allowedActions.includes(
      'qa:read-category-search',
    ) ||
    request.assignment.authority.deniedActions.includes(
      'qa:read-category-search',
    )
  ) {
    return blocked('action-not-authorized');
  }

  let observation: QaCategorySearchObservation;
  try {
    observation = await control.search({
      candidateRef,
      environmentRef,
      selectedCategory: request.intent.selectedCategory,
      searchTerm: request.intent.searchTerm,
    });
  } catch (error) {
    if (error instanceof QaControlUnavailableError) {
      return blocked('control-unavailable');
    }
    throw error;
  }
  if (
    observation.candidateRef !== candidateRef ||
    observation.environmentRef !== environmentRef
  ) {
    return blocked('candidate-binding-mismatch');
  }
  if (
    observation.items.some(
      (item) =>
        !FIXTURE_ID.test(item.id) ||
        !/^category-[A-Za-z0-9._-]+$/.test(item.category),
    )
  ) {
    throw new Error('Control returned a non-synthetic fixture observation.');
  }

  const actualIds = observation.items.map((item) => item.id).sort();
  const expectedIds = [...request.intent.expectedFixtureIds].sort();
  const matchesIntent =
    actualIds.length === expectedIds.length &&
    actualIds.every((id, index) => id === expectedIds[index]) &&
    observation.items.every(
      (item) => item.category === request.intent.selectedCategory,
    );
  const verdict: QaReproductionVerdict = matchesIntent
    ? request.operation === 'reproduce'
      ? 'NotObserved'
      : 'VerifiedOnCandidate'
    : request.operation === 'reproduce'
      ? 'Reproduced'
      : 'StillFailing';
  const suggestedScenarioResult: QaScenarioResult = matchesIntent
    ? request.operation === 'reproduce'
      ? 'BlockedOrIncomplete'
      : 'Passed'
    : 'Failed';

  let reference: WorkerEvidenceReference;
  try {
    reference = portableEvidence(
      await evidenceSink.put({
        runId: request.runId,
        revision: candidateRef,
        kind: 'verification',
        content: JSON.stringify({
          schemaVersion: 1,
          scenarioId: request.scenario.scenarioId,
          requirementRef: request.intent.requirementRef,
          requirementRevision: request.intent.requirementRevision,
          authorityRef: request.intent.authorityRef,
          authorityEvidenceRef: request.intent.authorityEvidenceRef,
          candidateRef,
          environmentRef,
          selectedCategory: request.intent.selectedCategory,
          expectedFixtureIds: expectedIds,
          observedFixtureIds: actualIds,
          observedCategories: observation.items.map((item) => item.category),
          matchesIntent,
          verdict,
          priorConclusionStale,
          ownershipAction: ownership,
        }),
      }),
    );
  } catch {
    return blocked('evidence-store-unavailable');
  }

  return {
    schemaVersion: 1,
    scope: 'local-reproduction-evidence-only',
    sourcePattern: BENNY_PATTERN_SOURCE,
    runId: request.runId,
    scenarioId: request.scenario.scenarioId,
    requirementRef: request.intent.requirementRef,
    requirementRevision: request.intent.requirementRevision,
    candidateRef,
    environmentRef,
    adapterId: control.id,
    verdict,
    suggestedScenarioResult,
    blocker: null,
    priorConclusionStale,
    ownershipAction: ownership,
    execution: {
      attemptId: request.attemptId,
      candidateRef,
      environmentRef,
      fixtureRefs: request.fixtureRefs,
      correlationRef: request.reportRef,
      boundedObservation: matchesIntent
        ? 'Synthetic category search matched the requirement-derived fixture result.'
        : 'Synthetic category search differed from the requirement-derived fixture result.',
      assertions: [
        `Results match the independently selected fixture IDs for ${request.intent.authorityRef}.`,
        `Every result belongs to category ${request.intent.selectedCategory}.`,
      ],
      observations: [
        `Observed ${actualIds.length} synthetic fixture result(s).`,
        `Requirement revision ${request.intent.requirementRevision}; verdict ${verdict}.`,
      ],
      evidenceRefs: [reference],
      state: 'Executed',
    },
    finding: matchesIntent ? 'no-symptom-observed' : 'suspected-product-defect',
    qaDisposition: null,
  };
}
