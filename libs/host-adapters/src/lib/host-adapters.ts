import {
  HOST_CAPABILITIES,
  type HostCapability,
  type HostCapabilityReport,
} from '@temari/contracts';

export interface HostAdapter {
  readonly id: string;
  capabilities(): HostCapabilityReport;
}

function report(
  host: string,
  available: readonly HostCapability[],
  notes: HostCapabilityReport['notes'] = {},
): HostCapabilityReport {
  const have = new Set(available);
  return {
    host,
    available,
    missing: HOST_CAPABILITIES.filter((capability) => !have.has(capability)),
    notes,
  };
}

/** Honest serial fallback. Never claims Cursor/Codex/Claude APIs. */
export const genericAdapter: HostAdapter = {
  id: 'generic',
  capabilities() {
    return report('generic', [], {
      subagents: 'Run serially. Do not invent a worker API.',
      parallelism: 'Unavailable.',
      model_diversity: 'Inherit the host model only.',
      worktree_isolation: 'Optional; do not assume a worktree.',
      durable_delivery: 'Unavailable until proven.',
      forge: 'Unavailable until proven.',
    });
  },
};

export const cursorAdapter: HostAdapter = {
  id: 'cursor',
  capabilities() {
    return report('cursor', [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ]);
  },
};

export const ADAPTERS: Readonly<Record<string, HostAdapter>> = {
  generic: genericAdapter,
  cursor: cursorAdapter,
};

export function adapterFor(host: string): HostAdapter {
  return ADAPTERS[host] ?? genericAdapter;
}
