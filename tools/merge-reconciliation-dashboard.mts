import { createHash } from 'node:crypto';
import {
  assertInitialReconciliationPlan,
  assertMergeObservation,
  assertReconciliationBinding,
  assertReconciliationConfirmation,
  type MergeObservation,
  type ReconciliationConfirmation,
  type ReconciliationPlan,
  type ReconciliationScope,
  type ReconciliationStatus,
  type ImmutableEvidenceReference,
} from '../libs/contracts/src/index.js';
import {
  reconciliationStoreDigest,
  type CreateReconciliationAttemptRequest,
  type ReconciliationAttempt,
  type ReconciliationAttemptBinding,
} from '../libs/runtime/src/index.js';
import {
  observeGitReconciliation,
  type GitReconciliationObservation,
} from '../libs/host-adapters/src/lib/git-reconciliation-observer.js';

/** Dashboard-only view state. None of these states closes a Temari task. */
export type MergeReconciliationDashboardState = ReconciliationStatus;

export interface MergeReconciliationDashboardView {
  readonly attemptId: string;
  readonly state: MergeReconciliationDashboardState;
  readonly blockedReason: string | null;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidate: {
    readonly id: string;
    readonly sha256: string;
    /** Ready candidates still require human review; this is never terminal. */
    readonly readiness: 'not-ready';
  };
  readonly requiresConfirmation: boolean;
  readonly canConfirm: boolean;
  /** Always false: reconciliation readiness is not task completion. */
  readonly terminal: false;
}

export interface ReconciliationIntentStore {
  /** Optional only for compatibility with older custom intent adapters. */
  list?(): Promise<readonly ReconciliationAttempt[]>;
  get(id: string): Promise<ReconciliationAttempt | null>;
  createAttempt(request: CreateReconciliationAttemptRequest): Promise<ReconciliationAttempt>;
  invalidateStaleBinding(
    id: string,
    current: ReconciliationAttemptBinding,
    reason?: string,
  ): Promise<ReconciliationAttempt>;
  confirm(
    id: string,
    confirmation: ReconciliationConfirmation,
    current: ReconciliationAttemptBinding,
  ): Promise<ReconciliationAttempt>;
}

export interface BrowserReviewSelection {
  readonly selectedAttempts: readonly { readonly attemptId:string; readonly reviewSha256:string }[];
}
export interface ReconciliationAttemptSummary {
  readonly attemptId:string; readonly retainedStatus:ReconciliationAttempt['status'];
  readonly state:ReconciliationStatus; readonly classification:ReconciliationPlan['classification'];
  readonly summary:string|null; readonly summaryTruncated:boolean; readonly taskId:string; readonly runId:string;
  readonly createdAt:string; readonly updatedAt:string; readonly blockedReason:string|null;
  readonly confirmationRecorded:boolean; readonly hostSelectedForReview:boolean;
  readonly candidate:{readonly id:string;readonly sha256:string;readonly readiness:'not-ready'};
  readonly terminal:false;
}
export interface ReconciliationList {
  readonly configured:boolean; readonly setupReason:string|null;
  readonly attempts:readonly ReconciliationAttemptSummary[];
  readonly page:{readonly total:number;readonly limit:50;readonly omitted:number};
  readonly capabilities:{readonly canCheckCurrentBinding:boolean;readonly canRecordConfirmationIntent:boolean};
}
export interface RetainedReviewPayload {
  readonly schema:1; readonly attemptId:string; readonly binding:ReconciliationAttemptBinding;
  readonly observation:{readonly observationId:string;readonly observedAt:string;readonly kind:MergeObservation['kind'];readonly evidence:readonly ImmutableEvidenceReference[]};
  readonly plan:{readonly planId:string;readonly classification:ReconciliationPlan['classification'];readonly initialStatus:'observed'|'blocked'|'awaiting-confirmation';readonly summary:string;readonly actions:ReconciliationPlan['actions'];readonly request:ReconciliationPlan['request'];readonly evidence:readonly ImmutableEvidenceReference[]};
  readonly scope:ReconciliationScope;
}
export interface ReconciliationBindingCheck {
  readonly state:'not-checked'|'matched'|'drift'|'unavailable';
  readonly beganAt:string|null;readonly endedAt:string|null;
  readonly changedFields:readonly (keyof ReconciliationAttemptBinding)[];readonly reasonCode:string|null;
}
export interface ReconciliationReview {
  readonly schema:1;readonly attempt:ReconciliationAttemptSummary;
  readonly review:{readonly complete:boolean;readonly sha256:string|null;readonly payload:RetainedReviewPayload|null;readonly reasonCode:string|null};
  readonly admission:{readonly hostSelected:boolean;readonly reasonCode:string|null};
  readonly currentBinding:ReconciliationBindingCheck;
  readonly confirmation:null|{readonly confirmationId:string;readonly requestId:string|null;readonly planId:string;readonly observationId:string;readonly canonicalRequestSha256:string;readonly confirmedAt:string;readonly actorKind:'local-dashboard-interaction'|'retained-external-record';readonly evidence:readonly ImmutableEvidenceReference[]};
  readonly capabilities:{readonly canCheckCurrentBinding:boolean;readonly canRecordConfirmationIntent:boolean};
  readonly effects:{readonly mode:'recorded-intent-only';readonly sourceOperations:'none';readonly taskAcceptance:'none';readonly archiveOperations:'none';readonly terminal:false};
}
export interface RecordReviewedConfirmationRequest {readonly requestId:string;readonly reviewSha256:string}
export interface RecordReviewedConfirmationResult {
  readonly schema:1;readonly requestId:string;readonly outcome:'recorded'|'replayed'|'blocked'|'refused';
  readonly reasonCode:string|null;readonly review:ReconciliationReview;
}
export interface ReconciliationInteractionEvent {
  readonly schema:1;readonly kind:'temari-reconciliation-dashboard-interaction';
  readonly attemptId:string;readonly requestId:string;readonly planId:string;readonly observationId:string;
  readonly reviewSha256:string;readonly canonicalRequestSha256:string;readonly expectedBindingSha256:string;
  readonly bindingCheck:{readonly state:'matched';readonly beganAt:string;readonly endedAt:string;readonly changedFields:readonly [];readonly reasonCode:null};
  readonly actorKind:'local-dashboard-interaction';readonly receivedAt:string;
}
export interface RetainedReconciliationInteraction {
  readonly bytes:Uint8Array;readonly evidence:ImmutableEvidenceReference;
}
export interface ReconciliationInteractionWriter {
  read(input:{readonly attemptId:string;readonly requestId:string}):Promise<RetainedReconciliationInteraction|null>;
  /** Only resolves this host's dedicated retained evidence identities, never a URI/path. */
  readRecorded(input:{readonly attemptId:string;readonly evidenceId:string}):Promise<RetainedReconciliationInteraction|null>;
  publish(event:ReconciliationInteractionEvent):Promise<void>;
}
export interface ReconciliationBrowserOptions {
  readonly browserReview?:BrowserReviewSelection;
  readonly interactionWriter?:ReconciliationInteractionWriter;
  /** Trusted host clock injection; never a browser field. */
  readonly now?:()=>Date;
}
export class ReconciliationBrowserRequestError extends Error {
  override readonly name='ReconciliationBrowserRequestError';
  constructor(readonly status:number,message:string){super(message);}
}
export function reconciliationInteractionIdentity(attemptId:string,requestId:string):{eventId:string;confirmationId:string} {
  assertAttemptId(attemptId);assertAttemptId(requestId);
  const digest=reconciliationStoreDigest({attemptId,requestId});
  return {eventId:'reconciliation-interaction-'+digest,confirmationId:'confirm-dashboard-'+digest};
}

/**
 * Reads the binding from trusted task/run/candidate and Git observation
 * sources. It intentionally receives only retained attempt identity, never
 * HTTP request data, so a caller cannot select the binding it wants to
 * confirm.
 */
export interface CurrentReconciliationBindingReader {
  readCurrentBinding(input: {
    readonly attemptId: string;
    readonly expected: ReconciliationAttemptBinding;
  }): Promise<ReconciliationAttemptBinding>;
}

export interface ReconciliationConfirmationIntent {
  readonly attemptId: string;
  readonly confirmation: ReconciliationConfirmation;
}

export interface ReconciliationInvalidationIntent {
  readonly attemptId: string;
}

/**
 * Task/run/candidate information deliberately comes from an injected trusted
 * reader. Git observation alone cannot establish those non-Git identities.
 */
export interface TrustedReconciliationScopeSnapshot {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidateId: string;
  readonly candidateSha256: string;
  readonly candidateRoot: ReconciliationScope['candidateRoot'];
  readonly resolutionIntent: ReconciliationScope['resolutionIntent'];
  readonly requiredChecks: ReconciliationScope['requiredChecks'];
  readonly expectedComparison: ReconciliationScope['expectedComparison'];
}

export interface TrustedReconciliationScopeSnapshotReader {
  readCurrentSnapshot(input: {
    readonly attemptId: string;
    readonly expected: ReconciliationAttemptBinding;
  }): Promise<TrustedReconciliationScopeSnapshot>;
}

export function observedGitReconciliationScope(
  git: GitReconciliationObservation,
  snapshot: TrustedReconciliationScopeSnapshot,
): ReconciliationScope {
  if (git.paths.length === 0) {
    throw new Error('No affected Git paths; no reconciliation attempt prepared.');
  }
  return observedGitReconciliationScopeIdentity(git, snapshot);
}

/**
 * The same canonical projection is used for preparation and live comparison.
 * An empty live projection can invalidate a retained attempt, but is never
 * admitted by observedGitReconciliationScope as a new reconciliation scope.
 * Raw Git object IDs remain unchanged in the observer evidence.
 */
function observedGitReconciliationScopeIdentity(
  git: GitReconciliationObservation,
  snapshot: TrustedReconciliationScopeSnapshot,
): ReconciliationScope {
  const unmerged = new Map(git.unmerged.map((entry) => [entry.path, entry.stages]));
  const untracked = new Set(git.untrackedPaths);
  const head = reconciliationStoreDigest({ headObjectId: git.source.headObjectId });
  return {
    schema: 1,
    sourceRoot: {
      id: 'git-source-root-v1',
      sha256: reconciliationStoreDigest({
        headObjectId: git.source.headObjectId,
        headReference: git.source.headReference,
      }),
    },
    candidateRoot: snapshot.candidateRoot,
    baseHead: { id: 'git-base-head-v1', sha256: head },
    operationHead: { id: `git-${git.operation}`, sha256: git.porcelainSha256 },
    affectedPaths: [...git.paths].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => ({
      path: entry.path,
      pathSha256: entry.pathSha256,
      indexBlobs: [...entry.indexBlobs]
        .sort((left, right) => left.stage - right.stage)
        .map(({ stage, mode, objectId }) => ({ stage, mode, objectId })),
      unmergedStages: [...(unmerged.get(entry.path) ?? [])]
        .sort((left, right) => left.stage - right.stage)
        .map(({ stage, mode, objectId }) => ({ stage, mode, objectId })),
      worktreeKind: entry.worktreeKind,
      worktreeSha256: entry.worktreeSha256,
      diffSha256: entry.diffSha256,
      classification: unmerged.has(entry.path)
        ? 'unmerged' as const
        : untracked.has(entry.path)
          ? 'untracked' as const
          : 'tracked' as const,
    })),
    resolutionIntent: snapshot.resolutionIntent,
    requiredChecks: snapshot.requiredChecks,
    expectedComparison: snapshot.expectedComparison,
  };
}

/**
 * Compose the read-only Git observer with explicit trusted task/run/candidate
 * sources. To use this in production, create the original observation scope
 * with the same composition; a changed Git or non-Git snapshot then produces
 * a different binding and the store blocks confirmation.
 */
export function createObservedGitReconciliationBindingReader(options: {
  readonly repositoryRoot: string;
  readonly snapshotReader: TrustedReconciliationScopeSnapshotReader;
  readonly observe?: (repositoryRoot: string) => Promise<GitReconciliationObservation>;
}): CurrentReconciliationBindingReader {
  const observe = options.observe ?? observeGitReconciliation;
  return {
    async readCurrentBinding(input) {
      const [snapshot, git] = await Promise.all([
        options.snapshotReader.readCurrentSnapshot(input),
        observe(options.repositoryRoot),
      ]);
      return {
        taskId: snapshot.taskId,
        taskVersion: snapshot.taskVersion,
        runId: snapshot.runId,
        revision: snapshot.revision,
        observationId: snapshot.observationId,
        candidateId: snapshot.candidateId,
        candidateSha256: snapshot.candidateSha256,
        scopeSha256: reconciliationStoreDigest(observedGitReconciliationScopeIdentity(git, snapshot)),
      };
    },
  };
}

/**
 * A pure projection from durable attempt records. Human confirmation is only
 * retained evidence: it never claims executor integration, verification, or
 * candidate comparison. Stale bindings take precedence and stay visibly
 * blocked with their retained invalidation reason.
 */
export function projectMergeReconciliationAttempt(
  attempt: ReconciliationAttempt,
): MergeReconciliationDashboardView {
  const state: MergeReconciliationDashboardState = attempt.status === 'BLOCKED'
    ? 'blocked'
    : attempt.status === 'CONFIRMED'
      ? 'observed'
      : attempt.plan.status;
  const requiresConfirmation = attempt.plan.classification === 'requires-confirmation';
  return {
    attemptId: attempt.id,
    state,
    blockedReason: state === 'blocked'
      ? attempt.blockedReason ?? attempt.plan.blockedReason ?? 'Reconciliation is blocked.'
      : null,
    taskId: attempt.binding.taskId,
    taskVersion: attempt.binding.taskVersion,
    runId: attempt.binding.runId,
    revision: attempt.binding.revision,
    observationId: attempt.binding.observationId,
    candidate: {
      id: attempt.binding.candidateId,
      sha256: attempt.binding.candidateSha256,
      readiness: 'not-ready',
    },
    requiresConfirmation,
    canConfirm: attempt.status === 'PENDING' && requiresConfirmation && state === 'awaiting-confirmation',
    terminal: false,
  };
}

function assertAttemptId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Invalid reconciliation attempt ID.');
  }
}

function assertBinding(value: ReconciliationAttemptBinding): void {
  const fields: (keyof ReconciliationAttemptBinding)[] = [
    'taskId', 'taskVersion', 'runId', 'revision', 'observationId', 'candidateId', 'candidateSha256', 'scopeSha256',
  ];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== fields.length
    || fields.some((field) => typeof value[field] !== 'string' || value[field].length === 0)) {
    throw new Error('Invalid current reconciliation binding.');
  }
}

const bindingFields:readonly (keyof ReconciliationAttemptBinding)[]=[
  'taskId','taskVersion','runId','revision','observationId','candidateId','candidateSha256','scopeSha256',
];
const emptyCheck:ReconciliationBindingCheck={state:'not-checked',beganAt:null,endedAt:null,changedFields:[],reasonCode:null};
const noEffects={mode:'recorded-intent-only',sourceOperations:'none',taskAcceptance:'none',archiveOperations:'none',terminal:false} as const;
const browserBounds={list:50,attempts:1024,selections:128,paths:128,reviewBytes:64*1024,eventBytes:16*1024};
function browserId(value:unknown):asserts value is string {
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw new ReconciliationBrowserRequestError(400,'Invalid reconciliation identity.');
}
function hash(value:unknown):asserts value is string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new ReconciliationBrowserRequestError(400,'Invalid reconciliation review digest.');
}
function keys(value:unknown,names:readonly string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||Object.keys(value).some((key)=>!names.includes(key)))throw new ReconciliationBrowserRequestError(400,'Unexpected reconciliation fields.');
}
function iso(value:string):boolean {return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function evidenceProjection(ref:ImmutableEvidenceReference):ImmutableEvidenceReference {
  keys(ref,['schema','id','sha256','bytes','mediaType']);browserId(ref.id);hash(ref.sha256);
  if(ref.schema!==1||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||typeof ref.mediaType!=='string'||ref.mediaType.length>128||!/^\S+\/\S+$/.test(ref.mediaType))throw new Error('Invalid retained evidence metadata.');
  return {schema:1,id:ref.id,sha256:ref.sha256,bytes:ref.bytes,mediaType:ref.mediaType};
}
/** Host utility: complete fixed metadata projection, never an evidence resolver. */
export function projectRetainedReconciliationReview(attempt:ReconciliationAttempt):ReconciliationReview['review'] {
  try {
    assertMergeObservation(attempt.observation);assertInitialReconciliationPlan(attempt.plan);
    assertReconciliationBinding(attempt.plan,attempt.observation);assertBinding(attempt.binding);
    const observation=attempt.observation,plan=attempt.plan,scope=observation.scope;
    browserId(attempt.id);
    const expectedBinding:ReconciliationAttemptBinding={taskId:observation.taskId,taskVersion:observation.taskVersion,runId:observation.runId,revision:observation.revision,observationId:observation.observationId,candidateId:observation.candidate.id,candidateSha256:observation.candidate.sha256,scopeSha256:reconciliationStoreDigest(scope)};
    if(reconciliationStoreDigest(attempt.binding)!==reconciliationStoreDigest(expectedBinding)||!iso(attempt.createdAt)||!iso(attempt.updatedAt))throw new Error('Retained attempt metadata differs from its observation.');
    if(scope.affectedPaths.length>browserBounds.paths)return {complete:false,sha256:null,payload:null,reasonCode:'review-too-large'};
    keys(scope,['schema','sourceRoot','candidateRoot','baseHead','operationHead','affectedPaths','resolutionIntent','requiredChecks','expectedComparison']);
    const root=(value:ReconciliationScope['sourceRoot'])=>{keys(value,['id','sha256']);return {id:value.id,sha256:value.sha256};};
    const projectedScope:ReconciliationScope={
      schema:1,sourceRoot:root(scope.sourceRoot),candidateRoot:root(scope.candidateRoot),baseHead:root(scope.baseHead),operationHead:root(scope.operationHead),
      affectedPaths:scope.affectedPaths.map((entry)=>{
        keys(entry,['path','pathSha256','classification','indexBlobs','unmergedStages','worktreeKind','worktreeSha256','diffSha256']);
        const stage=(blob:ReconciliationScope['affectedPaths'][number]['indexBlobs'][number])=>{keys(blob,['stage','mode','objectId']);return {stage:blob.stage,mode:blob.mode,objectId:blob.objectId};};
        return {path:entry.path,pathSha256:entry.pathSha256,classification:entry.classification,indexBlobs:entry.indexBlobs.map(stage),unmergedStages:entry.unmergedStages.map((blob)=>({...stage(blob),stage:blob.stage})),worktreeKind:entry.worktreeKind,worktreeSha256:entry.worktreeSha256,diffSha256:entry.diffSha256};
      }),
      resolutionIntent:scope.resolutionIntent,
      requiredChecks:scope.requiredChecks.map((check)=>{keys(check,['id','definitionSha256']);return {id:check.id,definitionSha256:check.definitionSha256};}),
      expectedComparison:{candidateEvidence:evidenceProjection(scope.expectedComparison.candidateEvidence),verificationEvidence:evidenceProjection(scope.expectedComparison.verificationEvidence)},
    };
    keys(scope.expectedComparison,['candidateEvidence','verificationEvidence']);
    if(reconciliationStoreDigest(scope)!==reconciliationStoreDigest(projectedScope)||attempt.binding.scopeSha256!==reconciliationStoreDigest(scope)||attempt.canonicalRequestDigest!==plan.request.canonicalRequestSha256)throw new Error('Retained review scope differs from binding.');
    if(typeof plan.summary!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plan.summary)||/[\u0000-\u001f\u007f]/.test(attempt.binding.revision))throw new Error('Invalid retained review text.');
    const payload:RetainedReviewPayload={schema:1,attemptId:attempt.id,binding:{...attempt.binding},
      observation:{observationId:observation.observationId,observedAt:observation.observedAt,kind:observation.kind,evidence:observation.evidence.map(evidenceProjection)},
      plan:{planId:plan.id,classification:plan.classification,initialStatus:plan.status as RetainedReviewPayload['plan']['initialStatus'],summary:plan.summary,actions:plan.actions.map((action)=>({id:action.id,kind:action.kind,targetId:action.targetId})),request:{idempotencyKey:plan.request.idempotencyKey,canonicalRequestDigestAlgorithm:plan.request.canonicalRequestDigestAlgorithm,canonicalRequestSha256:plan.request.canonicalRequestSha256},evidence:plan.evidence.map(evidenceProjection)},scope:projectedScope};
    if(Buffer.byteLength(JSON.stringify(payload))>browserBounds.reviewBytes)return {complete:false,sha256:null,payload:null,reasonCode:'review-too-large'};
    return {complete:true,sha256:reconciliationStoreDigest(payload),payload,reasonCode:null};
  }catch{return {complete:false,sha256:null,payload:null,reasonCode:'invalid-retained-review'};}
}

function validateInteraction(retained:RetainedReconciliationInteraction,attempt:ReconciliationAttempt,request?:RecordReviewedConfirmationRequest):ReconciliationInteractionEvent {
  const bytes=Buffer.from(retained.bytes);
  if(bytes.length>browserBounds.eventBytes)throw new Error('Interaction evidence exceeds bound.');
  const ref=evidenceProjection(retained.evidence);
  if(ref.bytes!==bytes.length||ref.sha256!==createHash('sha256').update(bytes).digest('hex')||ref.mediaType!=='application/json')throw new Error('Interaction evidence readback differs from reference.');
  const event:ReconciliationInteractionEvent=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  keys(event,['schema','kind','attemptId','requestId','planId','observationId','reviewSha256','canonicalRequestSha256','expectedBindingSha256','bindingCheck','actorKind','receivedAt']);
  browserId(event.requestId);hash(event.reviewSha256);
  keys(event.bindingCheck,['state','beganAt','endedAt','changedFields','reasonCode']);
  const identity=reconciliationInteractionIdentity(attempt.id,event.requestId),review=projectRetainedReconciliationReview(attempt);
  if(event.schema!==1||event.kind!=='temari-reconciliation-dashboard-interaction'||event.actorKind!=='local-dashboard-interaction'||event.attemptId!==attempt.id||event.planId!==attempt.plan.id||event.observationId!==attempt.binding.observationId||event.canonicalRequestSha256!==attempt.canonicalRequestDigest||event.expectedBindingSha256!==reconciliationStoreDigest(attempt.binding)||!review.complete||event.reviewSha256!==review.sha256||ref.id!==identity.eventId||!iso(event.receivedAt)||event.bindingCheck.state!=='matched'||event.bindingCheck.reasonCode!==null||!Array.isArray(event.bindingCheck.changedFields)||event.bindingCheck.changedFields.length!==0||!iso(event.bindingCheck.beganAt)||!iso(event.bindingCheck.endedAt)||Date.parse(event.bindingCheck.endedAt)<Date.parse(event.bindingCheck.beganAt)||Date.parse(event.receivedAt)<Date.parse(event.bindingCheck.endedAt))throw new Error('Interaction evidence binding is invalid.');
  if(request&&(event.requestId!==request.requestId||event.reviewSha256!==request.reviewSha256))throw new Error('Interaction retry differs from retained event.');
  return event;
}

/**
 * Validation/control facade for the final dashboard integration. It has no
 * task-runtime or Git authority: every durable change is delegated to the
 * supplied reconciliation store and is constrained by that store's replay
 * and immutable-evidence checks.
 */
export class MergeReconciliationDashboard {
  private readonly selections=new Map<string,string>();
  private readonly browserQueues=new Map<string,Promise<void>>();
  constructor(
    private readonly store: ReconciliationIntentStore,
    private readonly currentBindingReader?: CurrentReconciliationBindingReader,
    private readonly browserOptions:ReconciliationBrowserOptions={},
  ) {
    if(browserOptions.browserReview) {
      keys(browserOptions.browserReview,['selectedAttempts']);
      const selections=browserOptions.browserReview.selectedAttempts;
      if(!Array.isArray(selections)||selections.length>browserBounds.selections)throw new ReconciliationBrowserRequestError(400,'Invalid host review selection bound.');
      for(const selection of selections) {
        keys(selection,['attemptId','reviewSha256']);browserId(selection.attemptId);hash(selection.reviewSha256);
        if(this.selections.has(selection.attemptId))throw new ReconciliationBrowserRequestError(400,'Duplicate host review selection.');
        this.selections.set(selection.attemptId,selection.reviewSha256);
      }
    }
  }

  async list():Promise<ReconciliationList> {
    if(!this.store.list)return {configured:false,setupReason:'Retained attempt listing is not available from this host adapter.',attempts:[],page:{total:0,limit:50,omitted:0},capabilities:{canCheckCurrentBinding:false,canRecordConfirmationIntent:false}};
    // Exactly one snapshot: sorting/page selection cannot race another ledger read.
    const snapshot=await this.store.list();
    if(snapshot.length>browserBounds.attempts)throw new Error('Retained reconciliation inventory exceeds its bound.');
    const sorted=[...snapshot].sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt)||left.id.localeCompare(right.id));
    return {configured:true,setupReason:null,attempts:sorted.slice(0,browserBounds.list).map((attempt)=>this.summary(attempt)),page:{total:sorted.length,limit:50,omitted:Math.max(0,sorted.length-browserBounds.list)},capabilities:{canCheckCurrentBinding:Boolean(this.currentBindingReader),canRecordConfirmationIntent:Boolean(this.currentBindingReader&&this.browserOptions.interactionWriter&&this.selections.size)}};
  }

  async review(attemptId:string):Promise<ReconciliationReview|null> {
    browserId(attemptId);const attempt=await this.store.get(attemptId);
    return attempt?this.browserReview(attempt):null;
  }

  async checkCurrentBinding(attemptId:string):Promise<ReconciliationReview> {
    browserId(attemptId);
    return this.browserSerial(attemptId,async()=>{
      const attempt=await this.browserAttempt(attemptId),check=await this.bindingCheck(attempt);
      const retained=check.current?await this.store.invalidateStaleBinding(attemptId,check.current):attempt;
      return this.browserReview(retained,check.dto);
    });
  }

  async confirmReviewed(attemptId:string,input:RecordReviewedConfirmationRequest):Promise<RecordReviewedConfirmationResult> {
    browserId(attemptId);keys(input,['requestId','reviewSha256']);browserId(input.requestId);hash(input.reviewSha256);
    const request=structuredClone(input);
    return this.browserSerial(attemptId,async()=>{
      let attempt=await this.browserAttempt(attemptId);
      const result=async(outcome:RecordReviewedConfirmationResult['outcome'],reasonCode:string|null,check:ReconciliationBindingCheck=emptyCheck):Promise<RecordReviewedConfirmationResult>=>({schema:1,requestId:request.requestId,outcome,reasonCode,review:await this.browserReview(attempt,check)});
      const metadata=projectRetainedReconciliationReview(attempt);
      if(attempt.status==='BLOCKED'||attempt.plan.status==='blocked')return result('blocked','attempt-blocked');
      if(!metadata.complete)return result('refused',metadata.reasonCode);
      if(this.selections.get(attemptId)!==metadata.sha256)return result('refused',this.selections.has(attemptId)?'host-selection-mismatch':'host-selection-required');
      if(request.reviewSha256!==metadata.sha256)return result('refused','review-digest-mismatch');
      if(attempt.plan.classification!=='requires-confirmation'||attempt.plan.status!=='awaiting-confirmation')return result('refused','plan-not-confirmation-gated');
      if(!this.currentBindingReader)return result('refused','current-binding-reader-unavailable');
      const writer=this.browserOptions.interactionWriter;
      if(!writer)return result('refused','interaction-writer-unavailable');
      const identity=reconciliationInteractionIdentity(attemptId,request.requestId);
      if(attempt.confirmation&&attempt.confirmation.confirmationId!==identity.confirmationId)return result('refused','confirmation-already-recorded');
      const first=await this.bindingCheck(attempt);
      if(!first.current)return result('refused','current-binding-unavailable',first.dto);
      attempt=await this.store.invalidateStaleBinding(attemptId,first.current);
      if(attempt.status==='BLOCKED')return result('blocked','binding-drift',first.dto);
      let event:ReconciliationInteractionEvent;
      let retained:RetainedReconciliationInteraction|null;
      try {
        retained=await writer.read({attemptId,requestId:request.requestId});
        if(retained)event=validateInteraction(retained,attempt,request);
        else {
          if(attempt.confirmation)return result('refused','interaction-evidence-unavailable',first.dto);
          const beganAt=first.dto.beganAt!,endedAt=first.dto.endedAt!,receivedAt=this.instant();
          if(Date.parse(receivedAt)<Date.parse(endedAt))return result('refused','host-clock-unavailable',first.dto);
          event={schema:1,kind:'temari-reconciliation-dashboard-interaction',attemptId,requestId:request.requestId,planId:attempt.plan.id,observationId:attempt.binding.observationId,reviewSha256:request.reviewSha256,canonicalRequestSha256:attempt.canonicalRequestDigest,expectedBindingSha256:reconciliationStoreDigest(attempt.binding),bindingCheck:{state:'matched',beganAt,endedAt,changedFields:[],reasonCode:null},actorKind:'local-dashboard-interaction',receivedAt};
          await writer.publish(event);
        }
        // Read back even a returned existing event: acknowledgments are not evidence bytes.
        const readback=await writer.read({attemptId,requestId:request.requestId});
        if(!readback)return result('refused','interaction-evidence-unavailable',first.dto);
        const checked=validateInteraction(readback,attempt,request);
        if(reconciliationStoreDigest(event)!==reconciliationStoreDigest(checked))return result('refused','interaction-evidence-mismatch',first.dto);
        retained=readback;event=checked;
      }catch{return result('refused','interaction-evidence-unavailable',first.dto);}
      // The event may precede a crash. This explicit invocation alone may continue
      // after another fresh trusted observation; no recovery path replays it.
      const second=await this.bindingCheck(attempt);
      if(!second.current)return result('refused','current-binding-unavailable',second.dto);
      attempt=await this.store.invalidateStaleBinding(attemptId,second.current);
      if(attempt.status==='BLOCKED')return result('blocked','binding-drift',second.dto);
      const confirmation:ReconciliationConfirmation={schema:1,confirmationId:identity.confirmationId,planId:attempt.plan.id,observationId:attempt.binding.observationId,canonicalRequestSha256:attempt.canonicalRequestDigest,confirmedAt:event.receivedAt,confirmedBy:'local-dashboard-interaction',evidence:[evidenceProjection(retained.evidence)]};
      const replayed=attempt.confirmation!==null;
      if(attempt.confirmation&&reconciliationStoreDigest(attempt.confirmation)!==reconciliationStoreDigest(confirmation))return result('refused','confirmation-evidence-mismatch',second.dto);
      attempt=await this.store.confirm(attemptId,confirmation,second.current);
      if(attempt.status==='BLOCKED')return result('blocked','binding-drift',second.dto);
      if(!attempt.confirmation||reconciliationStoreDigest(attempt.confirmation)!==reconciliationStoreDigest(confirmation))return result('refused','confirmation-not-recorded',second.dto);
      return result(replayed?'replayed':'recorded',null,second.dto);
    });
  }

  private instant():string {
    const at=(this.browserOptions.now?.()??new Date()).toISOString();
    if(!iso(at))throw new Error('Host clock is unavailable.');return at;
  }
  private browserSerial<T>(attemptId:string,effect:()=>Promise<T>):Promise<T> {
    const next=(this.browserQueues.get(attemptId)??Promise.resolve()).then(effect);
    const settled=next.then(()=>undefined,()=>undefined);this.browserQueues.set(attemptId,settled);
    void settled.then(()=>{if(this.browserQueues.get(attemptId)===settled)this.browserQueues.delete(attemptId);});return next;
  }
  private async browserAttempt(id:string):Promise<ReconciliationAttempt> {
    const attempt=await this.store.get(id);if(!attempt)throw new ReconciliationBrowserRequestError(404,'Reconciliation attempt does not exist.');return attempt;
  }
  private async bindingCheck(attempt:ReconciliationAttempt):Promise<{dto:ReconciliationBindingCheck;current:ReconciliationAttemptBinding|null}> {
    const beganAt=this.instant();
    try {
      if(!this.currentBindingReader)throw new Error('Current binding reader unavailable.');
      const current=await this.currentBindingReader.readCurrentBinding({attemptId:attempt.id,expected:structuredClone(attempt.binding)});
      assertBinding(current);keys(current,bindingFields);
      for(const field of ['taskId','taskVersion','runId','observationId','candidateId'] as const)browserId(current[field]);
      hash(current.candidateSha256);hash(current.scopeSha256);
      if(current.revision.length>512||/[\u0000-\u001f\u007f]/.test(current.revision))throw new Error('Invalid current revision.');
      const changedFields=bindingFields.filter((field)=>current[field]!==attempt.binding[field]),endedAt=this.instant();
      if(Date.parse(endedAt)<Date.parse(beganAt))throw new Error('Host clock changed.');
      return {dto:{state:changedFields.length?'drift':'matched',beganAt,endedAt,changedFields,reasonCode:changedFields.length?'binding-drift':null},current};
    }catch{return {dto:{state:'unavailable',beganAt,endedAt:this.instant(),changedFields:[],reasonCode:'current-binding-unavailable'},current:null};}
  }
  private summary(attempt:ReconciliationAttempt):ReconciliationAttemptSummary {
    const projected=projectMergeReconciliationAttempt(attempt),metadata=projectRetainedReconciliationReview(attempt);
    const hostSelected=metadata.complete&&this.selections.get(attempt.id)===metadata.sha256;
    return {attemptId:attempt.id,retainedStatus:attempt.status,state:projected.state,classification:attempt.plan.classification,summary:hostSelected?attempt.plan.summary.slice(0,512):null,summaryTruncated:hostSelected&&attempt.plan.summary.length>512,taskId:attempt.binding.taskId,runId:attempt.binding.runId,createdAt:attempt.createdAt,updatedAt:attempt.updatedAt,blockedReason:projected.state==='blocked'?'Reconciliation is blocked; the owning host must prepare a fresh attempt.':null,confirmationRecorded:attempt.confirmation!==null,hostSelectedForReview:hostSelected,candidate:projected.candidate,terminal:false};
  }
  private async browserReview(attempt:ReconciliationAttempt,currentBinding:ReconciliationBindingCheck=emptyCheck):Promise<ReconciliationReview> {
    const summary=this.summary(attempt),metadata=projectRetainedReconciliationReview(attempt);
    const hostSelected=summary.hostSelectedForReview;
    const reasonCode=hostSelected?null:metadata.reasonCode??(this.selections.has(attempt.id)?'host-selection-mismatch':'host-selection-required');
    const review=hostSelected?metadata:{complete:false,sha256:null,payload:null,reasonCode};
    const confirmation=attempt.confirmation;
    let requestId:string|null=null;
    if(confirmation?.confirmedBy==='local-dashboard-interaction'&&confirmation.evidence.length===1&&this.browserOptions.interactionWriter) {
      try {
        const ref=confirmation.evidence[0]!,retained=await this.browserOptions.interactionWriter.readRecorded({attemptId:attempt.id,evidenceId:ref.id});
        if(retained&&reconciliationStoreDigest(ref)===reconciliationStoreDigest(retained.evidence)) {
          const event=validateInteraction(retained,attempt),identity=reconciliationInteractionIdentity(attempt.id,event.requestId);
          if(confirmation.confirmationId===identity.confirmationId&&confirmation.confirmedAt===event.receivedAt)requestId=event.requestId;
        }
      }catch{/* Historic confirmation stays visible; missing event is not local replay proof. */}
    }
    return {schema:1,attempt:summary,review,admission:{hostSelected,reasonCode},currentBinding,confirmation:confirmation?{confirmationId:confirmation.confirmationId,requestId,planId:confirmation.planId,observationId:confirmation.observationId,canonicalRequestSha256:confirmation.canonicalRequestSha256,confirmedAt:confirmation.confirmedAt,actorKind:requestId!==null?'local-dashboard-interaction':'retained-external-record',evidence:confirmation.evidence.map(evidenceProjection)}:null,capabilities:{canCheckCurrentBinding:Boolean(this.currentBindingReader),canRecordConfirmationIntent:Boolean(hostSelected&&review.complete&&currentBinding.state!=='unavailable'&&currentBinding.state!=='drift'&&this.currentBindingReader&&this.browserOptions.interactionWriter&&attempt.status==='PENDING'&&attempt.plan.classification==='requires-confirmation'&&attempt.plan.status==='awaiting-confirmation'&&!confirmation)},effects:noEffects};
  }

  async view(attemptId: string): Promise<MergeReconciliationDashboardView | null> {
    assertAttemptId(attemptId);
    const attempt = await this.store.get(attemptId);
    return attempt ? this.project(attempt) : null;
  }

  async submitIntent(
    request: CreateReconciliationAttemptRequest,
  ): Promise<MergeReconciliationDashboardView> {
    assertIntent(request);
    return this.project(await this.store.createAttempt(request));
  }

  async invalidateIntent(
    intent: ReconciliationInvalidationIntent,
  ): Promise<MergeReconciliationDashboardView> {
    assertAttemptId(intent.attemptId);
    const current = await this.readCurrentBinding(intent.attemptId);
    return this.project(await this.store.invalidateStaleBinding(intent.attemptId, current));
  }

  async confirmIntent(
    intent: ReconciliationConfirmationIntent,
  ): Promise<MergeReconciliationDashboardView> {
    assertAttemptId(intent.attemptId);
    assertReconciliationConfirmation(intent.confirmation);
    const current = await this.readCurrentBinding(intent.attemptId);
    return this.project(await this.store.confirm(intent.attemptId, intent.confirmation, current));
  }

  private async readCurrentBinding(attemptId: string): Promise<ReconciliationAttemptBinding> {
    if (!this.currentBindingReader) {
      throw new Error('Current reconciliation binding reader is not configured; confirmation is blocked.');
    }
    const attempt = await this.store.get(attemptId);
    if (!attempt) throw new Error('Reconciliation attempt does not exist.');
    const current = await this.currentBindingReader.readCurrentBinding({
      attemptId,
      expected: attempt.binding,
    });
    assertBinding(current);
    return current;
  }

  private project(attempt: ReconciliationAttempt): MergeReconciliationDashboardView {
    const view = projectMergeReconciliationAttempt(attempt);
    return {
      ...view,
      canConfirm: view.canConfirm && Boolean(this.currentBindingReader),
    };
  }
}

function assertIntent(request: CreateReconciliationAttemptRequest): void {
  if (!request || typeof request !== 'object') throw new Error('Invalid reconciliation intent.');
  assertAttemptId(request.idempotencyKey);
  assertMergeObservation(request.observation as MergeObservation);
  assertInitialReconciliationPlan(request.plan as ReconciliationPlan);
  assertReconciliationBinding(request.plan, request.observation);
  if (request.idempotencyKey !== request.plan.request.idempotencyKey) {
    throw new Error('Reconciliation intent idempotency key differs from its plan request.');
  }
}
