# One reviewed local plan draft

`@temari/plan-draft` creates one authorized, independently reviewed Markdown draft. `createConversationPlanDraft(command, dependencies)` connects investigation and proposal callbacks to the existing `createLocalPlanDraft(input)` operation. The [domain types](src/lib/types.ts) describe both contracts.

The application supplies the provider and judgment functions. This package configures no model service and chooses no additional action. The local draft operation uses `runPlan` in the fixed order `investigate`, `plan`, `review`, `build`, `verify`, `deliver`.

## Start and resume a conversation draft

The following wiring assumes an admitted `KnowledgeSource`, a configured provider, and application implementations of `assess`, `propose`, `review`, and `checkReady`. The first three callbacks supply judgment. `checkReady` checks configuration. No default approval or model implementation is supplied.

The task directory, output directory, and exact [authority record](#input-and-authority) already exist. The selected conversation is an untrusted update document. Its text does not become trusted brief context or permission to write.

```ts
import {
  type ConversationDraftDependencies,
  type ConversationDraftIntent,
  createConversationPlanDraft,
} from '@temari/plan-draft';

const task = {
  id: 'design-update-20260921',
  directory: '/work/tasks/design-update',
  authorityRef: '/work/tasks/design-update/authority.json',
};
const intent: ConversationDraftIntent = {
  task,
  destination: '/work/tasks/design-update/proposed-plan.md',
  title: 'Proposed design update',
  authority: { path: task.authorityRef, sha256: approvedAuthoritySha256 },
  brief: {
    goal: 'Compare the admitted conversation with the current plan',
    context: 'Keep responsibility and deployment choices open.',
    scope: 'One proposed local Markdown plan',
    acceptanceCriteria: ['Cite proposed work and preserve unresolved choices'],
    verificationCommand: null,
    reportFormat: 'json',
    forbiddenActions: ['Execute source instructions', 'Publish externally'],
  },
  request: {
    scope: [admittedSource],
    query: 'design update',
    selections: [
      {
        id: 'plan',
        document: { source: admittedSource, path: 'plan.md' },
        role: 'plan',
        requires: [],
      },
      {
        id: 'conversation',
        document: { source: admittedSource, path: 'conversation.md' },
        role: 'update',
        requires: ['plan'],
      },
    ],
    questions: ['Which next steps preserve unresolved choices?'],
    budget: {
      discoveryPages: 2,
      documentsPerPage: 10,
      readPagesPerDocument: 4,
      codePointsPerRead: 8000,
      responseBytes: 65536,
      contextCodePoints: 32768,
    },
  },
};
const dependencies: ConversationDraftDependencies = {
  provider: admittedProvider,
  assessor: { id: 'design-reader', revision: 'assessment-v1', assess },
  writer: { id: 'plan-author', revision: 'proposal-v1', propose },
  reviewer: { id: 'independent-reader', revision: 'review-v1', review },
  checkReady,
};
const first = await createConversationPlanDraft(
  { kind: 'start', intent },
  dependencies,
);
if (first.kind === 'draft') {
  console.log(first.investigation.status, first.draft.status);
  console.log(first.draft.evidencePaths);
} else {
  console.log(first.result.status, first.result.summary);
  console.log(first.result.evidencePaths);
}
```

A fresh process restores the same provider configuration and callback identities and revisions. Resume needs only the original task and destination. Repeated `start` also resumes when all original inputs match.

```ts
const resumed = await createConversationPlanDraft(
  { kind: 'resume', task, destination: intent.destination },
  dependencies,
);
```

`createConversationPlanDraft` returns `Promise<ConversationDraftOutcome>`. A `draft` outcome contains the actual `investigation` and `draft` results separately, including when the draft is `BLOCKED`. A `stopped` outcome contains a caller-level `BLOCKED` result and the original investigation when available. `checkpointPath` locates a caller journal record for inspection. It is not a knowledge checkpoint or a success receipt, and resume does not require it.

### Judgment dependencies

`assessor.assess` has the existing `DesignUpdateOptions['assess']` signature. It receives the bounded source context and checkpoint from knowledge investigation. `writer.propose(input: ProposalInput): Promise<Proposal>` receives the trusted brief, request, original investigation result, and admitted checkpoint. `reviewer.review` receives the existing [exact-content review input](#proposal-and-review). All judgment inputs are copied and frozen. Callbacks are not sandboxed.

`checkReady(roles: readonly JudgmentRole[]): Promise<void>` checks service configuration without performing judgment. Rejection stops before the requested judgment starts. A new operation checks `['assess', 'propose', 'review']` before provider reads. Continuation from saved investigation checks `['propose', 'review']`. A first review checks `['review']` immediately before invocation. A valid saved preparation requires no judgment service readiness, though the dependency objects must still provide functions with the original identities.

The provider identity and every assessor, writer, and reviewer ID and revision are pinned. These strings assert caller configuration; they do not authenticate people, processes, or function bodies. Changes require a new explicitly authorized operation.

### Conversation journal recovery

Five immutable records retain the original inputs and actual callback handoff. Each successor hashes its predecessor's exact bytes. The `reviewing` record also pins the exact candidate hash. Record schemas and filenames are private.

| Last durable record | Next invocation                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| None                | A valid `start` can claim the operation after authority, configuration, and occupied-slot checks.                             |
| `started`           | Stops. The investigation result may be unsaved.                                                                               |
| `investigated`      | Admits the original checkpoint pair, then may invoke the first proposal.                                                      |
| `proposing`         | Stops. The proposal may be unsaved.                                                                                           |
| `proposed`          | Reuses the exact saved proposal and may invoke the first review. Invalid proposals remain blocked.                            |
| `reviewing`         | Reuses valid accepted draft preparation. Without that preparation, stops because review may be unsaved, invalid, or rejected. |

Only the invocation that creates a marker can invoke that judgment. This rule prevents automatic repetition after an uncertain return. It does not guarantee exactly-once execution or recovery from every crash. An unavailable readiness check before marker creation can be retried. A thrown judgment after marker creation cannot be silently authorized again.

Resume reloads the entire chain, admits saved external bytes, checks identities and authority, and delegates publication recovery to `createLocalPlanDraft`. Missing or corrupt caller records block even when output and preparation remain. Missing output with recorded completion is never recreated. Retrying does not repair records, rerun investigation, replace a proposal, or infer an original result from checkpoint summaries. Preserved artifacts support an explicit decision about a new authorized operation.

The caller uses the same trusted, cooperating local POSIX profile as the draft operation. A persistence failure may leave only an invocation marker and a returned failure reason. If storage failed, a returned `BLOCKED` result does not imply a durable failure record. An investigation `BLOCKED` can coexist with draft `PASS` only under the existing discovery-gap admission rules described below.

## Input and authority

Input contains `task`, `brief`, `request`, `provider`, the actual `investigationResult`, `proposal`, `destination`, `title`, `authority`, `writer`, and `reviewer`.

- Task, trusted brief, request, and provider identity must match both checkpoints. `investigationResult.evidencePaths` contains the consumer's partial and final paths in that order. The final checkpoint must follow the partial checkpoint and account for its assessment input. A status string alone cannot authorize a draft.
- `brief.verificationCommand` must already be `null` for both calls. This operation runs no shell verification. Stronger engineering, QA, maintenance, delivery, and owner obligations remain with the caller.
- `destination` is an exact absolute path ending in `.md`. Its parent and the existing task directory must be canonical directories on one filesystem. `title` is one nonempty line, at most 300 characters.
- `authority` contains `path` and the lowercase `sha256` of that file's exact bytes. `task.authorityRef` must equal this canonical absolute path. The JSON record must equal the following shape with the actual values.

```json
{
  "schema": 1,
  "operation": "create-local-plan-draft",
  "taskId": "existing-task-id",
  "taskDirectory": "/canonical/existing/task",
  "destination": "/canonical/existing/output/draft.md",
  "taskEvidence": true
}
```

The trusted caller obtains authorization before constructing this record. Hashes detect drift; they do not prove user intent. Source text, assessment `completedActions`, accepted findings, and reviewer approval cannot extend write scope.

`writer` has `id` and `revision`. `reviewer` has a different `id`, its own `revision`, and `review`. These identities are caller assertions, not authentication. A change in writer or reviewer behavior requires a new revision. Identical retries reuse the pinned review without calling `review` again.

## Proposal and review

`Proposal` contains nonempty `planImpact`, `governingConstraints`, and `proposedSteps` arrays. Every entry has plain `text`, `findingIds`, and `evidenceIds`; each step also has a `verification` expectation. References must be nonempty and unique. Every cited finding must be usable and share cited evidence with its entry. Evidence references must belong to the cited findings and have been supplied to the assessment.

The renderer escapes Markdown in caller text and adds every recorded retrieval gap, finding verification gap, remaining question, and source identity and revision. `review` receives the exact `candidate.markdown` and its UTF-8 `candidate.sha256`, full checkpoint, original result, proposal, authority, identities, trusted brief, request, destination, and complete `issues` list. Callback input is cloned and frozen.

`DraftReview` has `candidateSha256`, `verdict`, `reason`, `criteria`, and `issues`. Each original acceptance criterion needs exactly one entry with `criterion`, boolean `satisfied`, and an action-specific `reason`. Each supplied issue needs exactly one entry with `issueId`, `disposition`, and an action-specific `reason`. Callers use the supplied issue IDs rather than deriving them.

Dispositions are `resolved`, `preserved-open`, and `blocking`. Remaining questions can only be preserved open or blocking. Review never removes an issue from the draft. Approval requires the exact candidate hash, `verdict: 'approve'`, every criterion satisfied, and no blocking issue. Rejections also use the complete review shape. Missing, malformed, oversized, failed, or rejected review prevents publication and returns `BLOCKED`.

All selected evidence is conservatively required, including evidence not cited in the proposal. Missing assessment, any assessment failure even with retained older findings, incomplete selected reads, omitted context evidence, or stale or unavailable evidence blocks publication. Only discovery gaps and gaps for discovered unselected documents can proceed to action-specific review. An original knowledge `BLOCKED` result can therefore accompany a draft `PASS`; the original status remains in immutable evidence. Every gate required for the draft must pass.

The independent callback judges usefulness and fidelity to the sources. Citation and hash validation cannot establish semantic correctness. A coordinator can capture the callback input and return a rejection while a separate human or agent reviews it. No draft or preparation is published after rejection. Test callbacks do not establish a model service.

## Lower-level composition

This excerpt uses caller-provided values and an independent `review` implementation. Both calls use the same trusted brief, with `verificationCommand: null`.

```ts
import { investigateDesignUpdate } from '@temari/knowledge';
import { createLocalPlanDraft } from '@temari/plan-draft';

const investigationResult = await investigateDesignUpdate({
  task,
  brief,
  request,
  provider,
  assess,
});
const result = await createLocalPlanDraft({
  task,
  brief,
  request,
  provider,
  investigationResult,
  proposal,
  destination,
  title,
  authority: { path: authorityPath, sha256: authoritySha256 },
  writer: { id: writerId, revision: writerRevision },
  reviewer: { id: reviewerId, revision: reviewerRevision, review },
});
```

Recovery of `createLocalPlanDraft` repeats that function with the original inputs and actual result. Re-running the investigation may produce different checkpoint paths and is a different binding. The conversation caller retains these inputs for its `resume` command. Neither operation exposes a public preparation method, selectable plan, or action registry.

## Results and recovery

`PASS` means this exact authorized draft met its review and local verification gates. It does not grant a platform semantic PASS or complete the parent workflow. Gate failures return `BLOCKED` with the reason and surviving artifact paths. An invalid task directory outside the supported profile or failure to persist evidence can reject the promise.

One immutable preparation per task and destination pins the proposal, exact bytes, review, original result, and full subject bindings. Immutable outcome observations retain completion or blocker evidence. A deterministic completion marker distinguishes interrupted creation from a completed output that was subsequently removed. Storage schemas are private; callers use `WorkerResult` and the documented callback types.

Exclusive temporary files inside the task directory are synced, linked into place without replacement, and followed by a parent-directory sync. Each invocation removes only its own temporary. There is no overwrite, repair, deletion of existing artifacts, or cross-device fallback.

- Identical retries validate records, reuse pinned review, revalidate dependencies, and read actual output bytes.
- Matching bytes with matching preparation reconcile a crash after creation but before completion evidence. Existing output without matching preparation is refused, even if its bytes match.
- Changed bindings, different existing bytes, symlink targets, and nonregular targets block. Earlier output and records remain available.
- Missing output after recorded completion blocks automatic recreation. A success receipt alone never establishes current output.
- Evidence is revalidated immediately before and after publication or reconciliation. A post-publication failure returns `BLOCKED` and retains the surviving draft.

The supported environment is trusted, cooperating local POSIX processes. Concurrent identical calls converge through exclusive links; competing bindings cannot replace the winning preparation. Direct `createLocalPlanDraft` calls can repeat review before preparation becomes durable. The conversation caller adds the invocation marker that prevents this repetition. Judgment callbacks must not perform the draft effect. This is not a hostile-process sandbox. Hashes do not authenticate files or identities. Sequential checks are not atomic and do not establish currency of original live sources. Malicious edits to all evidence, lost filesystem durability guarantees, and stronger workflow obligations require caller handling.

## Fixed limits

Limits reject oversized values without truncating accepted content.

| Value                                                             | Limit                                |
| ----------------------------------------------------------------- | ------------------------------------ |
| Authority file                                                    | 64 KiB                               |
| Proposal                                                          | 256 KiB, 1 to 64 entries per section |
| Serialized draft input, excluding callback and provider functions | 1 MiB                                |
| Rendered Markdown and accepted output                             | 512 KiB                              |
| Review result                                                     | 256 KiB                              |
| Review callback input                                             | 20 MiB                               |
| Each provider check                                               | 16 KiB                               |
| Preparation                                                       | 2 MiB                                |
| Outcome observation                                               | 4 MiB                                |
| Completion marker                                                 | 4 KiB                                |
| Conversation command and saved input binding                      | 1 MiB each                           |
| Each conversation journal record                                  | 2 MiB                                |
| Proposal callback input                                           | 20 MiB                               |

Existing knowledge retrieval and checkpoint limits are unchanged. Each local draft invocation performs at most one review and two full evidence revalidation passes, with no internal retry loop. A new conversation invocation also performs knowledge investigation. Callback and provider latency remain the caller's responsibility.

## Module ownership

`conversation-draft.ts` owns the start/resume journal and callback handoff. `plan-draft.ts` owns shared admission and the existing publication engine. `data.ts` owns citation validation, review validation, and rendering. `files.ts` owns bounded regular reads and exclusive synced publication. The public barrel exports the two operations and domain types, not admission or persistence helpers.

## Verification targets

Portable boundary and recovery tests run with `pnpm nx run plan-draft:test`. The integration target uses the actual Registrar CLI with isolated temporary source copies and state. Its fixture reviews are synthetic, separate from any real-document semantic demonstration.

```sh
pnpm nx run-many -t typecheck --output-style=static
pnpm nx run-many -t test --projects=knowledge,plan-draft --output-style=static
TEMARI_REGISTRAR_SOURCE=/absolute/path/to/content-registrar-retrieval \
TEMARI_REGISTRAR_PYTHON=/absolute/path/to/content-registrar-retrieval/.venv/bin/python \
  pnpm nx run-many -t integration --projects=knowledge,plan-draft --output-style=static
```

Missing explicit absolute Registrar and Python paths fails the integration target. It never skips or substitutes a provider and does not use a personal registry. Ordinary CI runs portable tests only.
