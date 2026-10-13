# Local Temari artifact preservation

Recorded 2026-10-12 for the maintainer reconciling local work with the canonical
repository. This is a documentation-preservation and source-comparison record.
It does not accept an execution candidate or establish a Temari completion receipt.

## Compared repository state

The selected checkout and independently queried remote `main` were both
`eeff726e8cdc6d8d7cfd69d374aa318a4428c6e9`. The older primary checkout remained at
`255b46865b434252d9e97adcb15d72ce72ceaf15` with local method-library changes.
The comparison is revision-bound; later branch or remote changes require a new
comparison.

| Material | Observed disposition | Preservation action |
| --- | --- | --- |
| Primary checkout's method-library work | All 18 changed or untracked source/doc files exactly match their blobs in integrated commit `808c81f4`; that commit is an ancestor of the selected main | Preserve local originals and comparison hashes; do not reapply the obsolete dirty checkout |
| Integration guide | Missing from selected main | Import the reusable guide and remove the private account/thread verification paragraph |
| Chat knowledge extraction design and prompt | Missing from selected main | Import the proposed workflow, records and acceptance criteria; omit private inventory, chat/source IDs, host schedules and pilot details |
| September 28 enhancement review | Missing as a standalone review; some recommendations now appear in current ownership documents | Import a historical review with dated claims and current-document links; omit private source locations and the obsolete task-program snapshot |
| Source/evidence template | Missing as a standalone template | Import the generic template and retain route-specific evidence/closeout requirements |
| Work/personal knowledge areas | Committed as `0d1bfb0fd3de72cf7d16c5c62f33810830b5d922` on a separate branch; not an ancestor of selected main | Preserve the commit, changed source, patch and complete-history Git bundle; leave integration to the owning candidate review |
| Autonomous-run candidate | Worktree directory removed; source recovered from Git snapshot `cf8807bba10f2af6448f9af1d61437a349899fae`; not integrated into selected main | Preserve source, tests, historical reports, patch and complete-history Git bundle; import a candidate design without activating commands or policy |
| Commits from five missing temporary worktrees | pnpm upgrade, QA evaluator and single-chat integration tips are ancestors of selected main; managed-config and privacy-preservation tips still have unmatched patches | Preserve all five refs in a second complete-history Git bundle; do not apply old candidate patches automatically |
| Older orchestrator, design, P-stack and harness work | Historical source and migration records; exact integration parity with modern contracts is not established | Preserve the selected missing docs and source patches locally; avoid making superseded architecture or legacy QA routing current policy |

The work/personal-area candidate became committed during this investigation.
The autonomous worktree was recovered from the host's retained snapshot rather
than recreated or reset. Original checkouts were left intact. Existing refs for
five missing temporary worktrees still resolve to Git commits; their ignored
files and execution evidence were not reconstructed or verified.
Patch-ID comparison found three already-equivalent and six unmatched commits in
the retained managed-config branch, and one unmatched privacy-preservation commit.
An unmatched patch is retained work requiring review, not proof that all of its
behavior is absent from newer source.

## Documents made available in the repository

- [Choose an external-service integration](../integration-options.md): compare existing access, plugins, official MCP and a custom API integration, then verify the selected connection.
- [Chat knowledge extractor proposal](../plans/chat-knowledge-extractor-2026-10-10.md) and [draft extraction instructions](../plans/chat-knowledge-extractor-prompt.md): retain originals, attribution, qualifiers, contradictions and evidence-linked knowledge.
- [Historical enhancement review](../reviews/temari-enhancements-2026-09-28.md): evaluate operating principles and optional integration patterns without adding another lifecycle authority.
- [Source and evidence template](../templates/analysis-source-provenance.md): identify each inspected repository/artifact and distinguish observations from untested claims.
- [Autonomous overnight candidate design](../plans/autonomous-overnight-preserved-2026-10-12.md): retain controller invariants and adoption checks while current execution admission remains unchanged.

The imported documents are intended for a maintainer evaluating or continuing the
work. Proposal preservation does not approve a design, authorize historical chat
access, admit a route or transfer ownership of an independent extractor.

## Source-document provenance

These digests identify original retained bytes before curation. The private
custody manifest maps them to the original local paths and recovered copies.

| Original document | SHA-256 |
| --- | --- |
| Integration guide | `79703ec576399eceb13c404eb9d50188d4459f09daaa5694a38dd45b99360ba4` |
| Chat extractor design | `78477814721922edbd470b0f995ada439a26ab4a239efc757a07758b4e1a0c6e` |
| Extraction prompt | `b027c7a17de34f6e21275815773d4617bf550c4ae2d0c9392ae7198f1be9d3a6` |
| Enhancement review | `325b79f46ab30866e9684d39bb94996db40c665cb4517aaabdce486ada770301` |
| Source/evidence template | `2dafdc02a76721cbb2c198ffea7c99f66c2c97fae483ea4e16012d48c12cca31` |
| Autonomous candidate implementation guide | `7ee1184708934c53f936027dd69ecd8e7c745a15789dac06a1ea57794b5fbd94` |

## Local custody and verification boundary

The external local preservation archive holds exact copies, source patches, a
private path/hash manifest and complete-history Git bundles. Hashes are reopened
and checked after copying; the bundles are verified by Git. This is same-machine
custody, not an independently stored backup. Preserve that archive separately
before deleting any original checkout or local evidence.

Private preferences, employer application reports, knowledge databases, approved
source material, transcript bodies, credentials, dashboard state and task ledgers
remain local. None is part of the documentation commit. Local task continuity
retains the actual conversation and a structured handoff separately.

The change needs static verification: it moves documentation and preserves source
without changing runtime behavior. The required checks and rationale are:

| Outcome | Risk | Existing proof and required check | Level |
| --- | --- | --- | --- |
| Useful documents survive | Accidental omission, broken references or misleading adoption claims | Original-byte hashes, source comparison, relative-link checks and review of proposal labels | Static |
| Private data stays local | Host/account context enters shared documents | External local custody archive plus screening of every changed document for private paths, conversation IDs and credential values | Static |
| Code candidates remain recoverable | A removed worktree loses uncommitted source | Recovered Git snapshot, copied changed source and patches, reopened hashes and Git bundle verification | Direct artifact check |

These checks cover relative references, privacy screening,
proposal/current-behavior distinctions, source-hash comparisons and Git whitespace.
The integration guide's setup prerequisites were checked against current official
OpenAI and Slack documentation and the installed client's login help. Its private
connection observation was removed; no Slack account or conversation was accessed
for this preservation task.

No runtime, policy, packaged skill or playbook is changed. Candidate tests and
live execution journeys were not rerun; historical source reports stay distinct
from this task's preservation checks. Missing source custody or private run evidence
must be resolved before crediting a future execution or release claim.
