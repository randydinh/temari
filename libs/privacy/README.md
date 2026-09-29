# Privacy boundary

`@temari/privacy` masks explicit and detected private values before a model request and restores only request-owned identity values for local display.

## Use the boundary at the last local call site

```ts
import {
  mask,
  restoreForDisplay,
  disposePrivacySession,
} from '@temari/privacy';

const prepared = mask(
  { prompt, customerId },
  { literals: [{ value: customerId, kind: 'ACCOUNT' }] },
);

try {
  const modelReply = await sendToModel(prepared.payload);
  const displayReply = restoreForDisplay(modelReply, prepared.session);
  showLocalText(displayReply);
} finally {
  disposePrivacySession(prepared.session);
}
```

Keep `prepared.payload` for model history. Keep `displayReply` local. Do not pass the restored value to a model, tool, log, receipt, or later prompt. Call `disposePrivacySession(prepared.session)` when the local display no longer needs restoration.

The host adapter now supplies a higher-level `createProtectedModelTransport` wrapper. It handles request scopes, host tool results, allowlisted text files, and locally extracted screenshot text. See [the integration guide](../../docs/privacy-model-transport.md).

## What it covers

- explicit literals and JSON Pointer field rules
- common private field names and pattern detection
- request-scoped placeholders
- credential removal without raw-value retention or restoration; bounded keyed fingerprints recognize later repetitions within the request
- fail-closed handling for malformed and foreign placeholders
- no network, filesystem, or keychain access

## What it does not cover

This is not full data-loss prevention. It cannot see data an agent reads from files, screenshots, tools, instruction sources, logs, or provider-managed history. Detectors can miss arbitrary names, addresses, organization names, international phone numbers, encoded or fragmented secrets, and private business facts. Use explicit policies for domain-specific values.

The Archon adapter imports a generated standalone copy of this package. Its existing native-tool pilot masks explicit prompts and schemas, suppresses raw process diagnostics and event bodies, and saves masked results. It reports `explicit-request-only` coverage because native file and tool reads remain outside this library.

The separate protected transport routes host-provided data through this boundary. Its Codex driver uses an isolated configuration and restricts native capabilities. A supported protocol and passing unit tests do not establish that every Codex release or external host tool is protected. Hosts must use the protected entry point and verify their runtime before processing private data.
