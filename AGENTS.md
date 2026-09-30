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

## Task continuity

Read [docs/task-continuity.md](docs/task-continuity.md) when starting or resuming
tracked work. List the configured local task store, reuse a matching logical task,
and retain a next action or blocker before handing off. Use a new run binding for
a new candidate; preserve prior run history. A missing/corrupt store is a visible
recovery issue. Native success alone does not satisfy Temari closeout, and the
local inbox's acceptance command does not verify full feature/forge obligations.

## Local Codex parallel batches

At the Temari/poteto throughput checkpoint, prepare an existing read-only or write request JSON for an independent, homogeneous batch. From the workspace root, invoke the router with one positional request path:

```sh
node --import @swc-node/register/esm-register tools/run-codex-parallel.mts /absolute/path/to/request.json
```

Give write implementers disjoint typed scopes, a clean pinned base, and combined verification. The router selects by assignment structure, rejects mixed batches, and returns the selected route and receipt. Review the receipt and integration checkout before accepting work. The installed public plugin also bundles `bin/codex-parallel.mjs`; follow its Poteto Mode parallel worker guide for the installed invocation. A local worker receipt does not prove host `subagents` or `forge` capabilities for full-feature admission.

## Private QA preferences

For Temari QA workflow changes, read `docs/decisions/2026-09-29-qa-review.md`.
For OpConnect QA work in this checkout, read
`$HOME/.temari/overlays/opconnect-qa-preferences.md` when present after policy and
source-scope admission. It is a private host preference record, not an execution
permission or a product-behavior oracle. If it is absent, use the public QA
contract and record the missing project context.
