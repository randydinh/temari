---
name: closeout
description: Persist and verify the current Codex task before archiving it. Applies the Codex host mapping, then the provider-neutral closeout skill.
---

# Closeout on Codex

1. Resolve the package root from the first valid location: `../../package` in the Codex plugin bundle; three levels above `adapters/codex/skills/closeout` in a source checkout; or the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/codex/HOST.md` from that package root.
3. Read `skills/closeout/SKILL.md` from that package root and apply the host mapping to the whole closeout.
