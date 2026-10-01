export * from './lib/host-adapters.js';
export * from './lib/codex-exec-worker.js';
export * from './lib/live-doctor.js';
export * from './lib/model-transport.js';
export * from './lib/codex-model-driver.js';
export * from './lib/openai-responses-driver.js';
export * from './lib/ollama-model-driver.js';
export * from './lib/qa-local-category-search.js';

import {
  createCodexModelDriver,
  type CodexModelDriverOptions,
} from './lib/codex-model-driver.js';
import {
  createProtectedModelTransport,
  type PrivacyHost,
} from './lib/model-transport.js';
import {
  createOpenAIResponsesDriver,
  type OpenAIResponsesDriverOptions,
} from './lib/openai-responses-driver.js';
import {
  createOllamaModelDriver,
  type OllamaModelDriverOptions,
} from './lib/ollama-model-driver.js';

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

export function createOpenAIResponsesModelTransport(
  options: OpenAIResponsesDriverOptions,
  host: PrivacyHost = {},
) {
  return createProtectedModelTransport(
    createOpenAIResponsesDriver(options),
    host,
  );
}

export function createOllamaModelTransport(
  options: OllamaModelDriverOptions,
  host: PrivacyHost = {},
) {
  return createProtectedModelTransport(createOllamaModelDriver(options), host);
}
