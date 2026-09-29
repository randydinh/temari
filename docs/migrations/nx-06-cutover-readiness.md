# NX-06 preparatory cutover rehearsal

This record covers a disposable local installation and rollback rehearsal. It does not approve release, replace an installed plugin, or start an observation period. The checked code milestone is `b13068842976a1996da5a65480e3e2843b65a29f` on `codex/nx06-cutover-readiness-20260928`, based on merged main `c3e3d6b57d3dd085821c400d8c4ec69936ee70fe`. The final documentation commit needs a fresh clean package and rehearsal at its exact SHA; record those results in the draft PR without another status commit.

## Reproduce the local check

Use fresh absolute paths for all three outputs. The public packager reads this Nx checkout to make an artifact. The rehearsal then reads only the two packaged artifacts and writes only under its fresh output directory. Do not aim these commands at an installed plugin, a user skill root, or a development checkout.

```sh
pnpm nx run workflow-runtime:package --lane portable --output /private/tmp/temari-nx06-legacy-probe-20260928 --skipNxCache --skipSync
node tools/public-entry-runtime.mjs package --output /private/tmp/temari-nx06-public-b130688-20260928
shasum -a 256 /private/tmp/temari-nx06-legacy-probe-20260928/.temari-distribution.json /private/tmp/temari-nx06-public-b130688-20260928/public-entry-manifest.json
node tools/nx06-cutover-rehearsal.mjs \
  --public-artifact /private/tmp/temari-nx06-public-b130688-20260928 \
  --public-sha256 9f66bbea01cfb5a11307afadcf2cd1787992c900be58571bd2bebd4e43170bed \
  --previous-artifact /private/tmp/temari-nx06-legacy-probe-20260928 \
  --previous-sha256 209155eb2ca2280cd2494936a0c9dcfb4d534b1dc145085e14517410b0caabde \
  --candidate-sha b13068842976a1996da5a65480e3e2843b65a29f \
  --output /private/tmp/temari-nx06-rehearsal-b130688-20260928
node tools/nx06-matrix-drift.mjs \
  --matrix docs/migrations/v4.1-to-nx-matrix.md \
  --rehearsal /private/tmp/temari-nx06-rehearsal-b130688-20260928/result.json
```

The runner refuses an existing output path. It rejects symlinks and unexpected artifact files, compares each public file with the externally pinned outer manifest, compares each v4.1 file with its packaged inventory, and checks the clean candidate SHA. Child processes receive only `PATH`, task-local `TMPDIR`, `TMP`, and `TEMP`, locale, empty Node option variables, and `SystemRoot` if present. The runner does not pass `HOME`, credentials, provider configuration, or the parent's other environment variables.

The packaged v4.1 `install-host.sh --mode=copy` creates only the fresh `previous-projection` destination and copies package files there. It can move existing entries into `.temari-backups`, so the runner asserts that the destination does not exist and that no backup directory appears. The later `control-temari routing --dest` reads the restored package and projection; its `routing` path writes no files. The runner checks that all swap targets are absent before copying or renaming. These claims come from inspection of the packaged scripts at the two manifest digests above and the retained command output. They are not a general audit of other commands in the v4.1 verifier.

The current runner resolves the output parent before creating scratch files and rejects an output redirected into either artifact through a symlink. The matrix checker verifies structure and local artifact consistency only. It always refuses `--release` because this report cannot independently verify row proofs or external gates.

## Observed evidence

The local host was macOS `darwin` `arm64`, release `25.5.0`, with Node `v26.9.0` and pnpm `11.25.0`. The public outer manifest SHA-256 was `9f66bbea01cfb5a11307afadcf2cd1787992c900be58571bd2bebd4e43170bed`. Its source revision was `b13068842976a1996da5a65480e3e2843b65a29f`, `dirty: false`, with 81 packaged files and the `temari`, `poteto-mode`, and `closeout` entries. The v4.1 distribution manifest SHA-256 was `209155eb2ca2280cd2494936a0c9dcfb4d534b1dc145085e14517410b0caabde`; it declares portable source revision `959c8f7be3d7b684207d9e626263d41540d5ecdc`.

The full command, arguments, stdout, stderr, and exit for each installed invocation are in `/private/tmp/temari-nx06-rehearsal-b130688-20260928/result.json` (SHA-256 `c734829db3c086b16c742281e671bdf1300c42160beb4eec0035dc727ca54877`). This scratch evidence is local and may expire. The table names the SHA for checks run before the candidate commit.

| Check                                                                                                                                                                    |           Exit | Observed result                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm nx run workflow-runtime:package --lane portable --output ... --skipNxCache --skipSync`                                                                             | 0 at `c3e3d6b` | Portable distribution created; package digest `38ecaa0078d9f44efe4c1cced5193110348b3f3ea5d6176f426e3df5f92830bc`.                                                  |
| `node tools/public-entry-runtime.mjs package --output ...`                                                                                                               |              0 | Clean 81-file public bundle at the SHA above.                                                                                                                      |
| `node tools/public-entry-runtime.mjs check --artifact ... --expected-manifest-sha256 ...`                                                                                |              0 | Outer inventory matched the pinned manifest.                                                                                                                       |
| `NX_DAEMON=false pnpm nx run-many -p workflow-runtime -t public-entry-test canonical-test host-session-test --parallel=1 --skipNxCache --skipSync --output-style=static` | 0 at `49ee163` | Existing focused installed-entry, canonical, and host-session tests passed. Re-run at final PR head before any acceptance claim.                                   |
| `NX_DAEMON=false pnpm nx run-many -p workflow-runtime -t typecheck check --parallel=1 --skipNxCache --skipSync --output-style=static`                                    |              0 | Typecheck dependencies and 234-file v4.1 inventory check passed at `b130688`.                                                                                      |
| `node tools/nx06-cutover-rehearsal.mjs ...`                                                                                                                              |              0 | Both installed engineering entries completed six stages on synthetic `product.txt`; closeout returned `candidate-verified`; full capability and QA routes refused. |
| `node tools/nx06-matrix-drift.mjs ...`                                                                                                                                   |              0 | All 13 matrix rows have structural fields; artifact trees match the rehearsal report.                                                                              |
| `node tools/nx06-matrix-drift.mjs ... --release`                                                                                                                         |              2 | Release refused because row-specific proof and external gates remain open.                                                                                         |

The installed commands and exits in `result.json` include `temari` policy 0, `poteto-mode` policy 0, full-feature capability refusal 1, QA refusal 1, `temari start` 0, `poteto-mode start` 0, `closeout verify` 0, v4.1 copy install 0, and restored v4.1 routing 0. The full-feature route lacked proven `subagents` and `forge`; the QA route was rejected. No independent QA verdict was produced. The synthetic product's final SHA-256 was `a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8`.

The successor slot digest before rollback was `a7939bf8b3c04a074a1062b5e23fe790ca1d551756bf0baa95816a0026bc75d5`. The copied prior v4.1 projection digest was `f36dd1a6fb1631d75964c5a92bab0acc1af90420ad0d99339aad3e79234280d9`. After moving the successor into a scratch quarantine and copying the prior projection into the same scratch slot, the slot digest was again `f36dd1a6fb1631d75964c5a92bab0acc1af90420ad0d99339aad3e79234280d9`. The quarantined successor retained its original digest. `control-temari routing --dest` returned `routing_ok=yes` and exit 0 from the restored copy. Its output says `install_comparison=not-performed` because the copied package and projection are the same tree, so this is an invocation and byte-restoration check, not independent v4.1 drift proof.

## Open gates and proposed operator record

Local preparatory rehearsal is `PASS`. PR #58 merged the protected model transport and a synthetic local Ollama canary, but private-use privacy review and external overlay use are `OPEN`. Product QA is `OPEN`: the installed route retains a truthful blocked attempt and has no independent evaluator round. A local loopback service passed separate-process recovery and stale-fence refusal; production shared-service failure and cross-machine recovery remain `BLOCKED`. A second real host is `OPEN`; the generic v4.1 scratch invocation and local macOS run are not second-host evidence. The final integrated head still needs its own clean artifact, rehearsal, exact-head CI, and independent review. Actual cutover is `BLOCKED` pending separate operator approval. The drift check deliberately reports all `V41-01` through `V41-13` row proofs missing for a release verdict; structural completeness is not behavior acceptance.

For a later authorized cutover, propose a 24-hour observation period starting only when the operator records the replacement time and the exact installed digest. Alert the owner on any failed entry admission, missing source evidence, non-PASS receipt, closeout mismatch, unexplained capability change, or rollback health failure. Stop the rollout for a lost or changed retained record, a nonrecoverable invocation, an unapproved private overlay read, an unproven required capability, or a failed rollback check. The operator record must name the candidate SHA and manifest digest, prior projection digest, host results, QA and privacy decisions, shared-service and second-host evidence, start time, incident owner, stop criteria, rollback command and result, and explicit proceed or abort decision. No observation clock or operator decision was started here.
