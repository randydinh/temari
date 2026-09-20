---
name: verify-temari
description: Use the repository-owned Temari verification skill from a generic host.
---

# Verify Temari from a generic host

Resolve the package root from the host skill root's `pstack-root` pointer first. Then read `<package-root>/adapters/generic/HOST.md` and `<package-root>/verification/verify-temari/SKILL.md`. In a source checkout, the package root is the repository root. In a copied install, `pstack-root` points to `.temari-package`. The canonical verifier owns the feature map, control CLI, evidence path, and cleanup rules. This file only makes that verifier discoverable to the host.
