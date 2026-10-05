# Private Knowledge installer: larger Codex catalog

## Hypothesis and observed failure

The private 0.1.2 installer inspects every installed and available Codex plugin
before adding its local marketplace. On a macOS host, the 2.56 MiB JSON response
exceeded the helper's 2 MiB subprocess limit. Installation stopped before the
marketplace, plugin, or Knowledge home was created.

## Change and verification

The helper retains the global catalog check, including name collisions with
installed **and uninstalled** plugins in other marketplaces, and raises the
bounded subprocess output limit to 16 MiB. A first attempt to query only the
private marketplace was rejected in independent review because it missed an
uninstalled same-name plugin elsewhere. The test fixture now covers both
collision states and a 3 MiB catalog, in addition to tamper, repeat install,
manual removal, reinstall, partial failure, lock, and receipt checks. Nx
`workflow-runtime:knowledge-private-install-test` passed 9/9; formatting and
diff checks passed.

The host was installed from the reviewed 0.1.2 archive, rebuilt byte for byte
at SHA-256 `709783cee705373df1ba1358e0fbba703d305ee13157976e37bbcf801399d583`.
The helper reported `installed`; its subsequent status reported an installed
receipt, marketplace, and plugin. The launcher created a separate durable
Python 3.12 Registrar home and connected the exact `temari-content-registrar`
MCP entry to its new workspace. The provider selection reported
`registrar/ready`. The new workspace was empty. The older Registrar data was not
migrated or changed. No TypeSafe key was read and no Jev call was made.

## Decision and remaining gate

Keep the global collision check and 16 MiB limit. A future catalog above that
limit fails closed and will need a bounded host query that preserves global
name collision detection. Live source selection, privacy labels, capture,
retrieval, publication, and dashboard pins remain separate work. This setup is
not evidence of answer quality, lossless capture, desktop default installation,
or Windows support.
