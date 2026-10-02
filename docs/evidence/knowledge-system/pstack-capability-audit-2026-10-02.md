# Current P-stack capability audit

The merged checkout lacked `docs/pstack-audit/index.md`, which AGENTS.md requires before a P-stack execution-boundary change. [Open PR #118](https://github.com/randydinh/temari/pull/118) contains an older index, generator and graph alongside runtime and skill changes. Its inventory and program-ownership claims do not describe current merged main. This increment restores only the three audit artifacts and validates them against the current source; it does not merge PR #118's behavior changes.

The current bundled v4.1 tree contains 53 skills, including 23 principles and the Temari-owned `merge-reconciliation` entry, plus 24 Poteto playbooks. The public bundle contains five skill files: three policy entries and two supporting skills (QA verification and Temari Knowledge). The index and graph distinguish documented/current relationships from recommended ownership transfers. In particular, typed `programKind` routing, Temari program ownership of Orchestrate/Autopilot, retirement of the legacy Orchestrate store and Archon promotion remain proposals.

`python3 docs/pstack-audit/build_graph.py` ran twice from this checkout with byte-identical `graph.json` SHA-256 `282b6f177f966905e49c661c31a58d3e5a3da13fae8789ffb46d9994d3a79131`. The graph has 95 nodes and 215 edges. The generator checks inventory, edge endpoints/bases, local evidence/source files and local Markdown links. Independent review reproduced the graph and found no must-fix issue. This is a source catalog and navigation aid, not proof that a live program route, runtime scheduler, installer or host capability has passed.

The index passed scoped Prettier after formatting, graph regeneration retained the same hash, and `nx sync:check` reported the workspace up to date. No Registrar or runtime code changed in this documentation increment.

PR delivery and merged-head evidence will be recorded in the production decision trail.
