# Installed lightweight public entry

The public `temari` and `poteto-mode` executables now start or resume one
pinned serial route from a relocated outer bundle. The route uses the
canonical host bridge, six-stage engine, stores, and candidate observations.
The test host changes a synthetic `product.txt` from `pear\napple\n` to
`APPLE\nPEAR\n`. Its final SHA-256 is
`a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8`.

## Admission

The request is a bounded regular JSON file with `schemaVersion: 1`, the entry
name, `route: "lightweight-engineering"`,
`profile: "lightweight-engineering-v1"`, `obligations`, `routeInput`, and
`invocation`. The obligations are exactly `workType: feature`,
`delegation: none`, `review: self`, `evidence: revision-bound`, and
`delivery: local`. `routeInput` has `workType: feature` and all ten Boolean
lightweight conditions from `classifyEngineeringRoute`. `invocation` has
`runId`, `revision`, `candidate: { scopeId, root }`, and `runDirectory`.
No capability list or evaluator label is accepted from the request.

The host supplies the expected SHA-256 of the outer manifest and request from
trusted inputs outside those files. The executable checks the complete outer
inventory before loading the packaged core, checks the exact request bytes,
then uses the packaged classifier. It writes a temporary canonical bridge
request with policy obligations. On resume, it compares the retained run ID,
revision, canonical candidate root, run directory, and plan with the trusted
request before starting the bridge. The bridge and runtime then verify the
saved prefix and stage evidence.

```sh
node /isolated/bundle/bin/temari.mjs start --request /isolated/request.json --expected-request-sha256 REQUEST_SHA256 --expected-manifest-sha256 BUNDLE_SHA256
node /isolated/bundle/bin/temari.mjs resume --request /isolated/request.json --expected-request-sha256 REQUEST_SHA256 --expected-manifest-sha256 BUNDLE_SHA256
```

`admit --request` remains a preflight and reports missing trusted invocation
proof for the lightweight route. A matching full-feature route remains blocked
because the bridge cannot prove `subagents` or `forge`. QA remains rejected.
`closeout` remains blocked pending trusted candidate selection.

## Source mapping

The policy pins the v4.1 lightweight profile SHA-256
`94370c4bbbd48666807630abd2866f0727ccf3ab614d23fd4b2d3c3b98d493e7`
and playbook SHA-256
`320f33d095434c5a58fd2adb2abf6a1fcd458fe3a2af431a227d6f51dde6e492`.
All four profile requirement IDs occur in the policy's six-stage mapping.

| Canonical stage | Source requirement                           | Host work                                                      |
| --------------- | -------------------------------------------- | -------------------------------------------------------------- |
| investigate     | `lightweight.intake.inspect`                 | Inspect the target and instructions.                           |
| plan            | `lightweight.route.qualifies`                | Check every lightweight condition and select the small change. |
| build           | `lightweight.build.smallest-complete-change` | Make the bounded local change.                                 |
| review          | `lightweight.verify.direct-check`            | Inspect the final diff.                                        |
| verify          | `lightweight.verify.direct-check`            | Run the direct product check.                                  |
| deliver         | All four requirement IDs                     | Report the result and retained evidence.                       |

The source final, commit, and review boundaries require all four IDs. The
source publish boundary also requires `operator-approval`. The installed route
offers local delivery only. A six-stage PASS neither resolves that gate nor
authorizes publication, merge, or archive. Stage evidence records host claims
and bytes; it does not independently judge product quality.

## Verification and limits

At base `709480ad845435811427284663ba939ee0d12f7a` on branch
`codex/nx-installed-journey-20260928`, with an uncommitted NX-01 diff, these
commands returned exit 0 after `pnpm install --frozen-lockfile`:

```sh
pnpm nx show project workflow-runtime --json
NX_DAEMON=false pnpm nx run workflow-runtime:public-entry-test --skipSync
NX_DAEMON=false pnpm exec nx run workflow-runtime:public-entry-test --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run-many -p workflow-runtime -t public-entry-test --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm nx run workflow-runtime:canonical-test --skipSync
NX_DAEMON=false pnpm nx run workflow-runtime:host-session-test --skipSync
NX_DAEMON=false pnpm nx run-many -t typecheck -p contracts,temari-core,workflow-engine,runtime,workflow-runtime --parallel=1 --skipSync
NX_DAEMON=false pnpm nx run-many -t test -p contracts,temari-core,workflow-engine,runtime --parallel=1 --skipSync
```

The public-entry target passed 19 tests, canonical 11, and host session 39.
Five typechecks and four core test targets passed. The relocated entry test
denied legacy checkout imports in the public process, interrupted after the
build checkpoint, resumed at review in a new process, and read a PASS receipt
with the literal six-stage order and candidate bytes. Negative cases changed
the policy, host package, request, route, obligations, capability labels, QA
route, full-feature route, and retained evidence. Each refused before a false
PASS. The direct test uses a synthetic host, not a native product agent.

`.github/workflows/ci.yml` now includes `public-entry-test` in the
`workflow-runtime` PR and main job. Both uncached target forms above passed
locally after the CI edit. The full CI job has not run at this
uncommitted head; the local environment does not have the Bun executable used
by the separate legacy `workflow-runtime:test` target.

The expected digests are trust inputs, not signatures. This local boundary
assumes the host supplies them independently and the installed files are not
mutated between checking and use. It does not prove hostile filesystem race
containment. It does not replace the installed plugin or read the legacy
checkout. Independent code review, exact-head Linux and Windows CI, a native
installed-host journey, independent QA, and read-only closeout with an
independently selected current candidate remain the next gates.
