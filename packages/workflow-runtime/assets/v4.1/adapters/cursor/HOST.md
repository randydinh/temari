# Cursor host mapping

Cursor is the native host. No remapping.

| Upstream operation | Cursor execution |
| --- | --- |
| Task / poteto-agent | Cursor Task subagents with configured models from `/setup-pstack` |
| Slash skills (`/temari`, `/how`, `/poteto-mode`, …) | Plugin-registered skills |
| `/closeout` / archive current task | Run the packaged `closeout` skill. If Cursor exposes no archive action, report `ready-to-archive` and leave the final archive action to the user. |
| AskQuestion / todos | Native Cursor tools |
| Integration discovery | Inventory current tools, MCP resources, Cursor MCP registrations, project and user configuration, project-owned integration code, internal docs, official provider docs, and installed marketplace capabilities. Record unsupported surfaces as `unavailable`. Use one fresh scope for the current task. |
| control-cli / control-ui | `cursor-team-kit` companion skills when installed |
| deslop | Packaged `deslop`; a compatible `cursor-team-kit` implementation may strengthen it |
| Multi-model panels (arena, interrogate) | Configured panel models |
| PR babysit / shipping | Native `gh` + playbooks |

Install the Temari plugin, then start with `/temari`. Run `/setup-pstack` when you want to configure supported model roles. See [Set up pstack](../../docs/guide/01-setup.md).
