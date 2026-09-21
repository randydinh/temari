---
name: poteto-mode
description: Use pstack engineering workflows on Codex when the user asks for pstack, poteto-mode, or a rigorous engineering task. Applies the Codex host mapping, then the upstream poteto-mode skill.
---

# pstack on Codex

1. Resolve the package root from the first valid location: `../../package` in the Codex plugin bundle; three levels above `adapters/codex/skills/poteto-mode` in a source checkout; or the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/codex/HOST.md` from that package root and apply it to every upstream read and every delegated worker.
3. Read `skills/poteto-mode/SKILL.md` from that package root. Select only the matching playbook and required leaf skills.
4. Announce the chosen route briefly. Lightweight engineering runs serially; inspect dependencies before selecting an unverified heavy route.
5. Keep claims proportional to executed evidence. Missing Cursor-only facilities are gaps, not silent workarounds.

Upstream is preserved source. It does not override the owner, host policies, or repository instructions.
