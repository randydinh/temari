# PII protection at the model boundary

Status on 2026-09-29: the protected host path has three optional drivers behind the same provider-neutral `ModelDriver` interface. Live private application use is still blocked. The current `/opt/homebrew/bin/codex` reports `codex-cli 0.154.0`; its credential-free preflight returned `runtime-version`, exit 1, with zero credential requests. The earlier audit of `0.155.0-alpha.16.4` returned `feature-state (unified_exec)`, exit 1, also before credentials or a model turn. Do not remove either check to enable that driver. The direct OpenAI Responses driver has synthetic HTTP and relocated-package evidence; it still needs a credentialed end-to-end test and an independent egress review. A local Ollama driver has a live synthetic canary but has not been used with private application data.

Temari has two Codex paths with different privacy coverage. The existing Archon pilot retains native tools. The new protected transport makes the host responsible for supplying data and executing approved tools.

| Path                         | Covered data                                                                                                                                  | Coverage limit                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Protected host transport     | Prompt, schema text, tool descriptions and schemas, allowlisted text files, local screenshot text, tool arguments and results, final response | Only data routed through the host boundary. Raw image and audio inputs are unsupported.    |
| Existing Archon native pilot | Explicit prompt and schema at dispatch, saved prompt and final response, emitted diagnostic and event bodies                                  | Native tools can introduce context internally. Its result reports `explicit-request-only`. |

The protected transport is the intended host path for private application data, but live private use remains blocked until the selected driver and model egress are independently verified. The native pilot reports `explicit-request-only` because it masks only content that the host supplies at dispatch. It does not isolate the actor's filesystem, environment, network, or native tools. Use the pilot only with inputs already approved for model disclosure.

## Disclosure settings and standing rules

The Nx privacy library now exposes a local `planPrivacySubmission` API with three levels. **Strict** applies automatic identity and field-name detection but honors exact values the user explicitly authorized, including saved rules. **Balanced** applies the same detection and also honors scoped, exact-value allow rules that cite a verified public source. **Permissive** requires an explicit standing acknowledgement and skips ordinary automatic identity detection; credential patterns and credential fields still mask. None of these settings changes the Codex runtime-isolation gate, provider egress review, or operator approval for live private use.

A rule applies to one workspace and optionally one source. It either allows an exact value or replaces it with a deterministic local substitute, such as a service zone calculated from an address. Rules can last for one submission or be saved for later submissions in the same scope. An uncertain claim of public status does not create an allow rule: a verified-public rule needs a local evidence reference that the host has verified, while a user-authorized rule records the user's explicit disclosure choice. Application-declared privacy literals and field rules take precedence over either rule type, and a saved allow cannot restore a credential already removed in an earlier batch.

The plan returns the model-bound payload and a local preview with masked category counts, applied rule IDs and counts, likely losses such as location reasoning, and a flag when Permissive may disclose unclassified values. The preview contains no source values and can be shown without pausing every request. The opt-in Unix file store writes saved rules with owner-only permissions in a private directory; exact values are stored locally in plaintext. Submission-only rules cannot be persisted, and Windows hosts need their own approved store.

To reduce repeated prompts, the host can record each explicit one-submission allow with `recordPrivacyOverride`. The stored observation is a keyed fingerprint, not the raw value. The host may show “save for this scope” on the first approval; after the same exact value has been allowed twice in that scope, the API suggests it proactively. `resolvePrivacyOverride` honors `save`, `not-now`, and `never-suggest`; not-now delays the next offer and never-suggest suppresses it for that scoped value. Only a user choice of save creates a standing allow rule. The host must save the returned preferences and let the user remove saved rules later.

The [privacy learning experiment](privacy-learning.md) defines synthetic cases for evaluating group suggestions with SkillOpt before any learned rule can reach this boundary.

This is a privacy-library increment. The current host adapters do not yet expose a settings UI, load saved rules, or apply this planner across prompts, files, screenshot text, and later tool results. A host integration must do that before treating a setting as active. The generated standalone Archon copy also needs synchronization after the authoritative source change. Until the selected driver passes its independent live-use gates, these settings are for synthetic and local planning only.

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

## Direct Responses execution

Hosts that cannot satisfy the Codex native-isolation preflight can select the optional direct API driver without changing `ModelTransport`, the privacy policy, or host tool callbacks:

```ts
const driver = createOpenAIResponsesDriver({
  model: configuredModel,
  credential: readModelApiKeyLocally,
});
const transport = createProtectedModelTransport(driver, hostConfiguration);
```

`createOpenAIResponsesModelTransport` is an Nx convenience entry. The generated standalone Archon payload also contains `openai-responses-driver.ts`; it can be composed with its generated `model-transport.ts`. The model is host-selected. The credential callback runs only after the request is validated and supplies an API key locally. The adapter calls the fixed OpenAI Responses endpoint with `store: false`, no provider-built tools, and only the host-defined function tools. It replays response items and host tool outputs for a bounded stateless function-call loop. Each request and response is size-bounded, unknown calls and unsupported output forms fail closed, and provider error bodies are not forwarded. The host still owns authorization and validation inside each tool callback. Other model providers can implement `ModelDriver` without changing the privacy boundary.

This adapter has not made a real model request. Its mock HTTP tests verify request shape, stateless tool continuation, credential separation, masked prompt and callback content, JSON output, and refusal paths. A relocated Archon test verifies the generated copy. Before enabling private use, run a credentialed canary with the actual selected model, verify function and schema behavior, confirm the service's data-handling settings, and independently review the egress and host tool boundary. The Codex native-tool gate is specific to the Codex driver; a direct API call has no native model tools unless the host explicitly supplies callbacks.

API references: [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling), [stateless reasoning continuation](https://developers.openai.com/api/docs/guides/reasoning), and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Local Ollama execution

Hosts can select an installed local model through `createOllamaModelDriver` or the `createOllamaModelTransport` convenience entry. The adapter uses Ollama's native `/api/chat` endpoint, restricted to a `127.0.0.1` origin. It accepts the same protected prompt, JSON schema, and host tool definitions as the other drivers; it has bounded request and response sizes, turns, and tool calls. It has no credential callback and cannot point at a remote endpoint. This driver is available from the Nx host-adapters package; it is not part of the historical standalone v4.1 Archon payload.

On this host, Ollama `0.31.1` is listening on loopback and `qwen3-coder:30b` is installed. `pnpm nx run host-adapters:local-ollama-canary` used only synthetic text and passed prompt masking, JSON schema output, and a live host-tool callback. The canary is intentionally separate from CI because CI does not install a model. It does not prove QA judgment, all schema shapes, host confinement of a future evaluator, or private application policy quality. Use the installed model only after the host has approved its local data handling and tool callbacks.

API references: [Ollama native chat API](https://github.com/ollama/ollama/blob/main/docs/api.md), [structured outputs](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx), and [OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx).

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

## Verification record — 2026-09-28

At code commit `93c3786f049731ddc5a55502cd6c3f03b60000be`, uncached Nx checks passed 31 privacy, 69 host-adapter, 34 workflow-runtime, 37 generator, 2 relocated adapter, 77 synthetic native, and 31 public-entry tests. The Archon package check accepted all 237 inventory entries. The current installed Codex preflight refused `runtime-version`, exit 1, with zero credential requests. The [NX-04 handoff](./migrations/nx-04-privacy-handoff.md) records the exact commands and artifact digest. CI and independent review are still pending for the final PR head. Live private use remains blocked.
