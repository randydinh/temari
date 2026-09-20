---
name: closeout
description: Persist and verify the current agent task before declaring it ready to archive. Applies the generic host mapping, then the provider-neutral closeout skill.
---

# Closeout on a generic host

1. Resolve the package root from three levels above this file under `adapters/generic/skills/closeout`, or from the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/generic/HOST.md` from the package root.
3. Read package-root `skills/closeout/SKILL.md` and apply the host mapping to the whole closeout.
