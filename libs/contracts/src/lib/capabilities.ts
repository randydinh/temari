export const HOST_CAPABILITIES = [
  'subagents',
  'parallelism',
  'model_diversity',
  'worktree_isolation',
  'durable_delivery',
  'forge',
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export type CapabilityProvenance =
  | { readonly status: 'unproven'; readonly source: string }
  | {
      readonly status: 'proven';
      readonly source: string;
      readonly observedAt: string;
    };

export interface HostCapabilityReport {
  readonly host: string;
  readonly available: readonly HostCapability[];
  readonly missing: readonly HostCapability[];
  readonly notes: Readonly<Partial<Record<HostCapability, string>>>;
  /** Declared capability evidence. Missing evidence is not proof. */
  readonly provenance?: Readonly<
    Partial<Record<HostCapability, CapabilityProvenance>>
  >;
}

export function missingCapabilities(
  required: readonly HostCapability[],
  available: readonly HostCapability[],
): HostCapability[] {
  const have = new Set(available);
  return required.filter((capability) => !have.has(capability));
}

/** Return only declared capabilities backed by an explicit proof record. */
export function provenCapabilities(
  report: HostCapabilityReport,
): HostCapability[] {
  return report.available.filter(
    (capability) => report.provenance?.[capability]?.status === 'proven',
  );
}

/** Apply the strict migration gate without changing legacy declaration behavior. */
export function missingOrUnprovenCapabilities(
  required: readonly HostCapability[],
  report: HostCapabilityReport,
): HostCapability[] {
  return missingCapabilities(required, provenCapabilities(report));
}
