# Workspace dashboard verification

## Scope

This source increment follows the merged Talk front door and reconciliation
panel. It adds a schema2 Talk registry that combines up to eight fixed workspace
conversation stores without changing their stored scope. It also retains chat
identities whose captured titles are unavailable, and clears unavailable
Knowledge results while refusing stale asynchronous responses.

The registry requires an explicit workspace choice for every new topic. It
qualifies public topic, turn, proposal and attention identities; retained context
keeps the original child-store identity. Namespaced task intake avoids collisions
between workspaces. A topic cannot be retargeted, and a foreign task cannot be
linked. Existing schema1 configuration remains supported.

## Executed checks

| Actual check | Result | What it covers |
| --- | --- | --- |
| `runtime:task-typecheck`, corrected v2 | PASS | Strict combined source and test types; prerequisite results may use local cache |
| `runtime:dashboard-talk-test` | 71/71, uncached | Legacy conversation behavior, HTTP, CLI preinitialization guards and scheduler cases |
| `runtime:dashboard-talk-registry-test`, corrected v3 | 6/6, uncached | Three scopes, namespace collisions, exact intake retry, immutable selection, refusal on drift and bounded aggregate lists |
| `runtime:dashboard-talk-ui-test` | 18/18, uncached | Legacy UI, explicit workspace choice, fixed bindings, separate drafts and uncertain request handling |
| `runtime:dashboard-pages-ui-test` | 12/12, uncached | Nullable titles and Knowledge main/detail/expand failures and stale response races |
| `runtime:open-work-test` | 9/9, uncached | Exact unavailable-title identities and existing capture validation |
| Actual local CLI and Chrome | PASS | Model-free three-workspace organization, correct parent link, HTTP409 for a foreign link, topic reload, separate drafts and disabled Send |
| Actual selected capture and Chrome layout | PASS | 275 known captured identities, including 67 explicit null titles, 34 captured checkouts; exact ID search and desktop/narrow layouts |

Counts describe separate targets and are not a sum of unique scenarios. The
first strict typecheck failed on projection and fixture declarations. A narrow
type-only correction passed the combined check; the failure remains retained.
The first browser collector expected an application alert for a native required
field. The corrected collector verified native validity and zero topic effects;
no application change was needed.

Independent source reviews accepted the current frontend/parser and corrected
registry/HTTP/CLI source. Private evidence retains source hashes, actual gate
outputs, failed attempts, fictional ledgers and browser images. Repository
documentation contains no private inventory, employer tickets or credentials.

## Boundaries

- The browser fixture used fictional workspaces and local task records. It made
  no model or native execution call, created no run and provided no semantic
  task acceptance.
- The 275-row capture is a projection of already retained metadata. It is not a
  new global capture, writer freeze, source preservation or closure permission.
- Workspace availability is checked against the selected physical directories
  and storage identities. An unavailable child is readable during an existing
  service session; restart requires the original complete roster.
- Knowledge UI recovery does not select, register, publish or attest a live
  corpus. A failed response clears old results; a displayed generation still
  needs its existing provenance and coverage checks.
- This source evidence does not prove deployment, a live model conversation,
  a new agent swarm, cross-host delegation or business completion. Native
  scheduling evidence and separately authorized worker trials retain their own
  scope and source revisions.

See [Talk setup and recovery](../dashboard-talk.md),
[Open Work coverage](../open-work-review.md) and
[Knowledge configuration](../dashboard-autonomy.md) before operating the surface.
