# Install the self-contained Temari package

This guide is for someone installing Temari into a project. The unified distribution includes Node 22.23.3, Python 3.12.15, Archon 0.10.1, the verified Temari 0.15.5 marketplace, dashboard, and prepared knowledge dependencies. Recipient setup requires no system Node, Python, pip, or uv and performs no runtime or dependency downloads.

Temari is the main conversation. The runtime coordinates admitted work and retains task and worker state; Poteto provides the engineering method. Archon remains the native execution harness. This increment connects these existing components through one setup journey.

## Before setup

Use the distribution for your OS and CPU. Actual recipient verification currently covers macOS arm64. Linux x64/arm64 and macOS x64 have pinned upstream assets but still require their own recipient verification. Native Windows knowledge is not supported; use a Linux distribution inside WSL2 after Linux verification.

Extract the distribution and obtain its `UNIFIED.json` SHA-256 from the release publisher through a trusted channel. Verify the archive before executing the included launcher. The manifest digest is required independently; computing a new digest from an untrusted download does not establish trust.

Choose an existing project directory and a fresh absolute data directory outside both the project and extracted distribution. Setup refuses to adopt a nonempty unowned directory. Data, conversations, tasks, and the registry stay outside immutable installation files.

Configure one model transport in a copy of `profile.example.json`. Ollama requires an already installed model with tool support. OpenAI Responses requires an environment variable containing the credential, inherited by the launched dashboard. Never put credential values in the profile. Example:

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

## Setup and daily use

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

`knowledge-mcp.json` in the data directory selects the managed Python interpreter and a stdio MCP server limited to the starter source. Configure that connection in a client supporting stdio MCP. Setup tests the actual connection; it does not register every host's MCP client automatically. External source intake and hosted-library access use the existing [knowledge contract](install-temari.md), with explicit source admission.

The verified Codex marketplace is included under `installations/RELEASE_MANIFEST_SHA256/marketplace`. Connect it using the existing [plugin installation guide](install-temari.md). This additive package preserves the 0.15.5 plugin's verification contract.

Chat and library access work with the configured model transport. Engineering execution still needs the existing host capability and repository admission. The default controller provides task intake with no execution recipes. To enable work, supply the optional `control` object using the [dashboard configuration](../task-dashboard.md#control-configuration-reference). Existing managed candidate profiles receive the included Node/Python interpreter pins during setup. Codex workers, repository authentication, models, and forge access remain explicit host requirements; managed runtimes do not prove those capabilities.

## Retry and recovery

Repeat the exact setup command to retain data and check installation identity. Retry refuses a changed release or profile, modified runtimes/dependencies, unexpected Python startup files, and changed venv configuration. It can finish a partial dependency copy. It does not silently upgrade or reactivate disabled knowledge.

If `.setup-lock` remains after an interrupted process, inspect `owner.json` and verify that the process has stopped before removing that lock. Retained installation staging also requires explicit inspection before recovery. Preserve the home and `setup.json` when reporting a failure. Use a new empty home for a separate release; automatic in-place upgrades and data migration are follow-up work.

## Build a distribution

Maintainers need workspace dependencies and uv. First build the dashboard with `pnpm exec nx run dashboard:build`. Then run `workflow-runtime:unified-package` with absolute `--marketplace-root`, `--dashboard`, fresh `--output`, `--cache`, and the independently verified `--release-sha256` and `--public-manifest-sha256`. The builder acquires hash-pinned native assets, installs locked binary Python dependencies, and copies Registrar source and metadata from the verified release. It performs no unpinned Python build-backend installation.

The output includes `UNIFIED.json` and its printed digest. Archive the complete directory while preserving executable modes and relative runtime symlinks. Publish archive and manifest digests separately from the archive. Run the recipient journey for every platform before advertising support.
