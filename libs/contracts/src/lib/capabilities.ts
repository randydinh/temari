export const HOST_CAPABILITIES = [
  'subagents',
  'parallelism',
  'model_diversity',
  'worktree_isolation',
  'durable_delivery',
  'forge',
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export interface HostCapabilityReport {
  readonly host: string;
  readonly available: readonly HostCapability[];
  readonly missing: readonly HostCapability[];
  readonly notes: Readonly<Partial<Record<HostCapability, string>>>;
}

export function missingCapabilities(
  required: readonly HostCapability[],
  available: readonly HostCapability[],
): HostCapability[] {
  const have = new Set(available);
  return required.filter((capability) => !have.has(capability));
}
