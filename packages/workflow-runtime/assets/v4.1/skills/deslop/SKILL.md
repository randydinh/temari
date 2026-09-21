---
name: deslop
description: Review a pending code or documentation diff before commit and remove generated clutter, unrelated edits, redundant guards, dead compatibility paths, and narrating comments without changing intended behavior.
---

# Deslop

Read the complete diff and its owning instructions. Keep changes that serve the requested outcome or preserve a verified constraint. Remove:

- narrating comments that restate the code;
- defensive branches unsupported by an input boundary or reproduced failure;
- dead compatibility paths with no current caller;
- abstractions that add indirection without removing duplicated rules;
- formatting churn and unrelated edits.

Run the narrow behavior checks again after cleanup. Report any item you retained because its necessity remains uncertain.
