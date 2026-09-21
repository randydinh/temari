# Claude Code host mapping

Read this before any upstream skill under `skills/`.

| Upstream operation | Claude Code execution |
| --- | --- |
| Cursor Task / poteto-agent | Claude Code subagents / parallel tasks when available. Inherit the session model; do not pass Cursor model slugs. Coordinator owns final review. |
| Slash skills | Read `skills/<name>/SKILL.md`. Claude Code may register skills from a skills directory; do not assume Cursor slash names. |
| Model-role setup | Skip `/setup-pstack` model writing unless the user asks for a Claude-side equivalent. Default inherit. |
| control-cli / control-ui | Bash for CLIs; Claude Code browser tools when present. Never fake a UI for claimed reproduction. |
| AskQuestion / todos | Native clarifying questions and task tracking. |
| Integration discovery | Inventory the current tool surface, MCP resources, Claude MCP registrations, project and user configuration, project-owned integration code, internal docs, official provider docs, and available plugins. Record unsupported surfaces as `unavailable`. Use the current task identity when exposed, otherwise one fresh run scope. |
| unslop / no-comments / technical-writing | Read packaged skills. |
| deslop / skill-authoring | Use the packaged skills. A compatible host-native tool may strengthen them. |
| Pause / pickup | Write a short assignment + pending action in the project; resume by re-reading it. |
| `/closeout` / archive current task | Run the packaged `closeout` skill. If no archive API exists, report `ready-to-archive` and leave the final archive action to the user. |
| PR / shipping / external actions | Only with explicit user authorization. |
| arena / swarm / orch / Benny / autopilot | Report missing multi-model or Cursor automation deps before running. |

## Install

```bash
# project-local (typical)
./scripts/install-host.sh --host=claude-code --dest=/absolute/path/to/project/.claude/skills

# or user-global skills root, if you use one
./scripts/install-host.sh --host=claude-code --dest=/absolute/path/to/claude-skills
```

The installer symlinks or copies the thin `temari`, `poteto-mode`, and `closeout` entries plus a `pstack-root` pointer file so package skills resolve. Prefer symlink when the destination filesystem allows.

## Entry

After install, invoke `temari` for conversational guidance, `poteto-mode` for a direct engineering workflow, or `closeout` for the durable task exit. All three must read this `HOST.md` first.

For repository maintenance, `adapters/claude-code/skills/verify-temari/SKILL.md` is an optional discovery projection. It delegates to `verification/verify-temari/` and is installed only with `scripts/install-host.sh --include-verification`.
