import { dirname, join } from 'node:path';
import {
  localGit,
  verifyPinnedDependencies,
  type PinnedDependencyPlan,
} from '../libs/runtime/src/lib/git-dependencies.js';
export * from '../libs/runtime/src/lib/git-dependencies.js';

/** Copy Git objects, never the source worktree, ignored payloads, or mutable Git metadata. */
export function preparePinnedDependencies(
  source: string,
  target: string,
  plan: PinnedDependencyPlan,
): void {
  verifyPinnedDependencies(source, plan);
  for (const dependency of plan.dependencies) {
    const path = join(target, dependency.path);
    // Git creates missing parents; the existing empty gitlink directory is valid.
    localGit(dirname(target), [
      'clone',
      '--local',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      join(source, dependency.path),
      path,
    ]);
    localGit(path, [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '--detach',
      dependency.commit,
    ]);
  }
  verifyPinnedDependencies(source, plan);
  verifyPinnedDependencies(target, plan);
}
