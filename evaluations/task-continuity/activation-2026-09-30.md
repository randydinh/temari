# Local Temari plugin activation

Activated `temari@personal` version **`0.15.3+codex.2`** on 2026-09-30 after the
owner approved proceeding with the reviewed installed-entry integration.

## Selected artifact

- Source revision: `5247ecb94ce7e5503c383ae4aced597405619e3b`.
- Implementation and independent review: `2f1b9254f02fc8b39d84ac808a2aca6441803bcf`.
- Public manifest SHA-256: `a60b3cb9b5344aea4f06ee260efbd203a514d9dee2021f614933915dd91a6ed0`.
- Inventory: 111 files.
- Marketplace source: `/Users/randydinh/plugins/temari-0.15.3+codex.2`.
- Installed cache: `/Users/randydinh/.codex/plugins/cache/personal/temari/0.15.3+codex.2`.

The release commit changes only the plugin version. Comparing artifact inventories
with the reviewed bundle found identical executable and skill bytes; only the
plugin metadata and canonical build manifest differ. The previous
[verification record](installed-entry-2026-09-30.md) retains the 62 installed-entry
and 53 source-host checks and independent review.

## Activation and verification

1. Built the versioned bundle with the existing public artifact packager and
   verified its complete inventory.
2. Copied it into a new personal source directory and verified every copied file.
3. Changed only Temari's source path in the existing personal marketplace.
   Saved its previous catalog bytes at
   `/Users/randydinh/plugins/temari-activation-backups/marketplace-before-codex2.json`.
4. Ran the supported local command `codex plugin add temari@personal --json`.
   It reported the selected version and installed cache above.
5. `codex plugin list --marketplace personal --json` independently reported
   `installed: true`, `enabled: true`, and version `0.15.3+codex.2`.
6. Verified the installed bundle against the selected manifest digest with the
   public artifact checker. The installed Temari `policy` command executed
   successfully. Its skill links to the installed task-tracking reference.

The installer removed the old cache directory. To preserve absolute paths held by
retained runs and existing chats, restored its exact 101-file inventory from the
unchanged source at `/Users/randydinh/plugins/temari` to
`/Users/randydinh/.codex/plugins/cache/personal/temari/0.15.3+codex.1`.
Every restored file matched its original manifest, whose SHA-256 is
`585cc33186f6d9a3f0afdcd3503116694bc13a3b3a8acebef7fe942316dda73d`.
The installer registry still selects `codex.2`. Future updates may prune old cache
versions again; preserve the retained source for recovery.

## Session refresh and recovery

Installation and enablement are verified. The running desktop app was not
restarted, and this record does not claim that an already-open chat has reloaded
its skill catalog. Restart the desktop app to refresh local plugin files, as
described in the [official local plugin guidance](https://developers.openai.com/plugins/build/plugins).

To roll back activation, restore only Temari's personal marketplace source path
to `./plugins/temari`, then use `codex plugin add temari@personal --json` again.
Preserve newer pinned bundles before installing, because the installer can prune
other cache versions. Do not overwrite the entire marketplace catalog if it has
changed since the backup.

This was a local plugin update. No GitHub publication, external message,
knowledge-plugin lifecycle change or task completion acceptance occurred.
