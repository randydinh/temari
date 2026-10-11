# Install the self-contained Temari package

This guide is for someone installing Temari into a project. The unified distribution includes Node 22.23.3, Python 3.12.15, Archon 0.10.1, the verified Temari 0.15.5 marketplace, dashboard, and prepared knowledge dependencies. Recipient setup requires no system Node, Python, pip, or uv and performs no runtime or dependency downloads.

Temari is the main conversation. The runtime coordinates admitted work and retains task and worker state; Poteto provides the engineering method. Archon remains the native execution harness. This increment connects these existing components through one setup journey.

## Before setup

Use the distribution for your OS and CPU. Native recipient verification covers macOS arm64 (macOS 14), Intel macOS (macOS 15), and Linux x64/arm64 (Ubuntu 24.04). Intel macOS uses an outer, hash-pinned compatibility lock with cryptography 48.0.1. Full Intel setup and knowledge access pass in native Intel CI and locally under Rosetta. Original Registrar and marketplace dependency metadata remain unchanged. Native Windows binaries pass version diagnostics, but knowledge setup is unsupported. WSL2 and other OS/libc/CPU baselines still need their own recipient verification.

Extract the distribution and obtain its `UNIFIED.json` SHA-256 from the release publisher through a trusted channel. Verify the archive before executing the included launcher. The manifest digest is required independently; computing a new digest from an untrusted download does not establish trust.

Choose an existing project directory and a fresh absolute data directory outside both the project and extracted distribution. Setup refuses to adopt a nonempty unowned directory. Data, conversations, tasks, and the registry stay outside immutable installation files.

Have a chat connection available: Ollama with an installed model that supports tools, or an OpenAI API key and an available API model. Install Codex or Claude Code if you want engineering workers or client registration. Temari manages Node, Python and Archon; provider CLIs and Ollama models are separate prerequisites.

## Guided setup and daily use

From the extracted distribution, run:

```sh
./setup guide --expected-manifest-sha256 RELEASE_MANIFEST_SHA256
```

The guide asks for your project and data directory, discovers local models and host executables, and generates the profile. It checks the chat connection with a harmless message, installs the managed components, verifies the starter library, registers knowledge in the selected client, and starts Temari. Open the printed dashboard URL. Talk is the main view; worker progress stays in the dashboard.

For Codex engineering, the guide reuses native sign-in or starts the official browser login. Use `--device-auth` for device login. It discovers models available to that CLI account and pins the selected executable, model and reasoning. ChatGPT CLI sign-in authenticates engineering workers; OpenAI Responses chat uses a separate API key. The protected `codex` chat transport remains available through scripted configuration with its separately pinned CLI and API credential.

Claude scoped workers require Claude Code 2.1.286 or newer. Choose an Anthropic API key or the same local Ollama endpoint used for chat. Bare workers ignore saved client OAuth credentials. Claude client knowledge registration works independently of worker authentication.

API keys are collected without terminal echo, or taken from the existing environment. The guide saves selected credentials in an owner-only `credentials.json` in the data directory; the launcher resolves them at each start. Values stay out of profiles, receipts and command arguments. Keep that directory private and exclude it from source control and shared archives. Native Codex credentials remain with Codex.

For unattended setup, supply the choices as options. No profile JSON is needed:

```sh
./setup guide --expected-manifest-sha256 RELEASE_MANIFEST_SHA256 \
  --home /absolute/path/to/temari-data --workspace /absolute/path/to/project \
  --chat ollama --model YOUR_INSTALLED_MODEL \
  --worker codex --worker-executable /absolute/path/to/codex \
  --worker-model YOUR_ACCOUNT_MODEL --worker-reasoning high --clients codex
```

Use `--clients codex,claude-code` to connect both installed clients, or `--clients none` for only the dashboard. Supply `--claude-executable` when Claude is outside PATH. `--worker none` selects chat and knowledge only. `--no-start` installs without starting the dashboard; `./setup --help` lists the supported choices. Cloud credentials must be in the process environment for unattended setup.

The data directory contains an executable launcher:

```sh
/absolute/path/to/temari-data/temari status
/absolute/path/to/temari-data/temari doctor
/absolute/path/to/temari-data/temari stop
/absolute/path/to/temari-data/temari start
```

No global PATH changes are needed. Keep the data directory at its installed location: profiles and MCP connections use absolute paths. The extracted distribution can move before setup.

`phase: ready` means guided installation, the chat probe and selected registration completed. A harmless chat probe does not prove tool calling or engineering success. Ask a library question and check its returned citations. Actual coding still requires project-specific admitted scopes and checks.

## Scripted profile setup

Existing integrations can continue using `setup --profile`. Configure one model transport in a copy of `profile.example.json`. Never put credential values in the profile. Example:

```json
{
  "schema": 1,
  "id": "my-project",
  "workspaceRoot": "/absolute/path/to/my-project",
  "port": 3095,
  "transport": { "kind": "ollama", "model": "YOUR_INSTALLED_MODEL" }
}
```

For OpenAI Responses, replace `transport` with:

```json
{ "kind": "openai-responses", "model": "YOUR_MODEL", "credentialEnv": "OPENAI_API_KEY" }
```

From the extracted distribution, run:

```sh
./setup setup --home /absolute/path/to/temari-data \
  --profile /absolute/path/to/profile.json \
  --expected-manifest-sha256 RELEASE_MANIFEST_SHA256 --start
```

Setup verifies the complete distribution and nested marketplace, installs isolated runtimes, prepares the registry, discovers and reads the public starter library with citations, performs a read-only MCP handshake, and configures the installed dashboard. It prints `phase: ready` and a local dashboard URL when started. `ready` proves setup and local knowledge readiness; it does not certify a live model answer or engineering execution.

Open the printed URL. Talk is the main view when configured. Create a topic, ask Temari a question, and link durable tasks to see retained progress. The existing task and worker panels remain available. Model quality and tool calling depend on the selected model; verify an answer against its returned document citations.

The data directory contains an executable launcher for daily commands:

```sh
/absolute/path/to/temari-data/temari status
/absolute/path/to/temari-data/temari doctor
/absolute/path/to/temari-data/temari stop
/absolute/path/to/temari-data/temari start
```

No global PATH changes are needed. Keep the data directory at its installed location: retained profiles and MCP connections use absolute paths. You can move the extracted distribution before setup.

## Knowledge and engineering connections

`knowledge-mcp.json` selects the managed Python interpreter and a stdio MCP server limited to the starter source. Guided setup registers it in selected Codex and Claude clients with their official commands. It preserves unrelated settings and refuses conflicting or disabled Temari entries. Restart the client to load the connection. Scripted setup emits the connection without client registration. Other stdio clients can use that file through their own setup flow. External source intake and hosted-library access use the existing [knowledge contract](install-temari.md), with explicit source admission.

The verified Codex marketplace is included under `installations/RELEASE_MANIFEST_SHA256/marketplace`. Guided Codex registration connects the local marketplace and enables Temari. An existing marketplace at another path can be reused only after verifying it against the same independent release and public manifest pins. A different release or disabled plugin stays blocked for explicit client repair. Claude receives knowledge access; the public 0.15.5 plugin remains Codex-specific.

Guided setup generates a read-only investigation swarm when a worker host is selected. For a Git project with a commit, it also supplies the existing clean-checkout verification recipe. Its result applies to that recipe, not arbitrary application behavior. The runtime owns worker progress and Archon remains the native harness. Coding plans, project-specific verification, forge access and full host admission retain their existing contracts. Scripted profiles can supply `control` through the [dashboard configuration](../task-dashboard.md#control-configuration-reference); managed candidate profiles receive the included Node/Python interpreter pins during setup.

## Select an engineering host

Investigation and configured implementation plans share one execution adapter. Existing configurations default to Codex. Optional `providerSelection` and `scopedToolServer` fields belong to `control.swarm` or `control.implementation`, together with the existing executable, concurrency, time bound and plans. Browser input cannot choose a different executable or expand its tools.

For Claude Code, install and authenticate its native CLI separately. Version 2.1.286 or later is required. Select its exact executable/version/hash and an explicit model:

```json
{
  "executable": "/absolute/path/to/claude",
  "providerSelection": {
    "provider": "claude-code",
    "executableSha256": "INDEPENDENT_EXECUTABLE_SHA256",
    "executableVersion": "2.1.296 (Claude Code)",
    "model": "YOUR_MODEL",
    "policy": "temari-scoped-tools-v1",
    "maxTurns": 32,
    "maxBudgetUsd": 5
  },
  "maxConcurrency": 2,
  "timeoutMs": 180000,
  "plans": ["REPLACE_WITH_A_VALID_ADMITTED_PLAN"]
}
```

This fragment illustrates the implementation transport; replace `plans` using the [configured plan contract](../dashboard-implementation-design.md). For investigations, use `maxWorkers` instead of `plans`. Unified setup supplies the bundled scoped MCP server and managed Node interpreter pins. Source-only callers must supply `scopedToolServer: {path, sha256}` explicitly; optional `nodeExecutable` and `nodeSha256` must be paired.

Claude workers use only bounded filesystem MCP tools: read, list, search, and writes within typed ownership. Built-in tools, inherited MCP servers, hooks, skills and subagents are disabled by bare mode and exact tool selection. Shell and network tools are unavailable to workers. The CLI still contacts its configured model provider; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` may be inherited from the launching environment. Bare mode does not use saved OAuth/keychain credentials. Keep credential values out of profiles and evidence.

Trusted preparation and combined verification commands remain coordinator configuration. The runtime integrates worker patches, runs verification, and retains a separate reviewer result. Archon remains the native harness for admitted run workflows. Worker success alone cannot mark Temari DONE or authorize publication. Provider, tool server, interpreter and policy pins are retained with process evidence; changing the host configuration requires a fresh preparation.

The public 0.15.5 marketplace stays Codex-specific. The additive dashboard adapter does not claim Claude plugin installation or full-feature host admission. See the [increment evidence](../plans/portable-execution-increment-2026-10-10.md) for exactly which hosts and model backends were exercised.

## Retry and recovery

Repeat the exact setup command to retain data and check installation identity. Retry refuses a changed release or profile, modified runtimes/dependencies, unexpected Python startup files, and changed venv configuration. It can finish a partial dependency copy. It does not silently upgrade or reactivate disabled knowledge. For guided setup, rerun `guide` with the same release and home. Saved choices are replayed after an interrupted installation or partial registration. Changed choices or changed host executable bytes require a new home. Repair reported client conflicts and retry; no configuration hand-editing is needed for the supported initial journey. Existing scripted installations are not silently adopted as guided installations.

If `.setup-lock` remains after an interrupted process, inspect `owner.json` and verify that the process has stopped before removing that lock. Retained installation staging also requires explicit inspection before recovery. Preserve the home and `setup.json` when reporting a failure. Use a new empty home for a separate release; automatic in-place upgrades and data migration are follow-up work.

## Build a distribution

Maintainers need workspace dependencies and uv. First build the dashboard with `pnpm exec nx run dashboard:build`. Then run `workflow-runtime:unified-package` with absolute `--marketplace-root`, `--dashboard`, fresh `--output`, `--cache`, and the independently verified `--release-sha256` and `--public-manifest-sha256`. The builder acquires hash-pinned native assets, installs locked binary Python dependencies, and copies Registrar source and metadata from the verified release. It performs no unpinned Python build-backend installation.

The output includes `UNIFIED.json` and its printed digest. Archive the complete directory while preserving executable modes and relative runtime symlinks. Publish archive and manifest digests separately from the archive. Run the recipient journey for every platform before advertising support.
