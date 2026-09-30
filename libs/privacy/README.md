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

## Local disclosure preferences

`planPrivacySubmission` provides Strict, Balanced, and Permissive settings for a host that owns the final model-bound payload. Strict masks automatically detected identifiers but honors exact values the user explicitly authorized, including saved rules. Balanced also honors exact-value allow rules with a verified-public evidence reference. Permissive disables ordinary automatic identity detection only after the user acknowledges broad noncredential disclosure. Credential syntax and credential fields remain protected in all three levels. Explicit application literals and field policies still take priority over allow rules.

Rules name an exact value, workspace scope, optional source scope, and `submission` or `saved` persistence. An allow rule sends that value unchanged where automatic detection would otherwise mask it. A substitute rule replaces the matched value with a deterministic local value and then masks the result again. The returned preview contains counts, applied rule IDs, and possible effects on the answer, without original values. It is information for a local UI, not another approval gate.

`savePrivacyPreferences` and `loadPrivacyPreferences` store standing rules in an existing private Unix directory and refuse symlinks or loose file permissions. The file contains the exact rule values in plaintext under owner-only permissions; choose a trusted local directory. Submission-only rules cannot be saved. Windows hosts must provide their own approved local store. These APIs do not change the existing host transport automatically; the host must integrate the plan at its final egress boundary and keep preview data local.

For repeated one-submission allows, call `recordPrivacyOverride` with the stored preferences and the approved submission rule, then save the returned preferences. It keeps only a keyed fingerprint of the value until the user chooses to save it. The UI may offer “save for this scope” with the first approval; on the second approval of the same value and scope, the returned `offer` tells the host to suggest it proactively. `resolvePrivacyOverride` accepts `save`, `not-now`, or `never-suggest`: saving converts the rule to a standing rule, declining postpones the next offer, and never-suggest suppresses that offer for the same value and scope. Save the resolved preferences. The library never promotes an approval on its own; the host must show the choice locally and apply the saved rule on later requests.

## What it covers

- explicit literals and JSON Pointer field rules
- common private field names and pattern detection
- request-scoped placeholders
- credential removal without raw-value retention or restoration; bounded keyed fingerprints recognize later repetitions within the request
- optional scoped disclosure and substitution rules with a local decision preview
- fail-closed handling for malformed and foreign placeholders
- no network or keychain access; the masking primitive has no filesystem access, while the optional settings store writes only its configured local file

## What it does not cover

This is not full data-loss prevention. It cannot see data an agent reads from files, screenshots, tools, instruction sources, logs, or provider-managed history. Detectors can miss arbitrary names, addresses, organization names, international phone numbers, encoded or fragmented secrets, and private business facts. Use explicit policies for domain-specific values.

The Archon adapter imports a generated standalone copy of this package. Its existing native-tool pilot masks explicit prompts and schemas, suppresses raw process diagnostics and event bodies, and saves masked results. It reports `explicit-request-only` coverage because native file and tool reads remain outside this library.

The separate protected transport routes host-provided data through this boundary. Its Codex driver uses an isolated configuration and restricts native capabilities. A supported protocol and passing unit tests do not establish that every Codex release or external host tool is protected. Hosts must use the protected entry point and verify their runtime before processing private data.
