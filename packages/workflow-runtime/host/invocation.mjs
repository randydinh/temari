import { createHash } from 'node:crypto';

export function invocationScope(input) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  return {
    scopeId: `host-${createHash('sha256')
      .update(JSON.stringify(canonical(input)))
      .digest('hex')}`,
    root: input.candidate.root,
    ...(input.expectedInitial?.scope === 'git-tracked-files-v1'
      ? { observation: 'git-tracked-files-v1' }
      : {}),
  };
}
