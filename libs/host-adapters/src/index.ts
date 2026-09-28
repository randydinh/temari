export * from './lib/host-adapters.js';
export * from './lib/model-transport.js';
export * from './lib/codex-model-driver.js';

import {
  createCodexModelDriver,
  type CodexModelDriverOptions,
} from './lib/codex-model-driver.js';
import {
  createProtectedModelTransport,
  type PrivacyHost,
} from './lib/model-transport.js';

export function createCodexModelTransport(
  options: CodexModelDriverOptions,
  host: PrivacyHost = {},
) {
  const driver = createCodexModelDriver(options);
  return {
    ...createProtectedModelTransport(driver, host),
    preflight: driver.preflight,
  };
}
