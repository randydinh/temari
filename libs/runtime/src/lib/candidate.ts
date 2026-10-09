import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  DEFAULT_STAGES,
  type CandidateIdentity,
  type WorkflowStageId,
} from '@temari/contracts';
import { captureWorkspaceManifest } from './workspace-manifest.js';
import type { StageWorkspaceBinding } from './runtime.js';

import {
  observeGitProduct,
  type PinnedDependencyPlan,
} from './git-dependencies.js';

export interface LocalCandidateScope {
  readonly observation?: CandidateIdentity['scope'];
  readonly dependencies?: PinnedDependencyPlan;
  readonly scopeId: string;
  readonly root: string;
}

export interface CandidateRunOptions {
  readonly scope: LocalCandidateScope;
  readonly expectedInitial: CandidateIdentity;
  readonly knownWriteRoots: readonly string[];
}

export async function observeCandidate(
  scope: LocalCandidateScope,
): Promise<CandidateIdentity> {
  const selected = { ...scope };
  assert(
    typeof selected.scopeId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selected.scopeId),
    'Invalid candidate scope ID.',
  );
  if (selected.observation === 'git-tracked-files-v1')
    return observeGitProduct(selected.root, selected.dependencies);
  assert(
    selected.observation === undefined ||
      selected.observation === 'local-regular-files-v1',
    'Unsupported candidate scope.',
  );
  const manifest = await captureWorkspaceManifest({
    runId: 'candidate-observation',
    revision: 'local-regular-files-v1',
    subjectId: 'candidate',
    workspaceId: selected.scopeId,
    workspaceRoot: selected.root,
    maxFiles: 10_000,
    maxBytes: 64 * 1024 * 1024,
  });
  const entries = [...manifest.entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    scope: 'local-regular-files-v1',
    sha256: createHash('sha256')
      .update(
        JSON.stringify([
          'local-regular-files-v1',
          entries.map((e) => [e.path, e.mode, e.bytes, e.sha256]),
        ]),
      )
      .digest('hex'),
  };
}

async function resolveRoot(root: string): Promise<string> {
  assert(
    typeof root === 'string' && isAbsolute(root),
    'Candidate scope roots must be absolute.',
  );
  const stat = await lstat(root);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Candidate scope roots must be regular directories.',
  );
  return realpath(root);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function disjoint(left: string, right: string): void {
  assert(
    !contains(left, right) && !contains(right, left),
    'Candidate, stage and declared write roots must not overlap.',
  );
}

export async function prepareCandidateRoots(
  scope: LocalCandidateScope,
  workspaceForStage: (
    stage: WorkflowStageId,
  ) => StageWorkspaceBinding | null | undefined,
  knownWriteRoots: readonly string[],
) {
  assert(
    Array.isArray(knownWriteRoots),
    'Candidate knownWriteRoots must be declared.',
  );
  const bindings = new Map<WorkflowStageId, StageWorkspaceBinding>();
  for (const stage of DEFAULT_STAGES) {
    const binding = workspaceForStage(stage);
    assert(
      binding &&
        typeof binding.workspaceId === 'string' &&
        binding.workspaceId.trim().length > 0 &&
        binding.workspaceId.length <= 512,
      'Candidate execution requires all stage workspace bindings.',
    );
    bindings.set(
      stage,
      Object.freeze({ workspaceId: binding.workspaceId, root: binding.root }),
    );
  }
  const paths = [
    scope.root,
    ...DEFAULT_STAGES.map((stage) => bindings.get(stage)!.root),
    ...knownWriteRoots,
  ];
  const resolved = await Promise.all(paths.map(resolveRoot));
  const capturedCount = 1 + DEFAULT_STAGES.length;
  for (let i = 0; i < capturedCount; i++) {
    for (let j = i + 1; j < resolved.length; j++)
      disjoint(resolved[i], resolved[j]);
  }
  return {
    workspaceForStage: (stage: WorkflowStageId) => bindings.get(stage)!,
    async recheck(): Promise<void> {
      assert.deepEqual(
        await Promise.all(paths.map(resolveRoot)),
        resolved,
        'Candidate scope root resolution changed.',
      );
    },
  };
}
