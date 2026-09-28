# Installed local candidate closeout

The packaged `closeout` entry verifies a completed run admitted through the
pinned lightweight `temari` or `poteto-mode` route. It returns only
`candidate-verified` with scope `local-regular-file-candidate-only`. It is not
independent product QA or permission to merge, archive, deploy, replace a plugin,
or publish.

## Trusted inputs and command

Supply the original public request JSON and its independently retained SHA-256,
the installed bundle's independently retained manifest SHA-256, and a separately
selected current candidate identity. The identity file contains exactly:

```json
{ "scope": "local-regular-files-v1", "sha256": "64 lowercase hex digits" }
```

Choose that identity from reviewed product bytes and file modes. The verifier
does not derive the expectation from the receipt, checkpoint, stage evidence,
or a fresh observation made for the purpose of matching them. Keep the identity
file outside the run directory and candidate, and retain its own SHA-256 outside
the file. The public request's `invocation.runDirectory` selects the existing
run; the request's run ID, revision, and candidate root must match its retained
descriptor.

```sh
node /isolated/bundle/bin/closeout.mjs verify \
  --request /isolated/request.json \
  --expected-request-sha256 REQUEST_SHA256 \
  --expected-manifest-sha256 BUNDLE_MANIFEST_SHA256 \
  --expected-current /isolated/selected-current.json \
  --expected-current-sha256 SELECTION_FILE_SHA256
```

All paths are absolute. The command checks the complete outer bundle before
loading its runtime. It validates the trusted request, canonical run and product
roots, disjoint layout, retained descriptor, pinned canonical manifest, fixed
capability report, and source profile. It derives the host scope ID with the
same canonical descriptor hashing as the bridge. It opens only existing receipt,
evidence, and workspace-manifest stores. The canonical verifier checks the
six-stage PASS receipt, candidate bytes and observed permission bits, stage evidence,
and workspace manifests. The source verifier additionally checks the dedicated
`source`/`other` payload claims: mapped IDs and stages, allowed source kinds,
run/revision-bound references, and retained bytes. A refusal exits nonzero
without a `candidate-verified` result.

`bin/closeout.mjs policy` is descriptive. `admit --run-directory` is a blocked
preflight because a run path alone does not supply trusted invocation or
selected current identity.

## Evidence and limits

The installed test packages and relocates the outer bundle, runs its public
engineering entry through all six stages in a fresh Node process, then calls
the actual packaged `closeout` executable in another process. The expected
product is the literal `APPLE\nPEAR\n` file with SHA-256
`a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8`;
the candidate identity also includes path and the nine permission bits reported
by the host filesystem. A recursive
before/after snapshot of run and candidate paths compares entries, sizes,
modes, modification times, and file hashes. Negative calls cover changed
candidate bytes or a mode change observable through `lstat`, changed selected
identity and its digest, tampered
receipt/evidence/manifest, redirected roots, symlinked or missing stores,
missing receipt, and a genuine `ISSUES` terminal run.

## NX-02 receipt-plan repair — 2026-09-28

Independent review of draft PR #59 at `20b06fc71df98fb4a396aaf4b7ce3c7beeb0c99e`
found that a six-stage PASS receipt could change `plan.review` from `self` to
`independent`, recompute its stored SHA-256, and still return
`candidate-verified`. The installed loader already checked the retained run
descriptor against admitted policy, but did not compare the receipt plan with
that descriptor. The repaired loader compares the loaded receipt plan exactly
with the policy-bound descriptor before reporting success.

The packaged-entry regression at `2253108` reproduced the old result: the
uncached `workflow-runtime:public-entry-test` target exited 1, with 34 of 35
tests passing; the rehashed-tamper invocation itself exited 0 and returned
`candidate-verified`. After the loader fix at `d14cf55`, the same uncached
target exited 0 with 35 of 35 passing. The closeout loader test now uses a
file URL and directly asserts that its legacy-checkout import guard refuses
the forbidden import. The valid installed closeout still leaves its run and
candidate snapshot unchanged.

The branch integrated `origin/main` at `7cf3221c0f8495b96adda4f9344b365262ca588c`
through normal merge commit `d926cfc`. The sole conflict was in
`docs/migrations/installed-public-journey.md`; resolution retained main's
record of the Windows file-URL and executable-mode fixes and pointed to this
separate closeout record. No product source conflict occurred.

At code head `d14cf5563ca6fa7237415bf097958476416a9718`, the uncached
five-project `typecheck test` bracket exited 0 for all ten tasks. The
uncached `workflow-runtime` canonical, host-session, and package inventory
targets exited 0 with 11, 39, and 234-file checks respectively. Exact final
head CI and independent rereview are separate gates.

The retained native NX-01 run at `/private/tmp/temari-channel-native.GrZvzP`
still records real host work and the same product bytes. Its descriptor pins the
older canonical manifest `c58bb6f2e8b01700d31c0d8c2adc01662fafa3182bf6bb87127da6b90be0bb0e`.
This closeout package uses a newer canonical artifact with read-only store-open
methods. Directly invoking its installed entry against that native run returned
exit 1 at the canonical-manifest comparison: retained
`c58bb6f2e8b01700d31c0d8c2adc01662fafa3182bf6bb87127da6b90be0bb0e`
versus installed
`d0985a19128f35b42cbd86ad4ed6e0b6f4d46d0cba30e86eec0a57655a3ecd05`.
The run/candidate file-hash aggregate was
`0dc765ef6aac117f904b4cd9c0e684661b59039b8eac317535027d54b28d92fb`
both before and after. This is a pinned-artifact refusal, not a successful
reverification of the old run. The original retained run remains untouched.

At implementation head `81bb284e59c38846f3728adb8c74087677cc2241`, a
clean 81-file outer package reported `dirty: false` and manifest SHA-256
`bc96a4580193287c4b0bfd2d1727c206273efeecfdfef1d2d7f072846d2a9a5f`.
The direct stock-Node installed closeout observation passed 1/1; the outer
checker exited 0 with that externally supplied digest. PR #59 is a draft for
independent review; its exact final head and CI remain separate evidence.

This boundary assumes one cooperative exclusive writer and local regular
files. The observation excludes empty directories, directory modes,
ownership, ACLs, and special mode bits. Filesystem reads may update access
times under host mount policy; no content, mode, modification time, or directory
entry is intentionally written. A caller-supplied SHA-256 is an integrity
input, not a signature or proof that the caller selected the right candidate.

On the Windows CI filesystem, toggling only group/other POSIX read bits left
the observed mode unchanged. The cross-platform negative now toggles the
write bit and confirms the mode changed before expecting closeout refusal.
