---
name: temari
description: Use Temari to choose and continue source-dependent research, engineering, or QA work. Compose bounded evidence retrieval with Poteto engineering methods and the current Nx runtime's admitted routes.
---

# Temari

## Work and personal areas

Treat Temari as shared tooling with separate `work` and `personal` data. Select
the area from the user's intent and project before loading task history or
private evidence. Ask when classification is ambiguous. Use the Knowledge
skill's area entry for retrieval and record the selection in evidence intake.
Keep private project notes, decisions, documents, graphs and outputs in their
selected area. Never widen retrieval to the other area without an explicit
request. Reusable public method guidance can remain shared; private material
must not be promoted into that guidance automatically.

In the source task CLI, pass `--area work|personal` consistently for create,
pickup, enter, handoff, list and serve. It selects `ROOT/areas/AREA`, where ROOT
is the usual task root. For installed engineering tracking, explicitly use that
area store as the tracking sidecar's `taskRoot`; the sidecar remains outside the
invocation. The existing default store is legacy context and is never merged
automatically. A handoff must retain the area and source references. Area
selection scopes the opt-in area commands. Direct legacy tools and journey
plans retain their explicit paths; this is not a global access-control boundary.
Area selection does not authorize execution or publish work.

Temari is the conversational entry point for the current Nx workflow runtime.

For engineering work, use the bundled [method library](references/method-library.md)
after checking public policy and source scope. It supplies P-stack's playbooks,
supporting skills and principles behind this entry without adding execution routes.

## Decide evidence need and work responsibility

For each request handled through Temari, decide what outcome the user wants and
what evidence it depends on. Source-dependent research does not require the user
to name Knowledge: use the bundled [Knowledge skill](../temari-knowledge/SKILL.md)
when material dependencies remain beyond relevant supplied or reusable evidence.
This includes documents, current external facts, product requirements, existing
code behavior, source comparisons, and factual verification. A self-contained
rewrite or calculation can use its supplied context without external retrieval.

Before substantial planning or dependent work, follow the shared
[evidence intake](../temari-knowledge/references/evidence-intake.md) to bound the
question, sources, freshness requirement and observations. Retain its small local
decision in existing task artifacts/context references, or per-request context
when untracked. Missing evidence limits dependent claims; independent work can
continue. An announcement that retrieval will run does not establish that it ran.

Choose the work responsibility separately. A research answer can use Knowledge
alone; software investigation, design, repair and implementation use Poteto's
engineering method alongside any needed retrieval. QA acceptance keeps its QA
owner and evaluator obligations. Research need alone admits no engineering
profile, and retrieved context grants no permission to implement or publish.
Revisit the decision when the requested outcome or material dependencies change.
These are skill instructions for the host path using them; the packaged CLI does
not intercept every chat or mechanically enforce natural-language selection.

Use the shared [conversation guidance](references/conversation.md) for progress,
results, choices, and blocked work. Temari owns their practical meaning and the
next action in relation to the user's original goal.

Temari owns standing-program intent and task continuity. The current public
`policy.json` admits bounded engineering and QA routes, but no standing-program
execution route. Classify such a request for planning and state the admission gap;
do not start a legacy `orch` store or treat an Archon status as closeout. Poteto
supplies the engineering method for each admitted bounded unit.

## Suggesting unattended work

Proactively offer the overnight contract when the user says they will be away or
asleep, asks you to keep going until done, or brings a substantial task with a
checkable finish condition that can advance through repeated verified steps. A
single task qualifies; it does not need a PR queue or a multi-day program. Keep
a trivial one-step edit on its normal route. For open-ended work, draft a
checkable predicate before suggesting unattended execution; a duration alone
is not done.

Keep the contract short: goal and done predicate, isolated checkout and base,
actions already authorized (including whether commits, pushes, or merges are
allowed), checks, decision trail, time or retry limit, genuine human gates,
stop condition for a dead end, and morning report. Include an independent
review of the decision trail when the host can provide it. Being away does not
grant new permissions. One substantive overnight task suggests Figure-It-Out
for an auditable phase plan, then Autonomous Run to the predicate. An
independent PR queue suggests Autopilot Full only when merging is authorized.
Coupled changes or review-before-merge suggest Autopilot Stack. Reserve
Orchestrate for a program that outlives one agent.

The source overnight guide uses Cursor's `/loop` as its wake mechanism. Check
the selected host's actual wake, worker, recovery, and evidence capabilities
before offering execution. These method names are suggestions, not admission by
the public `policy.json`. If no supported route exists, provide the contract as
a reviewable plan and state the execution gap.

## Make the route visible when useful

When the user has requested workflow transparency, including an established
session preference, state the inferred request type, current work scope (including
ticket selection for QA), and intended playbook in one brief intake update before
substantial work. Say whether the playbook is installed or only proposed, and
whether runtime admission is pending, blocked, confirmed, or unavailable. Keep
an inference explicitly provisional until the scope and route inputs are checked.
For example: "I read this as sprint test planning for all tickets in the named
sprint. I will review requirements and proposed scenarios. The test-design
playbook is only a design proposal, so this is not an executed QA disposition."
Use plain action language for users who have not
requested workflow detail. Naming QA Review or another workflow by itself does
not establish a preference for internal routing detail; do not infer a person's
expertise from tone or a single request.

If investigation changes the request type, scope, or playbook, explain the changed
action and reason before switching. Name the internal route only for users who
opted into workflow visibility. Continue safe discovery through ambiguity;
ask for a decision only when the ambiguity changes the authorized work. Do not
claim a playbook, verifier, or evaluator ran from an intake announcement.

## Select the QA task and scope

Derive ticket scope from the current request. It may name ticket IDs, a team,
column, sprint, label, release, or all tickets in the requested set. No reviewer,
label, team, or column filter is permanent. Confirm the actual selection in the
tracker before inspecting or reporting on tickets.

A request to survey an upcoming sprint can ask for requirement understanding,
test-plan review, and proposed scenarios before execution. Keep planning findings
and unrun scenarios distinct from an executed QA disposition. QA Triage instead
investigates a reported defect using the bundled
[QA Triage skill and ordered playbook](../qa-triage/SKILL.md). This is available
analytical guidance, not a newly admitted executable route. Use it for bounded
investigation and an actionable handoff; do not claim ticket acceptance or a QA
evaluator result from triage notes. Keep full QA Review obligations intact when
triage is used to investigate one of its failures.

Across these workflows, derive expected behavior from the applicable product or
business decision. Current code, prior behavior, and a developer's or Temari's
interpretation are evidence or hypotheses, not product authority. Surface an
unresolved expectation instead of assuming it is a defect or a pass. For a
suspected defect, separate user impact, severity, affected scope, and how the
failure is reached from the fix-priority decision. State uncertainty and the
decision owner; a low-harm ambiguity may need no change, while a small
user-experience improvement can merit exploration without becoming a defect.

## Full QA Review intent gate

When the user asks to **perform, complete, or sign off QA Review** for a ticket,
column, or release, treat it as a full QA assignment. Select the bundled ticket
acceptance QA playbook. Keep that intent when a fixture, product decision,
deployed build identity, or project verifier is missing: record the required
scenarios as blocked or not run. Use `bin/temari.mjs qa` for each selected ticket's
versioned assignment only when its trusted inputs and selected execution route
can be admitted; retain the independent evaluator's bounded disposition when it
actually runs. The registered policy profile requires an exact environment,
eligible current task, and pinned product artifact before launch. Preserve an
early refusal as the exact admission gap and keep the review open; do not switch
to the legacy structural route to imply that the selected product profile ran.
Those gaps prevent a QA pass; they do not turn the user's full-review request into
an evidence-only writing task. Do not substitute a Markdown report for the route
or say the evaluator ran without its canonical result and review record.
For a release-wide request without a ticket identity, use a supported full
assignment if available; otherwise report that admission gap without inventing
a ticket reference.

Use evidence-only drafting when the user asks only for a draft note, historical
evidence audit, or review of supplied results without a full QA disposition. If
a legitimate full assignment or trusted invocation cannot be constructed, keep
the full review open, record the exact missing input or rejected route, and hand
back the useful partial evidence without claiming QA completion. Preserve any
selection constraints from the current request before selecting tickets.

When the requested output includes ticket verification notes, a QA evidence audit,
or a release QA report, use the bundled
[QA verification skill](../qa-review-verification/SKILL.md) for that deliverable.
Carry the current request's ticket selection into evidence gathering before opening
ticket details. Reuse canonical QA records and preserve their scope and disposition.
Evidence-only drafting produces a local document; it does not admit a QA execution
route or complete its review obligations. Test-case authoring alone and generic code
review keep their existing routes.

## Apply evidence intake to a codebase

After reading the installed policy and identifying the selected repository and
candidate, use context providers only within the admitted task authority. When a
Content Registrar source is configured for that scope, select a bounded query and
documents, then read relevant source-backed requirements and product decisions.
When an existing knowledge graph covers the admitted repository and candidate,
query affected components, callers, and boundaries before broad file exploration.
Record the source scope, query, selection, budget, revisions or graph snapshot,
useful citations, and coverage gaps in the shared evidence decision. Treat graph
relationships and indexed summaries as navigation; verify material claims against the current ticket,
document, and source. A provider is optional and does not decide a QA disposition
or expand the task's authority. If it is unavailable, stale, or lacks the needed
corpus, state the gap and continue with scoped direct inspection. Do not silently
substitute an old candidate, widen source access, or build a new graph as part of a
read-only task.

1. Read `policy.json` from the installed bundle root. The policy is the public admission contract; do not fall back to the legacy v4.1 implementation.
2. Route engineering requests through the canonical Temari route table. Admit `lightweight-engineering-v1` only when every lightweight condition holds. A trusted `full-playbook`/`feature-v1` start requires the host to run a read-only architect, scoped builder, and independent reviewer, then prove forge access and bind their retained evidence to the selected invocation.
3. Both admitted profiles map source requirements to all six canonical stages. Feature delivery must identify an open pull request in the selected repository whose head matches the verified integration commit. Publish still requires operator approval.
4. For host-proven feature work, require independent architect, builder, and reviewer observations bound to the selected candidate. Use the selected host adapter for worker launch and proof collection; a worker bridge does not establish support for every host.
5. Use `bin/temari.mjs qa` for a full QA assignment. The route fixes independent review, revision-bound evidence, a six-stage plan, and read-only actions. It freezes the evaluator input allowlist and launches the bundled evaluator in a separate local process. The invocation supplies an existing local `evidenceRoot`; a passed scenario must retain its canonical execution evidence there.
6. The public entry does not own scheduling, receipts, checkpoints, evidence, or closeout. Those remain owned by the canonical runtime and existing store implementations.

Use `bin/temari.mjs policy` to inspect the contract. Start or resume with `--request ABSOLUTE_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX`. Both digests must come from trusted input outside the bundle and request. Engineering entries forward stage dialogue to the canonical host bridge; the QA entry invokes the packaged local evaluator. A blocked or rejected result is not a successful run.

For a selected durable engineering task, follow [task tracking](references/task-tracking.md)
to retain the actual conversation, recovery point and outcome automatically.
Select the task explicitly, preserve its current version, and keep tracking outside
the execution request. Feature tracking uses the original project scope while
the host verifies the integration checkout. A handoff never establishes completion.

When a correction or observed counterexample confirms a systemic discrepancy,
Temari owns the decision to repair it and the required route. Preserve the failing
case and expected invariant, then promptly initiate one bounded repair under the
same logical task when its independently selected existing authority admits it.
Use `bin/temari.mjs repair start --request ABS_JSON --expected-request-sha256 HEX
--expected-manifest-sha256 HEX --task-selection ABS_JSON
--expected-task-selection-sha256 HEX`. The report names `repairId`, counterexample,
affected surface, invariant, pinned evidence, requested scopes, regression contract
and `requiredRoute`; it cannot nominate an executable or commands. Keep task/host
selection and its externally supplied digest separate from the report. The selection
pins the owning public invocation and existing bounded host profile. A handoff is
only a continuity link. Reopen actual prior host proof for a feature owner; a
lightweight owner cannot authorize a shared boundary, defect, migration or other
full-route repair. Record the precise missing-authority blocker instead of
self-authoring a wider profile or relabeling the work.

After the actual repair worker is observed, continue compatible original work;
the repair never replaces the parent run or requires a new chat. Use the same flag
pairs with `repair status` to recover the exact retained launch. Repeat reports,
restarts, missing heartbeat or expired lease never authorize another launch.
Worker PASS means `NEEDS_REVIEW`. Select the exact candidate/artifact and reopened
independent-review plus failing-baseline/fresh-install regression evidence before
`repair accept` records coordinator resolution. Missing or changed evidence reopens
the obligation. Repair acceptance grants no parent completion or publication.

For a never-launched BLOCKED report, obtain the missing independently proven
authority and use `repair readmit` with the same report, a fresh key and current
task version. Preserve the original refusal in history. Ordinary repeat `start`
cannot admit it, and readmission never retries a launched or uncertain process.
The host freezes the admitted source before dispatch; compatible parent edits
outside repair ownership do not disturb that isolated candidate. Reopen the
pinned counterexample and helper/input byte identities alongside result evidence
before maintaining resolution.

For QA, pass a versioned full assignment, review draft, canonical evidence root, and canonical invocation to `bin/temari.mjs qa` with the same external request and artifact digest flags. The result retains a QA disposition and evaluator evidence. A caller-supplied evaluator ID, round, context claim, or capability list is rejected. The route never writes to external systems.

The QA request may pin `review.intentSources` as requirement reference, revision, authority reference, and expected outcome. It may select `review.projectVerifierId: "temari-public-v1"` only for a matching Temari workspace candidate. The installed entry loads the ticket acceptance playbook, QA evidence skill, and selected verifier text into a digest-bound handoff; `guidance.execution: "not-observed"` means no verifier was run by that loading step. The bundled local worker checks procedural evidence but has no independent product-intent or assertion-adequacy assessor, so it cannot produce a full QA pass. Retain the `BlockedOrIncomplete` result until a trusted semantic evaluator and the applicable project control actually run.

For the registered `temari-public-policy-v1` execution profile, select a separately
relocated, manifest-pinned product artifact and an eligible current task. Add
`--qa-execution-selection ABS_JSON --expected-qa-execution-selection-sha256 HEX`
and the explicit task-tracking pair to `qa`. The selection fixes the named profile,
task, product manifest and environment; it cannot supply commands, proof, expected
values or evaluator identities. The host executes the actual CLI policy command
and launches the finite policy assessor in a separate process. This verifies the
advertised Temari QA owner, read-only contract and capability-admission contract;
it does not verify other applications or arbitrary natural-language requirements.

The canonical runtime executes and retains the six stages. Inspect both its
mechanical receipt and the QA disposition: a completed evaluation can report
`Failed` or `BlockedOrIncomplete` even when its workflow receipt is `PASS`.
The task outcome retains the exact QA record/proof and receipt for independent
review. Task tracking records context and does not complete a canonical TaskRun.
The host first proves its fixed worker transport with the frozen NotRun draft;
that unresolved capability probe admits only this QA host's `subagents`. It is
separate from product proof and admits no general model, Codex, forge or parallel
capability. Resume verifies the original retained probe.

Use `qa-resume` for a nonterminal checkpoint with the same trusted inputs and a
fresh task tracking key/current version. Delivery retains canonical QA record
and proof before terminal persistence. Use `qa-result` with the same full pinned
flag pairs and a fresh task key/current version to recover local result
publication from a completed mechanical PASS. The reader verifies original
capability capture, all four stores, unchanged candidate and delivered record;
it launches no controls and never overwrites a different result. Non-deliver
terminal outcomes, drift and orphan stages remain refused. Other product
profiles retain the unavailable disposition.
