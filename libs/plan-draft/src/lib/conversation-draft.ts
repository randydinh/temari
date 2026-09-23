import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { InvestigationTask, WorkerResult } from '@temari/contracts';
import { investigateDesignUpdate } from '@temari/knowledge';
import type {
  ConversationDraftCommand,
  ConversationDraftDependencies,
  ConversationDraftIntent,
  ConversationDraftOutcome,
  DraftIdentity,
} from './types.js';
import {
  bounded,
  canonical,
  frozenCopy,
  issuesFor,
  renderDraft,
  sha256,
  text,
  validateProposal,
} from './data.js';
import {
  canonicalDirectory,
  message,
  publish,
  readRegular,
  syncDirectory,
} from './files.js';
import {
  admitDraftIntent,
  createLocalPlanDraft,
  draftPaths,
  loadDraftInvestigation,
  requireUnoccupiedDraft,
  validateInvestigationResult,
} from './plan-draft.js';

type Binding = ConversationDraftIntent & {
  readonly provider: ConversationDraftDependencies['provider']['identity'];
  readonly assessor: DraftIdentity;
  readonly writer: DraftIdentity;
  readonly reviewer: DraftIdentity;
  readonly callerRevision: 'conversation-draft-v1';
};
type Head = { readonly path: string; readonly sha256: string };
type Journal =
  | { readonly kind: 'empty' }
  | { readonly kind: 'started'; readonly binding: Binding; readonly head: Head }
  | {
      readonly kind: 'investigated' | 'proposing';
      readonly binding: Binding;
      readonly head: Head;
      readonly result: WorkerResult;
    }
  | {
      readonly kind: 'proposed';
      readonly binding: Binding;
      readonly head: Head;
      readonly result: WorkerResult;
      readonly proposal: unknown;
    }
  | {
      readonly kind: 'reviewing';
      readonly binding: Binding;
      readonly head: Head;
      readonly result: WorkerResult;
      readonly proposal: unknown;
      readonly candidateSha256: string;
    };
const kinds = [
  'started',
  'investigated',
  'proposing',
  'proposed',
  'reviewing',
] as const;
type Kind = (typeof kinds)[number];
const recordLimit = 2 * 1024 * 1024;

function bindingFor(
  intent: ConversationDraftIntent,
  deps: ConversationDraftDependencies,
): Binding {
  const identity = ({ id, revision }: DraftIdentity): DraftIdentity => {
    text(id);
    text(revision);
    return { id, revision };
  };
  const { instance, implementation, configuration } = deps.provider.identity;
  [instance, implementation, configuration].forEach(text);
  const binding: Binding = {
    task: intent.task,
    brief: intent.brief,
    request: intent.request,
    destination: intent.destination,
    title: intent.title,
    authority: intent.authority,
    provider: { instance, implementation, configuration },
    assessor: identity(deps.assessor),
    writer: identity(deps.writer),
    reviewer: identity(deps.reviewer),
    callerRevision: 'conversation-draft-v1',
  };
  bounded(binding, 1024 * 1024, 'Conversation draft input');
  return frozenCopy(binding);
}

function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Journal object required',
  );
  return value as Record<string, unknown>;
}

function resultFor(value: unknown): WorkerResult {
  validateInvestigationResult(value);
  const result: WorkerResult = {
    status: value.status,
    summary: value.summary,
    evidencePaths: value.evidencePaths,
    rawLogPath: null,
  };
  assert.equal(
    canonical(value),
    canonical(result),
    'Unexpected investigation result fields',
  );
  return frozenCopy(result);
}

const journalPath = (
  task: InvestigationTask,
  slot: string,
  kind: Kind,
): string => join(task.directory, `conversation-draft-${slot}-${kind}.json`);

async function loadJournal(
  task: InvestigationTask,
  destination: string,
  deps: ConversationDraftDependencies,
  paths: Set<string>,
): Promise<Journal> {
  const { slot } = draftPaths(task, destination);
  let state: Journal = { kind: 'empty' };
  for (const kind of kinds) {
    const path = journalPath(task, slot, kind);
    const bytes = await readRegular(path, recordLimit);
    if (bytes === null) continue;
    paths.add(path);
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    const value = object(raw);
    assert.equal(value['schema'], 1, 'Unsupported conversation journal');
    assert.equal(value['kind'], kind, 'Journal kind mismatch');
    const head = { path, sha256: sha256(bytes) };
    let expected: unknown;
    if (kind === 'started') {
      const saved = object(value['binding']);
      const binding = bindingFor(
        saved as unknown as ConversationDraftIntent,
        deps,
      );
      assert.equal(
        canonical(saved),
        canonical(binding),
        'Saved binding or dependency identity/revision changed',
      );
      assert.equal(
        canonical(binding.task),
        canonical(task),
        'Journal task mismatch',
      );
      assert.equal(
        binding.destination,
        destination,
        'Journal destination mismatch',
      );
      expected = { schema: 1, kind, binding };
      state = { kind, binding, head };
    } else {
      assert(state.kind !== 'empty', 'Journal predecessor missing');
      assert.equal(
        value['priorSha256'],
        state.head.sha256,
        'Journal predecessor hash mismatch',
      );
      const common = { schema: 1, kind, priorSha256: state.head.sha256 };
      const binding: Binding = state.binding;
      switch (kind) {
        case 'investigated': {
          assert(state.kind === 'started', 'Investigation predecessor missing');
          const result = resultFor(value['result']);
          expected = { ...common, result };
          state = { kind, binding, head, result };
          break;
        }
        case 'proposing': {
          assert(
            state.kind === 'investigated',
            'Proposal invocation predecessor missing',
          );
          expected = common;
          state = { kind, binding, head, result: state.result };
          break;
        }
        case 'proposed': {
          assert(state.kind === 'proposing', 'Proposal predecessor missing');
          const proposal = value['proposal'];
          bounded(proposal, 256 * 1024, 'Proposal');
          expected = { ...common, proposal };
          state = { kind, binding, head, result: state.result, proposal };
          break;
        }
        case 'reviewing': {
          assert(state.kind === 'proposed', 'Review predecessor missing');
          const candidateSha256 = value['candidateSha256'];
          assert(
            typeof candidateSha256 === 'string' &&
              /^[a-f0-9]{64}$/.test(candidateSha256),
            'Review candidate SHA-256 required',
          );
          expected = { ...common, candidateSha256 };
          state = {
            kind,
            binding,
            head,
            result: state.result,
            proposal: state.proposal,
            candidateSha256,
          };
          break;
        }
      }
    }
    assert.equal(
      bytes.toString('utf8'),
      canonical(expected),
      'Unexpected journal fields or noncanonical bytes',
    );
  }
  return state;
}

export async function createConversationPlanDraft(
  command: ConversationDraftCommand,
  deps: ConversationDraftDependencies,
): Promise<ConversationDraftOutcome> {
  const paths = new Set<string>();
  let checkpointPath: string | null = null;
  let investigation: WorkerResult | null = null;
  try {
    assert(
      command.kind === 'start' || command.kind === 'resume',
      'Start or resume command required',
    );
    bounded(command, 1024 * 1024, 'Conversation draft command');
    const request = frozenCopy(command);
    const { task, destination } =
      request.kind === 'start' ? request.intent : request;
    await canonicalDirectory(task.directory);
    const { slot, preparationPath, completionPath } = draftPaths(
      task,
      destination,
    );
    for (const callback of [
      deps.assessor.assess,
      deps.writer.propose,
      deps.reviewer.review,
      deps.checkReady,
    ]) {
      assert(
        typeof callback === 'function',
        'Configured assessment, proposal, review and readiness functions required',
      );
    }
    for (const method of [
      deps.provider.discover,
      deps.provider.read,
      deps.provider.revalidate,
    ]) {
      assert(
        typeof method === 'function',
        'Configured knowledge provider required',
      );
    }

    const reload = async (): Promise<Journal> => {
      const journal = await loadJournal(task, destination, deps, paths);
      if (journal.kind !== 'empty') {
        checkpointPath = journal.head.path;
        if ('result' in journal) investigation = journal.result;
        await admitDraftIntent(journal.binding);
        if (request.kind === 'start') {
          assert.equal(
            canonical(journal.binding),
            canonical(bindingFor(request.intent, deps)),
            'Start inputs differ from the saved operation',
          );
        }
      }
      return journal;
    };
    const append = async (kind: Kind, entry: unknown): Promise<boolean> => {
      const path = journalPath(task, slot, kind);
      const body = bounded(entry, recordLimit, 'Conversation journal');
      const created = await publish(task.directory, path, body);
      if (!created) {
        assert(
          (await readRegular(path, recordLimit))?.equals(Buffer.from(body)),
          'Conversation journal collision or changed bytes',
        );
        await syncDirectory(task.directory);
      }
      paths.add(path);
      checkpointPath = path;
      return created;
    };
    const requireEmptySlot = async (): Promise<void> => {
      assert(
        (await readRegular(preparationPath, recordLimit)) === null,
        'Preparation exists before the saved proposal',
      );
      await requireUnoccupiedDraft(destination, completionPath);
    };

    let state = await reload();
    if (state.kind === 'empty') {
      assert(request.kind === 'start', 'No saved conversation draft to resume');
      const binding = bindingFor(request.intent, deps);
      await admitDraftIntent(binding);
      await requireEmptySlot();
      await deps.checkReady(['assess', 'propose', 'review']);
      const created = await append('started', {
        schema: 1,
        kind: 'started',
        binding,
      });
      state = await reload();
      if (created) {
        assert(
          state.kind === 'started',
          'Unexpected state before investigation',
        );
        investigation = await investigateDesignUpdate({
          task: binding.task,
          brief: binding.brief,
          request: binding.request,
          provider: deps.provider,
          assess: deps.assessor.assess,
        });
        await append('investigated', {
          schema: 1,
          kind: 'investigated',
          priorSha256: state.head.sha256,
          result: investigation,
        });
        state = await reload();
      }
    }
    assert(state.kind !== 'empty');
    assert(
      state.kind !== 'started',
      'Investigation outcome may be unsaved; retain the started record and use a new authorized operation',
    );
    assert(
      state.kind !== 'proposing',
      'Proposal outcome may be unsaved; retain the proposing record and use a new authorized operation',
    );
    if (state.kind === 'investigated') {
      const checkpoint = await loadDraftInvestigation(
        { ...state.binding, investigationResult: state.result },
        paths,
      );
      const proposalInput = {
        brief: state.binding.brief,
        request: state.binding.request,
        investigationResult: state.result,
        checkpoint,
      };
      bounded(proposalInput, 20 * 1024 * 1024, 'Proposal input');
      await requireEmptySlot();
      await deps.checkReady(['propose', 'review']);
      const created = await append('proposing', {
        schema: 1,
        kind: 'proposing',
        priorSha256: state.head.sha256,
      });
      state = await reload();
      if (created) {
        assert(state.kind === 'proposing', 'Unexpected state before proposal');
        const proposal: unknown = await deps.writer.propose(
          frozenCopy(proposalInput),
        );
        bounded(proposal, 256 * 1024, 'Proposal');
        await append('proposed', {
          schema: 1,
          kind: 'proposed',
          priorSha256: state.head.sha256,
          proposal,
        });
      }
      state = await reload();
    }
    assert(
      state.kind === 'proposed' || state.kind === 'reviewing',
      'Proposal outcome may be unsaved; no judgment was repeated',
    );
    const { binding, result, proposal } = state;
    const checkpoint = await loadDraftInvestigation(
      { ...binding, investigationResult: result },
      paths,
    );
    validateProposal(proposal, checkpoint);
    if (state.kind === 'reviewing') {
      assert.equal(
        state.candidateSha256,
        sha256(
          renderDraft(
            binding.title,
            proposal,
            checkpoint,
            issuesFor(checkpoint),
          ),
        ),
        'Review marker candidate changed',
      );
    } else await requireEmptySlot();
    const draft = await createLocalPlanDraft({
      ...binding,
      provider: deps.provider,
      investigationResult: result,
      proposal,
      reviewer: {
        ...binding.reviewer,
        review: async (input) => {
          const current = await reload();
          assert(
            current.kind === 'proposed',
            'Review outcome may be unsaved or rejected; an existing review invocation cannot be repeated without accepted preparation',
          );
          await deps.checkReady(['review']);
          assert(
            await append('reviewing', {
              schema: 1,
              kind: 'reviewing',
              priorSha256: current.head.sha256,
              candidateSha256: input.candidate.sha256,
            }),
            'Review already invoked; its outcome may be unsaved',
          );
          await reload();
          return deps.reviewer.review(input);
        },
      },
    });
    assert(checkpointPath !== null);
    return { kind: 'draft', investigation: result, draft, checkpointPath };
  } catch (error) {
    for (const path of investigation?.evidencePaths ?? []) paths.add(path);
    for (const path of paths) {
      if (!(await lstat(path).catch(() => null))) paths.delete(path);
    }
    return {
      kind: 'stopped',
      investigation,
      checkpointPath,
      result: {
        status: 'BLOCKED',
        summary: `Conversation draft stopped: ${message(error)}`,
        evidencePaths: [...paths],
        rawLogPath: null,
      },
    };
  }
}
