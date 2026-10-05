# Private Knowledge installer: bounded Codex catalog query

## Hypothesis and observed failure

The private 0.1.2 installer queried every available Codex plugin to inspect one
local marketplace. On a macOS host with a large remote catalog, that JSON exceeded
the helper's 2 MiB subprocess buffer. Installation stopped before any marketplace,
plugin, or Knowledge home was created.

## Change and verification

The helper now reads the global **installed** list for name collisions and the
`temari-knowledge` marketplace's bounded available list for its own plugin. It
rejects a filter response containing another marketplace. The synthetic CLI
fixture verifies the scoped call, refuses an installed plugin with the same name
from another marketplace, and retains tamper, repeat install, manual removal,
reinstall, partial failure, lock, and receipt checks. Nx
`workflow-runtime:knowledge-private-install-test` passed 8/8; formatting and
diff checks passed.

The host was then installed from the reviewed 0.1.2 archive, rebuilt byte for byte
at SHA-256 `709783cee705373df1ba1358e0fbba703d305ee13157976e37bbcf801399d583`.
The patched helper reported `installed`; its subsequent status reported an
installed receipt, marketplace and plugin. The installed launcher created a new
durable Python 3.12 Registrar home and connected the exact `temari-content-registrar`
MCP entry to its new workspace. The provider selection reported `registrar/ready`.
The new workspace contained no source files or registrations. The older Registrar
data was not migrated or changed. No TypeSafe key was read and no Jev call was made.

## Decision and remaining gate

Keep the scoped query. A global **installed** list is still read to detect a
same-name collision; a much larger installed set could need a further bounded
API. Live source selection, registered-source privacy labels, capture, retrieval,
publication, and dashboard pins remain separate work. This setup is not evidence
of answer quality, lossless capture, desktop default installation, or Windows
support.
