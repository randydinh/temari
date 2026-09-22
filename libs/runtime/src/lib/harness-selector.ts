import type { ExecutionHarness } from '@temari/contracts';

export interface HarnessSelection {
  /** An explicitly injected host implementation takes precedence. */
  readonly hostHarness: ExecutionHarness | null;
  /** A configured alternate harness; invalid IDs must fail during lookup. */
  readonly configuredHarness: ExecutionHarness | null;
  /** The managed Archon implementation for the default Temari installation. */
  readonly managedDefault: ExecutionHarness | null;
}

/** Resolve a concrete harness without coupling runtime to a vendor package. */
export function selectExecutionHarness(
  selection: HarnessSelection,
): ExecutionHarness {
  const selected =
    selection.hostHarness ??
    selection.configuredHarness ??
    selection.managedDefault;
  if (!selected) {
    throw new Error(
      'No execution harness is available; configure a host or managed harness.',
    );
  }
  return selected;
}
