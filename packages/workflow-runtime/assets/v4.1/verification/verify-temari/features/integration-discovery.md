# Integration discovery

Temari inventories existing MCP, API, connector, configuration, documentation, and live-access evidence before it proposes installing or building an external-service integration.

## Sub-features

- `integration-user-claim` preserves the user's statement that an integration exists as a discovery lead.
- `integration-surface-census` requires evidence from current tools, MCP resources, host registrations, project configuration, project-owned integration code, internal docs, official provider docs, and connector catalogs.
- `integration-lifecycle` keeps suitability, configuration, exposure, authentication, and live verification separate for every candidate.
- `integration-policy-action` derives reuse, connection, installation, custom development, or blocked from evidence rather than accepting a caller-written decision.
- `integration-session-scope` rejects a receipt carried over from another task scope.
- `integration-direct-poteto` applies the same gate when poteto-mode is invoked directly.

## How to get to it (user POV)

- Ask Temari to build, connect, repair, or use an integration with an external service.
- Tell Temari that an MCP server, API client, plugin, or connector already exists.
- Ask Temari why it is proposing a new integration instead of reusing the current one.

## Driving it with control-temari

Preconditions:

- Use synthetic receipts without credentials, tokens, or production provider output.
- Run `python3 verification/verify-temari/scripts/test-integration-discovery.py`. Require all behavior cases to pass.

- **Complete reusable provider.** The behavior test supplies a suitable candidate whose configured, exposed, authenticated, and verified states are present. Require the real checker to derive `reuse` from an unrelated working directory.
- **Configured but unavailable here.** The behavior test supplies a suitable configured candidate whose exposed and verified states are absent. Require `connect`, proving that another registration is not treated as callable here.
- **Install after suitability.** The behavior test supplies one configured unsuitable provider and one suitable unconfigured provider. Require `install` of the suitable candidate.
- **Premature build.** Require `--require-action build` against a suitable configured provider. Require exit 1 while the emitted policy action remains `connect`.
- **Incomplete or stale census.** Remove an observation, mark a surface unavailable, and change the session scope in separate cases. Require a validation failure or `blocked` as defined by the contract.
- **Packaged checker.** Run `scripts/check-host-adapters.sh`. Require the copied installations and built Codex plugin to contain the reference and checker and to execute the behavior suite from outside the package root.

## Gotchas

- A registration found in another project or application is `configured`, not `exposed`.
- A callable tool with unknown credentials is not `authenticated` or `verified`.
- API documentation establishes the supported boundary; it does not establish account access.
- Do not place credentials or raw provider responses in the receipt.
- The checker derives the permitted action from declarative evidence; it cannot prove that the evidence is truthful. A harmless live read is still required before it can derive `reuse`.
