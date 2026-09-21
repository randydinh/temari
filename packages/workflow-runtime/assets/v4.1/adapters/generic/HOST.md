# Generic host mapping

For harnesses without a dedicated adapter (plain skill folders, AGENTS.md-driven agents, etc.).

| Upstream operation | Generic execution |
| --- | --- |
| Cursor Task / poteto-agent | Whatever parallel worker facility the host exposes. If none, run serially. Inherit one model. |
| Slash skills | Read `skills/<name>/SKILL.md` by path. |
| Model-role setup | Skip unless the host has an equivalent config. |
| control-cli / control-ui | Shell + whatever UI tools exist. State unsupported surfaces. |
| AskQuestion / todos | Host-native prompts and a markdown checklist if needed. |
| Integration discovery | Inventory the host's callable tools, MCP resources and registrations, project configuration and integration code, internal and official provider docs, and connector catalog through supported facilities. Record a surface the host cannot inspect as `unavailable`; never convert missing host capability into evidence that no integration exists. Use one fresh scope for the current task. |
| Companion Cursor plugins | Assume absent. |
| Pause / pickup | Assignment file in the workspace. |
| `/closeout` / archive current task | Run the packaged `closeout` skill. If no archive API exists, report `ready-to-archive` and leave the final archive action to the user. |
| External actions | Explicit user authorization only. |
| Heavy routes (arena, swarm, orch, Benny, shipping) | Report missing capabilities; use Feature / investigation / bug-fix only until proven. |

## Install

```bash
./scripts/install-host.sh --host=generic --dest=/absolute/path/to/skill-root
```

Optionally add to the project's `AGENTS.md`:

```markdown
## Temari
When the user asks Temari for help, read `<temari>/adapters/generic/HOST.md`
then `<temari>/skills/temari/SKILL.md`. For direct rigorous engineering work,
read the same host mapping then `<temari>/skills/poteto-mode/SKILL.md`.
For a durable task exit, read the same host mapping then
`<temari>/skills/closeout/SKILL.md`.
```

Replace `<temari>` with the absolute package path.

For repository maintenance, `adapters/generic/skills/verify-temari/SKILL.md` is an optional discovery projection. It delegates to `verification/verify-temari/` and is installed only with `scripts/install-host.sh --include-verification`.
