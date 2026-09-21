---
name: temari
description: Use Temari as the conversational engineering entry point on a generic agent host. Applies the generic host mapping, then the provider-neutral Temari skill.
---

# Temari on a generic host

1. Resolve the package root from three levels above this file under `adapters/generic/skills/temari`, or from the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/generic/HOST.md` from the package root.
3. Read package-root `skills/temari/SKILL.md` and apply the host mapping to all routed work.
4. When Temari routes engineering work to poteto-mode, let poteto-mode classify lightweight versus full playbook and keep host capability gaps explicit.
