/** Runtime owns admission/fencing. Adapters own live handles and OS cleanup. */
export interface OwnedCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly input?: string;
  readonly outputLimitBytes?: number;
}
export interface OwnedExecutionIdentity {
  readonly nonce: string;
  readonly binding: string;
  readonly receiptPath: string;
}
export interface OwnedExecutionWitness {
  readonly guardianPid: number;
  readonly anchorPid: number;
}
export interface OwnedExecutionOutcome {
  readonly identity: OwnedExecutionIdentity;
  readonly witness: OwnedExecutionWitness;
  readonly code: number | null;
  readonly signal: string | null;
  readonly reason: string;
  readonly cleanup: 'CONFIRMED' | 'UNCERTAIN';
  readonly stdout: string;
  readonly stderr: string;
}
export interface OwnedExecutionAdapter {
  launch(
    command: OwnedCommand,
    identity: OwnedExecutionIdentity,
    signal: AbortSignal,
    register: (witness: OwnedExecutionWitness) => Promise<void>,
  ): Promise<OwnedExecutionOutcome>;
  /** Read verified cleanup evidence only. Recovered PIDs never grant signalling authority. */
  recover(
    identity: OwnedExecutionIdentity,
  ): Promise<OwnedExecutionOutcome | null>;
}
