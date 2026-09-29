<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

## Local Codex parallel batches

At the Temari/poteto throughput checkpoint, prepare an existing read-only or write request JSON for an independent, homogeneous batch. From the workspace root, invoke the router with one positional request path:

```sh
node --import @swc-node/register/esm-register tools/run-codex-parallel.mts /absolute/path/to/request.json
```

Give write implementers disjoint typed scopes, a clean pinned base, and combined verification. The router selects by assignment structure, rejects mixed batches, and returns the selected route and receipt. Review the receipt and integration checkout before accepting work. The installed public plugin also bundles `bin/codex-parallel.mjs`; follow its Poteto Mode parallel worker guide for the installed invocation. A local worker receipt does not prove host `subagents` or `forge` capabilities for full-feature admission.
