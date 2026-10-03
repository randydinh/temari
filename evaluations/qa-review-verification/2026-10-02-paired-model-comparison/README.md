# Actual paired QA response comparison — 2026-10-02

The fixed six-case trial captured actual responses from QA writer 0.6.0 and the
reconciled 0.7.2 instructions on the same selected local Codex CLI configuration.
The independently reviewed V3 evidence is accepted for this sampled development
comparison, with quality gaps. It does not establish an overall winner or uniform
improvement. [Exact bindings](trial.json) connect the versions, selected resource
hashes, host configuration, outputs, assessment and private capture seals.

## Inputs and method

The [fixture](fixture.json) contains six fictional assignments: an attributed
component handoff, full review without an owned fixture, reusable case design,
opted-in workflow visibility, a reported ordinary-checkout failure and a low-harm
behavior with no approved expectation. No employer ticket, customer data or
credential was supplied. The direct user authorization was limited to this
comparison and eleven selected instruction texts per version.

Each worker handled all six cases in one context. This is one pair, not twelve
fresh sessions. Both used CLI 0.154.0 and the same explicit `gpt-5.6-terra` wrapper,
read-only sandbox, ephemeral execution and ignored user configuration. Effective
server/model implementation and reasoning effort were not exposed. Recorded
process intervals overlapped by 61.229 seconds; no independent live V3 process
observation was performed. This is not native task or harness capability proof.

The workers received the [instructions](worker-instructions.md) and fixed inputs;
the [rubric](assessment-rubric.json) was assessor-only. The last actual outer final
was retained unchanged, and its summary was parsed once into each inner response
packet. Both response and capture schemas passed independently. The reviewer
rehashes the full artifacts and confirms the recorded read outputs match the
selected text ranges. This is transcript scope, not OS-level read confinement.

## Responses and independent assessment

| Version | Actual response | Unchanged raw outer final | Individual assessment |
| --- | --- | --- | --- |
| A, 0.6.0 | [Response text](variant-a.md), [packet](variant-a.json) | [Raw final](variant-a-raw-final.json) | [43 judgments](variant-a-individual-assessment.json) |
| B, 0.7.2 | [Response text](variant-b.md), [packet](variant-b.json) | [Raw final](variant-b-raw-final.json) | [43 judgments](variant-b-individual-assessment.json) |

The reviewer is distinct from both response producers, but knew the source/version
mapping. No blind evaluation is claimed. Each individual assessment was sealed
before the [comparison](comparison-review.md). The versioned individual records
change only absolute evidence filenames to local filenames; judgments, excerpts,
line spans and hashes are unchanged, with original record hashes in `trial.json`.

Both versions retain scope, attribution, authority gaps and full-review blockers.
Neither invents product execution, canonical admission or full acceptance. The
proposed response explicitly describes some route boundaries and compact case
fields, but the following gaps remain:

- Both checkout responses only partially separate impact, severity, affected
  scope, reachability and priority.
- B's component handoff omits a concrete next action.
- B's blocked full-review response omits the responsible prerequisite supplier.
- B's checkout response leaves business/user impact implicit and does not identify
  priority or its decision owner; A at least leaves priority to delivery ownership.

These findings remain open feedback for a separately verified instruction change.
The sample does not support complete five-dimension behavior, universal improvement
or an actual QA pass. Nearby case design does not test planning/triage runtime; a
static visibility prompt does not prove a live multi-turn route switch.

## Retained invalid attempt and final integration

V2 is an invalid paired attempt: its instructions permitted a root resource list
that its schema rejected. A used it and B omitted it. V3 changed only that schema
allowance and reran both workers with the same inputs and settings. V2 outputs,
helper failures and protocol review are retained with no comparative acceptance;
this report does not strip fields or retroactively validate the old attempt.

B's selected development artifact had a dirty source tree. Final source acceptance
requires exact equivalence of all eleven selected texts to the current-main clean
candidate, a fresh strict package and actual finite-policy smoke. Those separate
gates are recorded with the integration evidence. These trial files are development
evidence and are not added to the public runtime artifact.
