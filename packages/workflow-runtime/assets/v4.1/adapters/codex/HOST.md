# Codex host mapping

Read this before any upstream skill under `skills/`. Upstream is preserved source, not permission to override the owner or host policy.

| Upstream operation | Codex execution |
| --- | --- |
| Cursor Task / poteto-agent | Native Codex subagents when available and permitted. Inherit the current host model; do not pass Cursor model slugs or claim model diversity. Coordinator owns final review. |
| Slash skills (`/how`, `/why`, `/recall`, …) | Read the named file under `skills/<name>/SKILL.md` and its references. Never assume a slash command is registered in Codex. |
| Model-role setup (`/setup-pstack`) | Use host-supported role configuration only when requested. Default: inherit. No new credentials or global model changes. |
| control-cli / control-ui | Native shell for CLIs; browser/app tools for real UI. Unsupported surfaces stay explicit — never synthetic substitutes for claimed reproduction. |
| AskQuestion / todo list | Native Codex questions and task notes. Routine reversible decisions do not need repeated approval. |
| Integration discovery | Inventory callable and deferred tools first. For MCP servers, inspect resources/templates and `codex mcp list`; for apps/connectors, use their own tool inventory rather than MCP resource discovery. Inspect user and project Codex configuration, project-owned integration code, internal docs, official provider docs, and installed or recommended plugins. A registration outside this task is configured but not exposed. Use the current task identity when available, otherwise create one fresh run scope. An unsupported census surface is `unavailable`, not absent. |
| unslop / no-comments / technical-writing / deslop / skill-authoring | Read the packaged skill prose; use native document tools where available. |
| Pause / pickup / transcripts | Durable assignment + candidate-bound evidence in the selected workspace. Fresh receiver acknowledges completed vs pending work. |
| `/closeout` / archive current task | Run the packaged `closeout` skill. After every durability gate passes, call the Codex task archive operation for the current task. A blocked closeout stays open. |
| Opening a PR / shipping / external actions | Only within actual user authorization and host permissions. |
| arena / swarm / orch watchers / Benny / autopilot | Inspect dependencies first. Report missing Codex equivalents; do not pretend to execute Cursor APIs. |

## Install

From the `pstack/` directory:

```bash
./scripts/install-host.sh --host=codex --dest=/absolute/path/to/codex-skill-root
```

Or point a Codex personal plugin's `skills/` at `adapters/codex/skills/` and keep this package's `skills/` reachable via the relative paths in the entry skill.

## Entry skills

[`skills/temari/SKILL.md`](./skills/temari/SKILL.md) is the normal conversational entrypoint. [`skills/poteto-mode/SKILL.md`](./skills/poteto-mode/SKILL.md) remains the direct engineering entry. [`skills/closeout/SKILL.md`](./skills/closeout/SKILL.md) is the explicit durable task exit. All three require this `HOST.md` before their package-root skill.

For repository maintenance, `adapters/codex/skills/verify-temari/SKILL.md` is an optional discovery projection. It delegates to `verification/verify-temari/` and is installed only with `scripts/install-host.sh --include-verification`.
