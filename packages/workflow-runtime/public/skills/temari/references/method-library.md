# Bundled engineering method

The installed plugin carries the portable P-stack method at `method/pstack/`.
Its [catalog](../../../method/pstack/catalog.json) indexes the available skills,
principles, playbooks, agents and host mappings. Those files are internal method
resources; the plugin discovers only the public skills under its root `skills/`.

## Load the method for the selected work

1. Read the installed `policy.json` and establish the task's source scope and
   current candidate. Temari selects intent, obligations and supported admission.
2. Read the selected host mapping before applying method prose. For Codex, use
   the bundled [host mapping](../../../method/pstack/adapters/codex/HOST.md) and
   the public [worker guide](../../../adapters/codex/parallel-workers.md).
3. Read the internal [Poteto method](../../../method/pstack/skills/poteto-mode/SKILL.md)
   and the matched playbook. The public engineering profiles use
   [Lightweight engineering](../../../method/pstack/skills/poteto-mode/playbooks/lightweight-engineering.md)
   or [Feature](../../../method/pstack/skills/poteto-mode/playbooks/feature.md).
   The runtime retains its existing pinned `source/` projections and six stages.
4. Load supporting skills when a playbook step needs them. For example,
   [How](../../../method/pstack/skills/how/SKILL.md) supplies subsystem understanding
   and [Architect](../../../method/pstack/skills/architect/SKILL.md) supplies design.
   Use the catalog to find the other helpers; do not load every skill at intake.
5. Read the relevant principle leaf before applying it. For example,
   [Model the Domain](../../../method/pstack/skills/principle-model-the-domain/SKILL.md)
   shapes the implementation and
   [Prove It Works](../../../method/pstack/skills/principle-prove-it-works/SKILL.md)
   shapes verification. Principles influence decisions across playbook steps.
6. Retain candidate-bound evidence through the canonical runtime. Finish through
   the public [Closeout](../../closeout/SKILL.md) contract when its trusted inputs
   and completion obligations exist.

## Preserve the public contract

The library is available for method guidance. A catalog entry does not admit a
workflow, prove a host capability, grant external authority or establish a pass.
For unsupported routes, preserve the useful analysis or plan and state the
execution gap. Check `policy.json` rather than inferring support from a file.

Public policy, current host permissions, task authority and canonical runtime
contracts govern application of the method. Map Cursor model roles and slash
references through the host mapping; in Codex, a named internal skill means
reading its file, not invoking a registered slash command. Inherit the host model
unless the user selected another supported configuration.

The preserved tree includes historical adapter entries, installation helpers,
verification recipes, workflow commands and Orchestrate storage. They remain
reference material. Do not use them to start a second lifecycle, install into the
plugin, bypass public admission or replace canonical evidence and closeout.
Optional native runtimes and external companion tools remain separate host
dependencies. Dependencies, task state and execution evidence belong outside
the immutable plugin. The catalog records unresolved host or historical needs.
