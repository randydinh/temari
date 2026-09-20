---
name: skill-authoring
description: Create or revise portable agent skills whose triggers, instructions, resources, and checks must work without an unbundled authoring skill.
---

# Skill authoring

Inspect the existing skill and every caller before editing it. Define the requests that should trigger it and the nearby requests that should not.

Keep the entry file small. Put conditional detail in linked references and repeatable mechanics in scripts. Include a dependency only when it is packaged with the product or mapped by every supported host adapter.

Validate the finished skill:

1. Frontmatter contains a stable `name` and a discriminating `description`.
2. Every relative link and referenced resource resolves inside the package.
3. Host-specific operations pass through the host adapter.
4. A realistic request exercises the intended behavior rather than matching expected wording.

Preserve user authority and repository instructions. A skill may guide an operation but cannot grant permission for external side effects.
