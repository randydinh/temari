---
name: poteto-mode
description: Use pstack engineering workflows on a generic agent harness when the user asks for pstack or poteto-mode.
---

# pstack on a generic host

1. Resolve the package root from three levels above this file under `adapters/generic/skills/poteto-mode`, or from the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/generic/HOST.md` from the package root.
3. Read package-root `skills/poteto-mode/SKILL.md`. Pick the lightweight route or one matching full playbook; inspect dependencies before selecting an unverified heavy route.
4. Apply the host mapping to every upstream instruction. Do not invent Cursor APIs.
