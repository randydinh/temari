# PII protection at the model boundary

Status on 2026-09-28: the protected host path is implemented, but live private use is blocked. The current `/opt/homebrew/bin/codex` reports `codex-cli 0.154.0`; its credential-free preflight returned `runtime-version`, exit 1, with zero credential requests. The earlier audit of `0.155.0-alpha.16.4` returned `feature-state (unified_exec)`, exit 1, also before credentials or a model turn. Do not remove either check to enable the path. A compatible runtime and independent native-tool isolation proof are required.

Temari has two Codex paths with different privacy coverage. The existing Archon pilot retains native tools. The new protected transport makes the host responsible for supplying data and executing approved tools.

| Path                         | Covered data                                                                                                                                  | Coverage limit                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Protected host transport     | Prompt, schema text, tool descriptions and schemas, allowlisted text files, local screenshot text, tool arguments and results, final response | Only data routed through the host boundary. Raw image and audio inputs are unsupported.    |
| Existing Archon native pilot | Explicit prompt and schema at dispatch, saved prompt and final response, emitted diagnostic and event bodies                                  | Native tools can introduce context internally. Its result reports `explicit-request-only`. |

The protected transport is the intended host path for private application data, but live private use remains blocked until the native runtime and model egress are independently verified. The native pilot reports `explicit-request-only` because it masks only content that the host supplies at dispatch. It does not isolate the actor's filesystem, environment, network, or native tools. Use the pilot only with inputs already approved for model disclosure.

## Host integration

`@temari/host-adapters` exposes the provider-neutral `ModelTransport` contract and `createProtectedModelTransport`. The host passes a trusted model driver and a fixed privacy policy. Each completion gets a separate local restoration scope.

```ts
const transport = createProtectedModelTransport(driver, {
  policy: {
    literals: [{ value: customerName, kind: 'PERSON' }],
  },
  files: { account_export: absoluteExportPath },
  screenshotText: {
    portal: async (signal) => localScreenshotText(signal),
  },
  tools: [
    {
      description: 'Read the selected account status',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async (_args, signal) => [
        {
          kind: 'json',
          value: await readSelectedAccountLocally(signal),
        },
      ],
    },
  ],
});

const reply = await transport.complete({
  prompt: 'Explain the account status.',
  context: [
    { kind: 'file', id: 'account_export' },
    { kind: 'screenshot', id: 'portal' },
  ],
});

try {
  saveMaskedHistory(reply.text);
  showLocalText(reply.displayText());
} finally {
  reply.dispose();
}
```

The named application callbacks in this example must be implemented by the host. File IDs resolve through an explicit allowlist; model-supplied paths are never opened. File reads reject symbolic links, non-UTF-8 or binary data, and oversized content. The path check trusts the current process UID and root. It rejects ancestors owned by another UID or writable by other users. A root-owned sticky directory such as `/private/tmp` is permitted only when its next entry belongs to the process UID. This protects against a different local UID replacing an ancestor between the check and `open`; `O_NOFOLLOW` protects only the final component. A host must not allow another process with the same UID or an ACL to mutate an ancestor while a read is in progress. Screenshot callbacks must extract text locally. Without one, screenshot input fails before dispatch. There is no fallback that sends raw pixels.

Tools receive masked argument values. The transport restores property names declared by the trusted tool schema for the local callback, including protected names. It rejects schema structure changes and duplicate argument keys. Use opaque resource IDs and enforce authorization in each tool. Never use display restoration to recover credentials or authorize a tool action. A trusted local tool may retrieve a credential from an approved store and use it locally, then return only the required application data. This change does not itself install a keychain integration or an OCR engine.

The response's `text` remains masked for history and receipts. `displayText()` restores permitted values only for local display; credentials remain removed. Dispose the response to release its local restoration scope. Treat the restored text as untrusted display text and escape it when rendering HTML.

With `outputSchema`, the response must be valid JSON and is masked structurally, including sensitive field names. Without it, the response is plain text: pattern and explicit-literal detection apply, but JSON-looking text does not automatically get field-based detection. Declare domain-specific private values in the policy even when expecting prose.

## Codex execution

```ts
const driver = createCodexModelDriver({
  executable: absoluteCodexPath,
  model: configuredModel,
  reasoning: configuredReasoning,
  credential: readModelApiKeyLocally,
});
await driver.preflight();
const transport = createProtectedModelTransport(driver, hostConfiguration);
```

The credential callback returns a model API key from the host's approved local store. It does not reuse desktop ChatGPT sign-in automatically. `createCodexModelTransport(options, hostConfiguration)` is the combined convenience entry point in both Nx and the standalone Archon adapter.

To repeat the local check without credentials or inference:

```sh
pnpm nx run workflow-runtime:privacy-preflight --args="/absolute/path/to/codex"
```

A refusal exits nonzero. Even a successful configuration preflight reports `runtimeIsolationVerified: false`; testing actual enforcement and model egress is a separate release gate.

The protected Codex driver owns its configuration, working directory, protocol handling, process environment, and cleanup. It uses a fresh ephemeral thread, disables native capabilities, and returns only text from host-controlled tool calls. Its credential callback supplies the model credential locally; it is never part of a prompt or a serialized host request.

Configuration and protocol checks run before inference. Unexpected settings, instruction sources, permission changes, model/provider substitutions, unknown tool calls, invalid turn identities, and unsupported input types must fail without retrying through an unprotected path. Raw subprocess diagnostics are not forwarded. The driver is tied to its explicitly supported Codex release; upgrade it only with renewed verification.

This is a source integration, not a claim that arbitrary desktop plugins, connectors, or browser tools are intercepted. Those hosts must route their results through this API. Text detection is incomplete by nature. Names, business identifiers, addresses, and other domain values need explicit policy entries; encoded or fragmented private content can evade pattern detection.

## Generated Archon assets

The Nx sources are authoritative. The generator copies the privacy primitive, host boundary, and Codex driver into the standalone Archon distribution, rewrites local imports, and records source and artifact hashes. Generated entries identify their Nx source paths as content snapshots. The inventory's historical v4.1 revision continues to describe the imported baseline.

```sh
pnpm nx run workflow-runtime:privacy-generate
pnpm nx run workflow-runtime:privacy-check
pnpm nx run workflow-runtime:privacy-test
pnpm nx run workflow-runtime:privacy-native-test
pnpm nx test privacy
pnpm nx test host-adapters
```

The checker detects stale generated files and provenance. It runs before the workflow-runtime test, package, and check targets. Generation refuses unrelated payload drift. The relocated-artifact tests run both the adapter and host transport outside the workspace so missing distribution files cannot be hidden by monorepo imports. CI also runs the privacy/driver tests and synthetic native compatibility suite; it does not request credentials or perform model inference.

## Decision and verification scope

We compared extending the fixed native pilot with a separate protected transport. The separate transport owns the complete host-mediated request, while the pilot's native tools can read data before Temari sees their output events. Suppressing an event after that read cannot undo model exposure.

Boundary Discipline places masking immediately before each host-controlled model dispatch. Model the Domain distinguishes text, JSON, file references, and screenshot text, making unsupported pixels an explicit rejection. Verification uses synthetic private-value canaries across requests, tool replies, failure paths, saved artifacts, and a relocated distribution. Live private data should wait for independent runtime isolation evidence; synthetic protocol tests alone do not supply that evidence.

Implementation checkpoint:

- Blocking first steps: inspect the actual local protocol and configuration controls before defining the transport.
- Independent workstreams: harden masking, implement the isolated driver, and build the reproducible asset generator in separate files.
- Shared mutable state: keep restoration maps within one request; generate shared inventories only after source integration.
- Smallest safe decomposition: one privacy primitive, one host boundary, one provider driver, and a generated standalone copy.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server). Local protocol bindings from the installed release are the implementation evidence; the current documentation is not a substitute for runtime verification.

## Verification record — 2026-09-27

Local verification passed: 31 privacy tests, 67 host-adapter tests, 37 generator tests, 2 relocated adapter/transport tests, and 77 native workflow/lifecycle tests. The existing workflow-runtime tests, all 11 project typechecks, formatting, generated-provenance checks, and `git diff --check` also passed. Tests used synthetic fixtures; no real credentials or model inference were used.

The real credential-free preflight was an expected refusal, not a successful isolation test: `feature-state (unified_exec)`, with `credentialRequests: 0`. CI coverage has been added but has not yet run on GitHub. Live private-data use remains blocked pending a compatible runtime and independent enforcement verification.
