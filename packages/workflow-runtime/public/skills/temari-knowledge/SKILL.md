---
name: temari-knowledge
description: Use the bundled Temari knowledge and Content Registrar capability for explicitly scoped source intake, search, queries, and archive jobs. Use when the user asks to set up or inspect this installed capability, or when an admitted task needs source-backed knowledge retrieval.
---

# Temari Knowledge

This skill exposes a knowledge capability beside Temari's three public workflow
entries. It does not admit an engineering or QA route, decide a disposition, or
expand the current task's authority. Use `bin/temari-knowledge.mjs` from the
installed plugin root. The launcher uses the compiled `@temari/knowledge` CLI
inside the verified artifact and the pinned, bundled Python Content Registrar.

## Set up the local provider

Run `node bin/temari-knowledge.mjs status` to inspect the local installation.
Run `node bin/temari-knowledge.mjs setup` to build a wheel from the bundled
Registrar source and install it in a user-local Python 3.12 virtual environment.
The default home is `~/.local/share/temari-knowledge`; use `--home ABS` to choose
another location. Setup creates an empty Registrar workspace there. It does not
register or scan a source. It needs Python 3.12 and Python package download
access on a cold machine. The bundled project pins direct dependencies, while
pip resolves transitive dependencies at setup. It needs no private GitHub
access or separate Registrar checkout.

On Windows, run this setup in WSL2; native Windows setup is unsupported. If
Codex itself runs on Windows, `setup --connect-codex` inside WSL2 would connect
the WSL2 Codex configuration. Instead, run `setup` in WSL2 and explicitly add
a Windows Codex MCP entry that launches the WSL2 Python server. From PowerShell,
use this pattern with your actual distribution and Linux user:

```powershell
codex mcp add temari-content-registrar -- wsl.exe -d Ubuntu -- /home/YOUR_LINUX_USER/.local/share/temari-knowledge/venv/bin/python -m knowledge_agent.cli mcp serve --workspace /home/YOUR_LINUX_USER/.local/share/temari-knowledge/workspace
```

To add its stdio MCP connection to Codex, explicitly run
`node bin/temari-knowledge.mjs setup --connect-codex` or
`node bin/temari-knowledge.mjs connect-codex`. An existing server entry is
preserved and reported rather than replaced. Use `--workspace ABS` to connect
an existing external Registrar workspace. The workspace, source registry,
archives, credentials, and task artifacts stay outside the plugin. Uninstalling
or replacing the plugin does not remove them. Source deletion or purge is a
separate operator action.

To disconnect only the Codex MCP entry, run
`node bin/temari-knowledge.mjs disconnect-codex`. Use the same `--home ABS` and
`--workspace ABS` values used to connect it; `--codex CODEX` selects a different
Codex executable. The command checks the exact `temari-content-registrar`
stdio entry twice before removing it by name and reports an already absent
entry as success. It refuses a modified entry or an uncertain Codex response. It leaves
the virtual environment, Registrar workspace, sources, and archives in place.
Run `connect-codex` to reconnect after checking the local installation. Codex
can change its entry between the final check and removal; a changed entry in
that gap may still be removed because the CLI cannot make that operation atomic.

## Use source-backed context

Select a source scope and a bounded question before invoking intake, search, or
query. The compiled CLI accepts explicit JSON plans:

```text
node bin/temari-knowledge.mjs journey-intake --input /absolute/intake-plan.json
node bin/temari-knowledge.mjs journey-search --input /absolute/search-plan.json
node bin/temari-knowledge.mjs journey-query --input /absolute/query.json
node bin/temari-knowledge.mjs journey-jobs-create --input /absolute/jobs-plan.json
node bin/temari-knowledge.mjs journey-jobs-tick --spec /absolute/job-spec.json
node bin/temari-knowledge.mjs archive-collect --input /absolute/retrieval.json
```

Use `--help` on the compiled CLI through this launcher for the complete command
list. Keep plan, state, and output paths outside the immutable plugin artifact.
Registrar citations and graph links guide inspection; verify material claims
against current source and candidate state. Report missing or stale coverage.
Local Registrar read/search needs no TypeSafe key. Any hosted Jev call remains
conditional on its configured credential and source-sharing policy. Do not
silently substitute another provider or widen source access.
