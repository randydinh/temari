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
  declared: readonly HostCapability[] = available,
): HostCapabilityReport {
  const have = new Set(available);
  const provenance = Object.fromEntries(
    declared.map((capability) => [
      capability,
      {
        status: 'unproven' as const,
        source: `${host} adapter declaration`,
      },
    ]),
  ) as HostCapabilityReport['provenance'];
  return {
    host,
    available,
    missing: HOST_CAPABILITIES.filter((capability) => !have.has(capability)),
    notes,
    provenance,
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
    // The legacy Cursor HOST.md maps these operations, but there is no
    // installed Nx Cursor journey or capability observation for this adapter.
    return report(
      'cursor',
      [],
      {
        subagents: 'Declared by legacy Cursor mapping; no Nx host proof.',
        parallelism: 'Declared by legacy Cursor mapping; no Nx host proof.',
        model_diversity: 'Declared by legacy Cursor mapping; no Nx host proof.',
        worktree_isolation: 'No Cursor worktree isolation proof.',
        durable_delivery: 'No Cursor delivery proof.',
        forge: 'No Cursor forge proof.',
      },
      HOST_CAPABILITIES,
    );
  },
};

export const ADAPTERS: Readonly<Record<string, HostAdapter>> = {
  generic: genericAdapter,
  cursor: cursorAdapter,
};

export function adapterFor(host: string): HostAdapter {
  return ADAPTERS[host] ?? genericAdapter;
}
