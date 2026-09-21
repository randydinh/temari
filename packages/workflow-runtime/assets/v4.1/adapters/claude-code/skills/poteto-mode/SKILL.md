---
name: poteto-mode
description: Use pstack engineering workflows on Claude Code when the user asks for pstack, poteto-mode, or a rigorous engineering task.
---

# pstack on Claude Code

1. Resolve the package root from three levels above this file under `adapters/claude-code/skills/poteto-mode`, or from the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read the Codex-style host mapping at `adapters/claude-code/HOST.md` (package-relative) and apply it to every upstream read.
3. Read `skills/poteto-mode/SKILL.md` from the package root. Select only the matching playbook and required leaf skills.
4. Announce the route. Lightweight engineering runs serially; inspect dependencies before selecting an unverified heavy route.
5. Gaps for Cursor-only facilities are explicit; do not invent Task/AskQuestion APIs.
