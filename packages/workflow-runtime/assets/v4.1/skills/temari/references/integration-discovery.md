# Integration discovery gate

Apply this gate before planning, delegating, or implementing work that depends on an external service, API, MCP server, connector, plugin, CLI provider, or authenticated browser application.

## Inventory before choosing an implementation

Treat a user's statement that an integration exists as a high-priority lead. Record it verbatim, then inspect all relevant surfaces:

1. tools callable in the current session, including deferred tools;
2. MCP resources and resource templates exposed to the current session;
3. the host's MCP or connector registrations and enabled state;
4. project, workspace, and host configuration that may register a provider;
5. project-owned integration code;
6. internal integration and workflow documentation;
7. the provider's current official API, SDK, CLI, and MCP documentation;
8. the available connector or plugin catalog.

Use the current host's native inventory operations. A provider configured in another project, application, or host is an existing candidate, but it is not callable in the current session. Configuration does not establish authentication or live behavior.

## Record evidence, not the decision

Create `.temari/runs/<run-id>/integration-inventory.json`. Use a fresh opaque `session_scope` for the current task unless the host exposes a stable task identifier. Keep credentials and sensitive provider output out of the receipt.

```json
{
  "schema_version": 1,
  "session_scope": "current-task-scope",
  "service": "Example",
  "need": "Read bounded operational events",
  "requested_interfaces": ["mcp", "api"],
  "user_claims": ["An MCP server already exists."],
  "observations": {
    "current-tool-surface": {"state": "checked", "evidence": "No Example tools are exposed in this session."},
    "mcp-resources": {"state": "checked", "evidence": "No Example resources or templates are exposed."},
    "host-registrations": {"state": "checked", "evidence": "Example is registered in another project."},
    "project-config": {"state": "checked", "evidence": "Registration found at a named configuration path."},
    "project-integration-code": {"state": "checked", "evidence": "Existing API clients were searched and inspected."},
    "internal-docs": {"state": "checked", "evidence": "Internal workflow and query guidance was inspected."},
    "official-provider-docs": {"state": "checked", "evidence": "Official API and MCP documentation was inspected."},
    "connector-catalog": {"state": "checked", "evidence": "No installed connector exposes Example here."}
  },
  "candidates": [
    {
      "name": "example-mcp",
      "kind": "mcp",
      "source": "project-config",
      "suitability": "suitable",
      "suitability_evidence": "It supports the bounded read operation in need.",
      "configured": "present",
      "exposed": "absent",
      "authenticated": "unknown",
      "verified": "unknown"
    }
  ],
  "gaps": ["Authentication and a harmless live read remain unverified."]
}
```

Observation states are `checked`, `not-applicable`, or `unavailable`. A `not-applicable` or `unavailable` observation needs a concrete reason. `unavailable` means the census is incomplete and forces `blocked`.

Candidate lifecycle states are `present`, `absent`, or `unknown`:

- `configured` means a registration or implementation was found;
- `exposed` means the current task can call it;
- `authenticated` means its current credential state was verified;
- `verified` means a harmless live read succeeded through it.

Suitability is `suitable`, `unsuitable`, or `unknown` for the receipt's exact `need`. Access failure does not make a provider unsuitable. Capability limits do.

## Let policy derive the path

Resolve the package root through the active host entry. Run the checker by absolute path so an installed package works from any project directory:

```bash
python3 <resolved-package-root>/skills/temari/scripts/check-integration-inventory.py \
  --session-scope <current-task-scope> \
  .temari/runs/<run-id>/integration-inventory.json
```

The checker owns the action:

- `reuse` when a suitable provider is exposed and live-verified;
- `connect` when a suitable configured provider needs exposure, authentication, or a harmless live probe;
- `install` when a suitable supported candidate is explicitly unconfigured and no suitable configured candidate exists;
- `build` only when every discovered candidate is unsuitable, or no candidate exists after a complete census;
- `blocked` when a required surface is unavailable or any candidate that could affect escalation has unknown suitability or configuration.

Use `--require-action <action>` before proposing that action. A mismatch exits nonzero. Do not describe an integration as missing until every applicable observation is checked. Carry the authoritative API or tool schema into implementation. After connection or installation, repeat the census with current states and require `reuse` before reporting the integration as working.

## Packaged Archon foundation

Temari offers an optional [Archon execution foundation](../../../verification/verify-temari/features/archon-installation.md). It is unavailable in the portable distribution. The Archon distribution supports deterministic scheduling, evidence capture, failed-node resume and an explicitly prepared bounded live Codex pilot. It does not provide a general host adapter, automatic repair or a general-purpose live execution surface. There is no new discovery-policy branch.

After resolving the package root, use `bun <resolved-package-root>/integrations/archon/lifecycle.ts install --dest <absolute-parent> --archon <absolute-native-executable>`. Installation creates `<absolute-parent>/archon-foundation` with its required local dependencies. Use that installed controller's `check` with the explicitly selected runtime; add `--verify --json` for fresh execution evidence and a candidate fragment scoped to the deterministic foundation. Plain checks cannot mark deterministic execution verified.

Incorporate those facts into the current task inventory with the remaining census observations. Existing packaged code is a configured candidate; do not call it absent to force installation. Keep native availability, deterministic verification and bounded live-pilot suitability separate. Read the packaged guide for repeat, relocation and failure behavior.
