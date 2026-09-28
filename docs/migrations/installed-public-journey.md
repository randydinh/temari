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
request with policy obligations and the admitted source profile. On resume,
it compares the retained run ID, revision, canonical candidate root, run
directory, plan, and source profile with the trusted request before starting
the bridge. The bridge and runtime then verify the saved prefix and stage
evidence.

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
The installed bundle carries those exact profile and playbook bytes. The
packaged compatibility checker admits the pinned lightweight plan at final,
commit, and review only with matching retained source references. It blocks
publish on `operator-approval`. The bridge
requires a source claim for each mapped stage before acknowledging PASS.

| Canonical stage | Source requirement                           | Host work                                                      |
| --------------- | -------------------------------------------- | -------------------------------------------------------------- |
| investigate     | `lightweight.intake.inspect`                 | Inspect the target and instructions.                           |
| plan            | `lightweight.route.qualifies`                | Check every lightweight condition and select the small change. |
| build           | `lightweight.build.smallest-complete-change` | Make the bounded local change.                                 |
| review          | `lightweight.verify.direct-check`            | Inspect the final diff.                                        |
| verify          | `lightweight.verify.direct-check`            | Run the direct product check.                                  |
| deliver         | All four requirement IDs                     | Report the result after the earlier claims are retained.       |

Each source claim names one retained payload and an allowed source kind from
the pinned profile. The bridge stores the claim beside the canonical stage
attestation, with the payload's run ID, revision, generic kind, byte count,
and SHA-256. Before saving a checkpoint, before reusing it after restart,
and before saving a terminal PASS, the bridge verifies the source claim and
the referenced bytes. A generic `verification` payload or a PASS label alone
does not satisfy a requirement. The source final, commit, and review
boundaries require all four IDs. The publish boundary still requires separate
operator approval. The installed route offers local delivery only. A
six-stage PASS does not authorize publication, merge, or archive. The retained
claims establish source evidence provenance; they do not independently judge
the quality of the host's work.

## Verification and limits

PR #56 froze the first implementation at
`0c673724484fe2ea7af5a9526a5d3a82459a01a9`. Independent review failed
that head because its public PASS omitted all four source requirements. The
source repair is uncommitted on branch `codex/nx-installed-journey-20260928`
at that HEAD. These uncached checks returned exit 0 locally:

```sh
NX_DAEMON=false pnpm exec nx run workflow-runtime:public-entry-test --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run-many -t typecheck -p contracts,temari-core,workflow-engine,runtime,workflow-runtime --parallel=1 --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run-many -t test -p contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run workflow-runtime:canonical-test --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run workflow-runtime:host-session-test --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run workflow-runtime:package --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run workflow-runtime:check --skipNxCache --skipSync --output-style=static
git diff --check
```

The first bypass regression failed on the old code. The target returned exit
1 with 19 of 20 tests passing because the six-stage generic-evidence fixture
returned PASS. After the repair, the public-entry target passed 25 tests,
canonical 11, and host-session 39. Five typechecks and four core test targets
passed 276 tests. The v4.1 package created a 213-file portable distribution; the
inventory check passed all 234 source files. The relocated entry test denied
legacy checkout imports in the public process, interrupted after the build
checkpoint, resumed at review in a new process, and read a PASS receipt with
the literal six-stage order, all four source IDs, retained references, and
candidate bytes. Negative cases block missing source claims, an unsupported
source kind, changed retained source references, profile, playbook, policy,
host package, request, route, obligations, capability labels, QA and full
feature routes, changed descriptor, and altered retained evidence. The direct
test uses a synthetic host, not a native product agent.

Stock Node also packaged and checked a separate 79-file outer artifact at
`/private/tmp/nx01-repair-final-CyXxLV/artifact`. Its manifest SHA-256 is
`0952a04ae7c30fb99b08d3ff8633765ccf91e699eca715ef6e239d76a0da277b`.
The direct commands were:

```sh
node tools/public-entry-runtime.mjs package --output /private/tmp/nx01-repair-final-CyXxLV/artifact
node tools/public-entry-runtime.mjs check --artifact /private/tmp/nx01-repair-final-CyXxLV/artifact --expected-manifest-sha256 0952a04ae7c30fb99b08d3ff8633765ccf91e699eca715ef6e239d76a0da277b
```

The manifest records source HEAD `0c673724484fe2ea7af5a9526a5d3a82459a01a9`
with `dirty: true`. The `package` and `check` commands both returned exit 0;
this is a local uncommitted candidate, not a new PR head.

`.github/workflows/ci.yml` now includes `public-entry-test` in the
`workflow-runtime` PR and main job. The full CI job has not run at a new
repair head. Local checks do not establish exact-head Linux or Windows CI.

The expected digests are trust inputs, not signatures. This local boundary
assumes the host supplies them independently and the installed files are not
mutated between checking and use. It does not prove hostile filesystem race
containment. It does not replace the installed plugin or read the legacy
checkout. Independent code review, exact-head Linux and Windows CI, a native
installed-host rerun with source claims, independent QA, and read-only closeout
with an independently selected current candidate remain the next gates.
