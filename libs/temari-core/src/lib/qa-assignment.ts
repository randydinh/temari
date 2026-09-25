export type QaAssignmentRequestKind = 'full' | 'narrow';

export type QaReviewTier = 'focused' | 'standard' | 'high-risk';

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface QaAssignmentAuthority {
  readonly allowedActions: readonly string[];
  readonly deniedActions: NonEmptyReadonlyArray<string>;
}

interface QaAssignmentBase {
  readonly assignmentId: string;
  readonly requestKind: QaAssignmentRequestKind;
  readonly tier: QaReviewTier;
  readonly requestedScope: string;
  readonly excludedScope: readonly string[];
  readonly ticketRef: string | null;
  readonly ticketRevision: string | null;
  readonly requirementRefs: readonly string[];
  readonly requirementRevisions: readonly string[];
  readonly candidateRef: string | null;
  readonly authority: QaAssignmentAuthority;
  readonly knownConstraints: readonly string[];
}

type QaResolvedExecutionContext =
  | {
      readonly environmentRef: string;
      readonly missingEnvironmentBlocker?: never;
    }
  | {
      readonly environmentRef?: never;
      readonly missingEnvironmentBlocker: string;
    };

type QaNarrowExecutionContext =
  | {
      readonly environmentRef?: never;
      readonly missingEnvironmentBlocker?: never;
    }
  | QaResolvedExecutionContext;

export type QaFullAssignment = QaAssignmentBase & {
  readonly requestKind: 'full';
  readonly ticketRef: string;
  readonly ticketRevision: string;
  readonly requirementRefs: NonEmptyReadonlyArray<string>;
  readonly requirementRevisions: NonEmptyReadonlyArray<string>;
  readonly candidateRef: string;
} & QaResolvedExecutionContext;

export type QaNarrowAssignment = QaAssignmentBase & {
  readonly requestKind: 'narrow';
  readonly tier: 'focused';
} & QaNarrowExecutionContext;

export type QaAssignment = QaFullAssignment | QaNarrowAssignment;

function nonEmpty(
  value: string | null | undefined,
  field: string,
  issues: string[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${field} must not be empty.`);
  }
}

function textList(
  values: readonly string[],
  field: string,
  issues: string[],
): void {
  values.forEach((value, index) =>
    nonEmpty(value, `${field}[${index}]`, issues),
  );
}

function validateContext(assignment: QaAssignment, issues: string[]): void {
  const hasEnvironment = assignment.environmentRef !== undefined;
  const hasBlocker = assignment.missingEnvironmentBlocker !== undefined;

  if (assignment.requestKind === 'full' && hasEnvironment === hasBlocker) {
    issues.push(
      'full assignments require exactly one environmentRef or missingEnvironmentBlocker.',
    );
  }

  if (hasEnvironment) {
    nonEmpty(assignment.environmentRef, 'environmentRef', issues);
  }
  if (hasBlocker) {
    nonEmpty(
      assignment.missingEnvironmentBlocker,
      'missingEnvironmentBlocker',
      issues,
    );
  }
}

/** Validate assignment shape without judging coverage, evidence, or disposition. */
export function validateQaAssignment(
  assignment: QaAssignment,
): readonly string[] {
  const issues: string[] = [];
  nonEmpty(assignment.assignmentId, 'assignmentId', issues);
  nonEmpty(assignment.requestedScope, 'requestedScope', issues);
  textList(assignment.excludedScope, 'excludedScope', issues);
  textList(
    assignment.authority.allowedActions,
    'authority.allowedActions',
    issues,
  );
  textList(
    assignment.authority.deniedActions,
    'authority.deniedActions',
    issues,
  );
  if (assignment.authority.deniedActions.length === 0) {
    issues.push('authority.deniedActions must contain at least one boundary.');
  }
  textList(assignment.knownConstraints, 'knownConstraints', issues);

  if (
    assignment.requestKind !== 'full' &&
    assignment.requestKind !== 'narrow'
  ) {
    issues.push('requestKind must be full or narrow.');
  }
  if (
    assignment.tier !== 'focused' &&
    assignment.tier !== 'standard' &&
    assignment.tier !== 'high-risk'
  ) {
    issues.push('tier must be focused, standard, or high-risk.');
  }
  if (assignment.requestKind === 'full' && assignment.tier === 'focused') {
    issues.push('full assignments must use standard or high-risk tier.');
  }
  if (assignment.requestKind === 'narrow' && assignment.tier !== 'focused') {
    issues.push('narrow assignments must use the focused tier.');
  }

  const hasTicketRef = assignment.ticketRef !== null;
  const hasTicketRevision = assignment.ticketRevision !== null;
  if (hasTicketRef !== hasTicketRevision) {
    issues.push('ticketRef and ticketRevision must be supplied together.');
  }
  if (hasTicketRef) nonEmpty(assignment.ticketRef, 'ticketRef', issues);
  if (hasTicketRevision) {
    nonEmpty(assignment.ticketRevision, 'ticketRevision', issues);
  }

  if (
    assignment.requirementRefs.length !== assignment.requirementRevisions.length
  ) {
    issues.push(
      'requirementRefs and requirementRevisions must contain the same number of entries.',
    );
  }
  textList(assignment.requirementRefs, 'requirementRefs', issues);
  textList(assignment.requirementRevisions, 'requirementRevisions', issues);

  if (assignment.requestKind === 'full') {
    nonEmpty(assignment.ticketRef, 'ticketRef', issues);
    nonEmpty(assignment.ticketRevision, 'ticketRevision', issues);
    nonEmpty(assignment.candidateRef, 'candidateRef', issues);
    if (assignment.requirementRefs.length === 0) {
      issues.push(
        'full assignments require at least one requirement reference.',
      );
    }
    if (assignment.requirementRevisions.length === 0) {
      issues.push(
        'full assignments require at least one requirement revision.',
      );
    }
  } else if (assignment.candidateRef !== null) {
    nonEmpty(assignment.candidateRef, 'candidateRef', issues);
  }

  validateContext(assignment, issues);
  return issues;
}

export function assertQaAssignment(assignment: QaAssignment): void {
  const issues = validateQaAssignment(assignment);
  if (issues.length > 0) {
    throw new Error(`Invalid QaAssignment: ${issues.join(' ')}`);
  }
}
