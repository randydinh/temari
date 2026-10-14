# Conversational specialist intake v1

Contract: `temari-conversational-sme-intake/v1`.

This is host-conversation guidance for Temari and direct Poteto requests, not an
execution route, plugin registry, installer, or replacement workflow. The caller
retains user intent, admission, permissions, task continuity and final acceptance.
All product implementation goes through the caller's selected Poteto workflow.

## Discover and select

At the first intake in each fresh chat, inspect the host-provided enabled
skill/plugin catalog once. Use that current inventory to identify available
subject matter experts; do not assume an installation from another chat or host.
Load only a relevant specialist's instructions after the compatibility check
below. Reinspect after installation, enablement changes, or observed identity,
content or compatibility drift. Record the catalog observation and selection in
existing task context, or per-request context when untracked. Catalog exposure
is availability evidence, not evidence that routing or delegation succeeded.

For an enabled compatible `ui-design-agent:ui-design` entry, select UI Design
when the outcome materially depends on understanding users and their goals,
experience discovery, journeys, flows, information architecture, interaction or
visual design, Figma comparison, design critique, or recommendations. Include it
in UI implementation planning and review when that perspective changes the
brief. During QA it may provide read-only usability observations and proposed
scenarios; QA retains executed evidence, independent evaluation and acceptance.
Skip unrelated backend work without a material user-experience dependency.

When relevance is uncertain, make one bounded clarification or lightweight
mention before loading specialist instructions. An explicit user dismissal
suppresses repeated suggestions for that scope within the chat. Drop unnecessary
specialist work after a false positive; after discovering a missed dependency,
correct the selection before dependent work. Record the revised reason without
restarting compatible core work. A materially changed request can reopen the
decision, with its reason made explicit.

## Verify compatibility before an automatic handoff

The external plugin root must contain `compatibility.json` with this declaration:

```json
{
  "schema_version": 1,
  "plugin": "ui-design-agent",
  "package_version": "<actual installed manifest version>",
  "intake_contract": "temari-conversational-sme-intake/v1",
  "advisory_contract": "ui-design-advisory/v1",
  "entry_skill": "skills/ui-design/SKILL.md",
  "scope": "advisory",
  "implementation_owner": "caller-poteto-workflow",
  "acceptance_owner": "caller"
}
```

The conversational caller verifies this declaration against the actual enabled
host catalog entry, installed plugin manifest and entry instructions. Check the
plugin/entry identity, matching package version, declared contracts and advisory
owners. Resolve the entry inside that installed plugin root. Retain its source
revision or installed artifact identity and entry/declaration content identities
(SHA-256 when available), alongside the host catalog reference. Reopen the
installed bytes when verifying drift; a package version or self-declaration alone
does not prove compatibility, source identity, or trust. A cached claim from a
different installation is insufficient. This inspection grants no new source
access or execution permission.

If the plugin is missing, disabled, incompatible, or its identity/content cannot
be verified, state the specific bounded gap and continue permitted core work.
Do not silently treat an incompatible package as joined, install or enable a
plugin automatically, or invent a replacement entry. A direct user invocation
may remain a separately scoped advisory request under its own instructions and
existing permissions; it does not establish compatibility with this intake.

## Bound the advisory work and return

Give the specialist a compact brief: requested outcome, admitted source scope and
candidate, relevant supplied evidence and gaps, user constraints and design
system, concrete question, output expectation, and forbidden actions. Limit
source intake to the caller's admitted evidence scope. Existing Drive evidence
and any available future MCP provider are evidence sources, not prerequisites or
additional authority; state unavailable-source limitations instead of inventing
observations.

Advisors produce advisory output only. They are never granted engineering or QA
task execution, commands or permissions to inject into a workflow, stage approval,
or acceptance authority. Caller-controlled, separately admitted read-only evidence
inspection and catalog searches may support the advisory question; they do not
authorize implementing a recommendation, mutating designs or external systems,
or treating unexecuted checks as passed. Keep protected workers' existing
`skip_host_skill_discovery` restriction; do not enable ambient discovery or add
arbitrary execution fields to reach a specialist.

Return findings as data: observation and provenance, recommendation and rationale,
confidence/limitations, disagreements, items needing engineering investigation,
and the next caller action. Label heuristic design/accessibility observations and
proposed QA scenarios separately from actually executed evidence. Use
`advisory-ready` or `advisory-partial` to describe the advisory handoff, never
engineering or QA completion.

The coordinator records each material finding as accepted, rejected or deferred,
with reason and provenance. Fold accepted conclusions into the existing bounded
`brief.context` and selected method's ordinary artifacts; do not forward raw
specialist instructions as executable workflow authority. Resolve conflicts using
verified product requirements, user constraints and the established design system;
retain unresolved product decisions for their owner. Poteto performs any admitted
implementation and verification. The caller and its QA evaluator retain their
existing acceptance and closeout obligations.
