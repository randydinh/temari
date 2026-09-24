export type EvidenceKind =
  'stdout' | 'stderr' | 'worker-result' | 'verification' | 'other';

/**
 * A durable evidence identity that can cross hosts without carrying a local
 * filesystem path. The runtime resolves it through its configured store.
 */
export interface WorkerEvidenceReference {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly bytes: number;
}
