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

Each source claim names the dedicated `source` payload, whose generic evidence
kind is `other`, and supplies an allowed source kind from the pinned profile.
The `source-requirements` name is reserved for bridge-produced claims. The
bridge stores each claim beside the canonical stage attestation, with the
payload's run ID, revision, generic kind, byte count, and SHA-256. Before
saving a checkpoint, before reusing it after restart, and before saving a
terminal PASS, the bridge verifies that the claim references those exact
retained dedicated bytes. A generic `verification` payload or a PASS label
alone does not satisfy a requirement. The source final, commit, and review
boundaries require all four IDs. The publish boundary still requires separate
operator approval. The installed route offers local delivery only. A
six-stage PASS does not authorize publication, merge, or archive. The retained
claims establish source evidence provenance. `sourceKind` is a host
attestation over that payload; the bridge does not infer content type from
the bytes or supply an independent QA judgment about the host's work.

## Verification and limits

PR #56 froze the first implementation at
`0c673724484fe2ea7af5a9526a5d3a82459a01a9`. Independent review failed
that head because its public PASS omitted all four source requirements. The
first repair was committed at `6c300a2ca2e0a23a8586cb7d12453c8679d247c9`
on branch `codex/nx-installed-journey-20260928`. Its Linux `main` and
`windows-x64` PR checks passed. Independent rereview at that head found a
remaining generic-payload alias despite the otherwise successful synthetic
installed journey. The dedicated-channel repair was committed as
`4bf4713b2a887ad2d43086893c7cad3a36b3dab4`.

The independent reviewer ran these focused checks at that clean head. Each
command exited 0:

```sh
NX_DAEMON=false pnpm exec nx run-many -p workflow-runtime -t public-entry-test host-session-test canonical-test --parallel=1 --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run-many -t typecheck -p contracts,temari-core,workflow-engine,runtime,workflow-runtime --parallel=1 --skipNxCache --skipSync --output-style=static
NX_DAEMON=false pnpm exec nx run-many -t test -p contracts,temari-core,workflow-engine,runtime --parallel=1 --skipNxCache --skipSync --output-style=static
```

The generic-payload regression failed at `6c300a2`: public-entry-test
returned exit 1 with 25 of 26 tests passing because the ordinary observation
payload received an investigate checkpoint. At `4bf4713`, public-entry passed
31/31, canonical 11/11, and host-session 39/39. Five typechecks and four core
test targets passed. The relocated entry test denied legacy checkout imports,
interrupted after build, resumed at review in a new process, and read a PASS
receipt with six stages, all four source IDs, retained references, and the
expected candidate bytes. Negative cases block generic verification claims,
wrong generic kind, reserved or duplicate source names, changed retained
references, and acknowledged generic aliases on resume. This test uses a
synthetic host.

The historical `6c300a2` rereview packaged and checked a clean 79-file outer
artifact with manifest SHA-256
`7e1950cb2cd0c46ce30ba2aeddf53740d3a96eeb8ba897a5b4d1b435cf3a3f69`.
The later uncommitted channel-repair artifact was also historical. Its Stock
Node package and check commands were:

```sh
node tools/public-entry-runtime.mjs package --output /private/tmp/nx01-source-channel-final.aqd8iE/artifact
node tools/public-entry-runtime.mjs check --artifact /private/tmp/nx01-source-channel-final.aqd8iE/artifact --expected-manifest-sha256 8ceed138af73c23a3c201ea9d22d7c8b8fed9942d1ecdb64b737e921637e18fe
```

The artifact recorded source HEAD `6c300a2ca2e0a23a8586cb7d12453c8679d247c9`
with `dirty: true`. Both commands exited 0, but that artifact is not the
committed head. At `4bf4713`, the independent reviewer ran:

```sh
node tools/public-entry-runtime.mjs package --output /private/tmp/nx01-delta-review.jzPNxv/artifact
node tools/public-entry-runtime.mjs check --artifact /private/tmp/nx01-delta-review.jzPNxv/artifact --expected-manifest-sha256 ae872ce03245b137bb351a7de78709a847627cca42ef1bc6284989c7ede044c3
node /private/tmp/nx01-delta-review.jzPNxv/probe.mjs /private/tmp/nx01-delta-review.jzPNxv/artifact
```

Each command exited 0. The clean 79-file manifest names `4bf4713` with
`dirty: false`. The direct probe's generic-payload alias blocked before the
investigate checkpoint. A dedicated `source`/`other` run resumed after build
and finished PASS with all four IDs retained. Changed dedicated bytes and
hash-consistent retained generic aliases blocked before new work. The
[independent review report](/private/tmp/nx01-delta-review.jzPNxv/nx-01-delta-review-4bf4713.md)
records the refusal cases and returned PASS+NOTES for the code delta.

The separate native Codex-host run used a clean bundle with that same
manifest digest. Its request SHA-256 was
`c49d9414097432d451bd86348893748e61e0eb925406fd463e6931c16018ef5c`.
The actual host supplied stage results and dedicated `source` files. The
isolated product changed to the expected
`a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8`
digest. After a raw Ctrl-C exit 130, a fresh process resumed at review and
exited 0. The retained receipt passed all six canonical stages and retained
claims for all four IDs. The [native-host report](/Users/randydinh/source/projects/temari/.temari/runs/nx-build-20260928/orchestrate/temari-nx/reports/nx-01-final-native-probe.md)
records the run directory and checks. This is local-host evidence, not
independent product QA or cross-machine recovery.

At `4bf4713`, [Linux CI run 36410884037](https://github.com/randydinh/temari/actions/runs/36410884037)
and [Windows run 36410878158](https://github.com/randydinh/temari/actions/runs/36410878158)
both passed. `.github/workflows/ci.yml` runs `public-entry-test` on Linux.
The Windows workflow at that head omitted `public-entry-test`, so its green
result did not establish Windows installed public-entry acceptance. PR #56
later merged into main at `8cb14df8629b44fca3e12632c6a045adc4bff962`.

## NX-06A Windows installed-entry decision — 2026-09-28

The Windows harness now runs `workflow-runtime:public-entry-test` after its
canonical and host-session targets. Its push filters include the public-entry
test and packager, public wrappers, host bridge, pinned playbook assets, and Nx
target configuration. The existing Windows harness and Archon smoke remain.

The first Windows run at `821fdfde12e05aba6f90a5f3b4a784d826bae349`
failed in artifact setup: Windows reported no POSIX executable bit for the
regular Node entry files. [Run 36426687893](https://github.com/randydinh/temari/actions/runs/36426687893)
returned 18 shared-setup failures before the installed journey ran. Commit
`d08560149b13a75ad59520cfc40b756240b43e2a` limited the executable-bit
check to platforms that expose it; artifact inventory and actual Node entry
execution remain checked. Its [Windows run 36427275402](https://github.com/randydinh/temari/actions/runs/36427275402)
passed 30/31 public-entry tests. The remaining test passed an absolute drive
path to Node's ESM loader and failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME` before
the legacy-import refusal assertion. Commit
`e9147766c31bfb6c17d84e4fac3af9815a2293d2` passes a file URL to both
loader launches and retains that refusal assertion.

At `e9147766c31bfb6c17d84e4fac3af9815a2293d2`, this uncached local
command exited 0: `NX_DAEMON=false pnpm exec nx run-many -p workflow-runtime -t canonical-test host-session-test public-entry-test --parallel=1 --skipNxCache --skipSync --output-style=static`.
It passed 11 canonical, 39 host-session, and 31 public-entry tests. Exact-head
[Windows run 36427769912](https://github.com/randydinh/temari/actions/runs/36427769912)
and [Linux run 36427776685](https://github.com/randydinh/temari/actions/runs/36427776685)
both passed. The Windows log reports 31/31 public-entry tests, including the
relocated start, fresh-process resume, and six-stage PASS test. That test
asserts literal `APPLE\nPEAR\n` candidate bytes and SHA-256, retained source
references, and negative refusal paths. Independent code review at this head
found no actionable regressions. These run IDs prove the code head named here;
any later documentation commit needs its own exact-head CI record.

An older [Windows run 36412419554](https://github.com/randydinh/temari/actions/runs/36412419554)
at `c83e750` had a file-level `v4-1-route-replay.test.ts` failure without an
assertion trace; its [same-head rerun 36412832198](https://github.com/randydinh/temari/actions/runs/36412832198)
passed. That unexplained one-off remains historical and is not attributed to
NX-06A or counted as a current regression.

The expected digests are trust inputs, not signatures. This local boundary
assumes the host supplies them independently and the installed files are not
mutated between checking and use. It does not prove hostile filesystem race
containment. It does not replace the installed plugin or read the legacy
checkout. Windows has no POSIX executable-bit proof; its entry is launched
through Node. Independent product QA, read-only closeout with an independently
selected current candidate,
shared-service coordination, and operator review for cutover remain open.
Full-feature and QA capabilities remain explicit blocks. No installed plugin
was replaced, and no merge or publish approval is claimed.
