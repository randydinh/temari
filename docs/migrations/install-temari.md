# Install or upgrade the Temari plugin

Use the verified marketplace release to install Temari in Codex. It contains six
public skills and the complete internal P-stack method library. Codex owns
marketplace registration, plugin installation, enablement and removal; Temari's
release verifier and installation inspector are read-only.

The release keeps user data outside the plugin. Task records, evidence, private
overlays and the Knowledge workspace do not belong in its immutable directory.
Node.js 22 or newer is needed to run the carried checks. Knowledge setup remains
an explicit [separate step](../../packages/workflow-runtime/README.md#installed-temari-knowledge-capability).

## Verify and extract the release

Obtain the archive SHA-256, `RELEASE.json` SHA-256 and public manifest SHA-256 from
the trusted release record. Keep those pins outside the archive. Do not take the
expected values only from files in an unchecked download.

Compare the archive digest before extraction:

```sh
shasum -a 256 /absolute/download/temari-0.15.5.tar.gz
```

After it matches the supplied archive pin, extract into a new release directory,
then check its exact files, hashes, sizes and executable modes:

```sh
mkdir /absolute/releases/temari-0.15.5
tar -xzf /absolute/download/temari-0.15.5.tar.gz -C /absolute/releases/temari-0.15.5
node /absolute/releases/temari-0.15.5/temari-release-verify.mjs \
  --root /absolute/releases/temari-0.15.5 \
  --expected-release-sha256 RELEASE_SHA \
  --expected-manifest-sha256 PUBLIC_SHA
```

The verifier runs without the source checkout or development dependencies. The
release root contains its catalog at `.agents/plugins/marketplace.json`, the
plugin at `plugins/temari/`, and the verification tools outside the plugin.
Preserve this root while it is registered. A moved or changed directory needs a
new verified registration; an installed cache is a separate copy.

## Inspect, then install

Select the absolute Codex home for the installation. Inspect that home before
running native installation commands:

```sh
node /absolute/releases/temari-0.15.5/temari-install-state.mjs inspect \
  --codex-home /absolute/codex-home --codex-bin codex \
  --candidate-root /absolute/releases/temari-0.15.5 \
  --candidate-release-sha256 RELEASE_SHA \
  --candidate-manifest-sha256 PUBLIC_SHA
```

The inspector verifies the selected release before reading Codex catalogs. It
refuses a conflicting installed Temari, a marketplace from the wrong root,
unknown state, or a changed selected cache. Other inactive marketplace namespaces
can appear in its context; it never activates them. On a fresh home, use the
returned install commands with the same explicit home:

```sh
env CODEX_HOME=/absolute/codex-home codex plugin marketplace add /absolute/releases/temari-0.15.5 --json
env CODEX_HOME=/absolute/codex-home codex plugin add temari@temari-private --json
```

Marketplace registration and plugin installation are separate operations. Run
the inspector again to verify the installed identity, version and cache. A
repeated install should retain the same selected version and contents. The
inspector never installs, removes or enables a plugin itself.

## Upgrade a verified local predecessor

Retain the old release root and its independently supplied pins. Pass it to the
same inspector with `--prior-root`, `--prior-release-sha256`, and
`--prior-manifest-sha256`. The historical version supported by this increment is
`0.15.4+codex.2`; the current release is `0.15.5`. Changing SemVer build metadata
alone is not an upgrade.

When the inspector confirms the selected predecessor is installed and enabled,
use its explicit upgrade command sequence with the same Codex home:

```sh
env CODEX_HOME=/absolute/codex-home codex plugin remove temari@temari-private --json
env CODEX_HOME=/absolute/codex-home codex plugin marketplace remove temari-private --json
env CODEX_HOME=/absolute/codex-home codex plugin marketplace add /absolute/releases/temari-0.15.5 --json
env CODEX_HOME=/absolute/codex-home codex plugin add temari@temari-private --json
```

Run the inspector after the transition, still selecting both roots. Native
`marketplace upgrade` refreshes Git sources; it does not replace an extracted
local release root. Native `marketplace add` refuses the same marketplace name
from a different registered directory.

If interrupted after removal, inspect the native state before continuing. Keep
both verified roots. Either register and install the verified new release, or
restore the retained old root with native commands using its historical pins.
Do not clear caches, task stores or Knowledge data to repair registration. A
removed or disabled plugin requires an explicit reinstall decision; the inspector
does not treat it as permission to reactivate.

An older Temari installed through another marketplace is a migration choice.
The inspector refuses it rather than removing a foreign namespace. Confirm the
selected source and intended switch before changing that installation.

## Invoke the installed workflow

Use the host's plugin/skill picker or an explicit skill mention such as `$temari`
in Codex CLI. Desktop plugin selection uses the host's menu. Installation exposes
`temari`, `poteto-mode`, `closeout`, `qa-review-verification`, `qa-triage` and
`temari-knowledge`; it does not create arbitrary `/temari` or `/how` commands.
Follow the [method loading guide](../../packages/workflow-runtime/public/skills/temari/references/method-library.md):
Temari selects intent and policy, Poteto selects the admitted playbook, helpers
apply relevant principles, verification binds the candidate, and Closeout checks
the canonical evidence. Internal method resources stay behind those public
entries. Availability alone does not admit every historical playbook.

Restart or refresh the host as its plugin UI requires before testing discovery.
The automated recipient journey tests the local CLI and cached files; desktop
restart, native Windows and full workflow execution need their own evidence.

## Build and verify a release as a maintainer

Prepare the repository dependencies and commit the intended candidate. Build its
public artifact, then package the clean artifact using its independently retained
public manifest pin:

```sh
pnpm nx run workflow-runtime:public-package -- --output /absolute/new/temari
pnpm nx run workflow-runtime:release-package -- \
  --artifact /absolute/new/temari --expected-manifest-sha256 PUBLIC_SHA \
  --output /absolute/new/temari-0.15.5.tar.gz
pnpm nx run workflow-runtime:release-check -- \
  --archive /absolute/new/temari-0.15.5.tar.gz --expected-sha256 ARCHIVE_SHA
```

Record the plugin source commit, distribution-tools commit and three returned
digests outside the release. The
packager refuses dirty source and existing output. Build twice from the same
clean candidate and compare archive bytes. Keep historical packaging explicit
and restricted to a separately pinned supported predecessor.

Run `workflow-runtime:release-test` with `TEMARI_HISTORICAL_ARTIFACT` and
`TEMARI_HISTORICAL_MANIFEST_SHA256` selecting the clean prior public artifact.
Run `workflow-runtime:install-state-test` with `TEMARI_INSTALL_TEST_SELECTION`
pointing to a JSON file containing `candidate` and `prior`, each with `root`,
`releaseSha256` and `manifestSha256` from the retained release pins. Both targets
fail if their required fixture selection is missing. `TEMARI_TEST_PURE_UNITS=1`
is an explicit unit-only opt-out; it cannot establish release acceptance. Also
run `workflow-runtime:public-entry-test` for admission and closeout regression. The source
`workflow-runtime:installed-journey` target runs the actual native lifecycle in a
new scratch home; it requires the prior/current root and descriptor/manifest
pins, an absolute Codex binary and a new scratch directory. Retain its journal.
A test pass is installation evidence, not canonical Temari completion.
