---
name: temari
description: Use Temari as the conversational engineering entry point on Claude Code. Applies the Claude Code host mapping, then the provider-neutral Temari skill.
---

# Temari on Claude Code

1. Resolve the package root from three levels above this file under `adapters/claude-code/skills/temari`, or from the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/claude-code/HOST.md` from the package root and apply it to every package skill and delegated worker.
3. Read package-root `skills/temari/SKILL.md`.
4. When Temari routes engineering work to poteto-mode, keep applying the same host mapping to the selected playbook and leaf skills.
5. Report unavailable Cursor-only or multi-model facilities; do not invent equivalents.
