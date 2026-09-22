# Build a Temari workflow distribution

This package vendors Temari's conversational skills, Pstack playbooks, evidence
commands, host adapters, and an optional Archon integration. Packaging uses only
the files under this package. It never reads the original Temari checkout.

From the Nx workspace, check the inventory and create a portable distribution:

```sh
pnpm nx run workflow-runtime:check --skipNxCache --skipSync
pnpm nx run workflow-runtime:package --lane portable --output /absolute/new/portable --skipNxCache --skipSync
```

The command prints the artifact path, inventory digest, file count, and whether
it created or reused that artifact. Omit `--output` to use a content-addressed
directory below this package's ignored `dist/` directory. A repeated build reuses
only an exact matching artifact. Changed or foreign destinations are preserved
and rejected. No installation is changed by either command.

For Archon, select its lane explicitly:

```sh
pnpm nx run workflow-runtime:package --lane archon --output /absolute/new/archon --skipNxCache --skipSync
```

The portable lane omits the Archon runtime. Its discovery and installation checks
report that absence. The Archon lane includes the same portable files plus the
runtime allowlist, including hidden native workflows. Neither lane invokes a
model, changes model defaults, or downloads an Archon executable. The Nx
initializer manages the native executable separately through
`@temari/archon-harness`; this v4.1 bundle remains a historical migration
payload.

## Try a copy without changing an active installation

Use a fresh absolute skill-root destination, then run its copied verifier:

```sh
bash /absolute/new/portable/scripts/install-host.sh --host=generic --mode=copy --dest=/absolute/scratch/skills --include-verification
bash /absolute/scratch/skills/.temari-package/verification/verify-temari/scripts/control-temari routing
```

`codex` and `claude-code` are also supported host values. The installed
`pstack-root` pointer is relative, so the complete skill root can move together.
For a Codex plugin, use a fresh directory whose final component is `temari`:

```sh
bash /absolute/new/portable/scripts/build-codex-plugin.sh --output=/absolute/scratch/temari
```

These inherited installation helpers can back up existing destinations. For
evaluation, always use fresh scratch destinations. Do not point them at your
active skill root or plugin cache.

## Provision command dependencies explicitly

Packaging and inventory checks are offline. Running the copied Pstack commands
requires Bun, Git, and dependencies from its bundled Bun lockfile. Catalog,
routing, and playbook inspection also use Node, Python 3, Bash, and standard
command-line utilities. No dependency directory is vendored.

Install dependencies into a disposable runtime copy, not the immutable artifact:

```sh
cd /absolute/scratch/skills/.temari-package/skills/poteto-mode/scripts
bun install --frozen-lockfile --ignore-scripts
```

The inherited bootstrap may invoke a locked install on first use. Set a fresh
`TEMARI_VERIFY_ROOT` and `TEMARI_VERIFY_EVIDENCE` outside the package before
running `control-temari launch` or `doctor`. A missing Bun executable can trigger
the inherited launch helper's temporary Bun installation. Supply an existing
verified Bun executable when testing offline. Package integrity checks reject
added dependency or evidence files inside immutable artifacts.

For native Archon verification, use the included optional integration README and
an explicitly selected compatible executable. The migrated integration pins
Archon 0.10.1 at commit `9820785c`. Deterministic failure/resume proof is separate
from the explicitly prepared paid live pilot. Neither is a general host adapter
or proof of every Temari behavior.

## Verify a change

```sh
pnpm nx run-many -p workflow-runtime -t test typecheck check --skipNxCache --skipSync --parallel=1
pnpm nx run workflow-runtime:check --artifact /absolute/new/portable --lane portable --skipNxCache --skipSync
```

The Node tests exercise inventory rejection, byte and executable-mode integrity,
portable versus Archon selection, preservation of foreign destinations, output
overlap through ancestor symlinks, and relocated catalog, routing, copy-install,
plugin, and reference commands. They do not claim a fresh host conversation or
native Archon execution. Keep those integration proofs separate.

## Maintain the imported files

`import-paths.txt` is the explicit import selection. `provenance.json` records the
source commit, source hash, artifact hash, executable bit, lane, and explanation
for every changed imported file. `assets/v4.1/` preserves the runtime's relative
layout. The inventory checker rejects extra files, symlinks, unsafe paths,
case-insensitive collisions, and unexplained transformations.

Review source updates before changing this inventory. Recompute both hashes and
record any intentional transformation. Do not regenerate the inventory merely
to accept unexplained drift. Keep the Bun lockfile, playbook/profile hash pairs,
and Archon runtime allowlist together.

Private project overlays, old evidence, dependency trees, Git state, and archived
evaluations are excluded. The shared Seq skill accepts an optional approved
project overlay and returns `needs-scope` when material local context is missing
or conflicting. Historical source-only evaluation recipes are not shipped proof.

Temari still owns semantic coordination, Pstack owns engineering method, and host
adapters map execution facilities. This package adds no coordinator, instruction
loader, model client, or second workflow lifecycle. It is not an installed-plugin
cutover or completion of the follow-through product work.
