---
name: poteto-mode
description: Use Poteto for software investigation, design, implementation, repair, review, and delivery, including small engineering requests. Compose needed evidence retrieval with the current Nx P-stack methods and admitted routes; research alone does not select an engineering profile.
---

# Poteto mode

Poteto mode supplies the engineering workflow selected by Temari.

Use Temari's [conversation guidance](../temari/references/conversation.md) when
reporting engineering progress or results. Keep the selected route's evidence,
completion requirements, and authorization boundaries intact.

A request to keep working while the user is away returns to Temari for an
overnight contract. For one substantive overnight task, suggest Figure-It-Out
to plan reviewable phases, then Autonomous Run; do not escalate it to
Orchestrate merely because it runs overnight. Queues and multi-day programs have separate routes.
This public entry admits only the routes named by `policy.json`; it does not
create an Orchestrate store or promote a program from a bounded request.

For ticket verification notes, QA evidence audits, and release QA reports requested
during verification or handoff, load the bundled
[QA verification skill](../qa-review-verification/SKILL.md). Default ordinary ticket
comments to its compact template, preserve the current request's ticket-selection
constraints, and derive conclusions from the candidate-bound evidence. Keep
canonical QA records, independent review requirements, and blocked or narrow
dispositions intact.
This supporting writer also handles evidence-only local drafts; it does not admit
QA execution or convert a document into a runtime receipt. Test-case authoring
alone, code review, and defect repair retain their existing owners.

For an unexplained failure or reported defect, use the bundled
[QA Triage skill](../qa-triage/SKILL.md) to establish symptom, expected behavior,
current mechanism and uncertainty before selecting a repair. Poteto owns repair
under the existing engineering authority and admission; triage supplies analysis,
not permission or proof of a fix. Keep full QA assignments and their evaluator
obligations open when using triage as a supporting step.

For an engineering request, including a direct Poteto invocation, decide its
evidence dependencies before substantial planning or dependent work. Use the
bundled [Knowledge skill](../temari-knowledge/SKILL.md) and shared
[evidence intake](../temari-knowledge/references/evidence-intake.md) when relevant
supplied or reusable evidence leaves material source dependencies unresolved.
Retain the decision and observed operations in existing local task context.
Evidence retrieval supports the selected engineering method; it does not admit
a profile or satisfy its verification and closeout obligations.

For work on an existing codebase, read the installed policy, then apply
[Temari's codebase intake](../temari/SKILL.md) within the admitted source scope
before broad investigation. Registrar and graph results guide source selection;
current candidate code and requirements establish behavior. Keep missing, stale
or disabled-provider gaps explicit and use only permitted bounded fallbacks.

1. Read `policy.json` from the installed bundle root. Follow Temari's route-visibility preference: briefly name the selected route when the user opted in; otherwise describe the next action in plain language.
2. Admit the pinned `lightweight-engineering-v1` mapping only when every source route condition is true. A trusted `full-playbook`/`feature-v1` start requires host proof from a read-only architect, scoped builder, independent reviewer, and forge access. Preserve all six canonical stages.
3. The source final, commit, and review boundaries include every requirement for the selected profile. Feature delivery requires an open pull request at the verified integration commit. Publish requires separate operator approval. A PASS receipt does not grant it.
4. For feature worker execution, use the selected host adapter to collect independent architect, builder, and reviewer evidence. Full QA uses the Temari QA route's packaged separate evaluator and canonical local evidence store; it remains read-only for external systems.
5. Keep one lifecycle owner: the canonical runtime/store owns scheduling, persistence, recovery, and evidence. This skill only routes and admits work.

Use `bin/poteto-mode.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. A blocked result stays blocked until its missing proof exists.

When Temari has selected a durable engineering task, use its
[task tracking contract](../temari/references/task-tracking.md) with public
`start` or `resume`. Preserve the same task through recovery; task handoffs remain
context pending trusted closeout.

For a confirmed systemic discrepancy, Temari selects the obligation and existing
task authority; Poteto supplies the bounded repair method. Preserve the actual
counterexample, change the smallest durable source within the admitted typed
ownership, obtain independent review of the exact integration commit, build a
fresh installed artifact, and rerun that failing case plus neighboring checks.
Use Temari's installed `repair start/status/accept` support operation under the
same logical task. Continue compatible parent work after actual worker start;
do not rebind its current run, create another user chat or treat supervisor
heartbeat as worker proof. The existing runtime child store owns attempts and
leases. Uncertain launch stays uncertain across restart or lease expiry, with no
replacement process. PASS awaits coordinator review and reopened artifact,
candidate and regression evidence; it does not resolve the obligation by itself.
Recheck preserved counterexample and assertion/helper byte identities on every
resolution read. Freeze the admitted candidate so compatible parent source
progress cannot dirty the child. Only explicit `repair readmit` may admit an
unchanged, never-launched BLOCKED report after its missing authority is proven;
retain the refusal history and compare the current task version.
