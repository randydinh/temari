# Credential profiles

Use the credential helper supplied by the active Temari installation. During the
current Omega cutover, `temari-credentials` is provided by Temari Omega. Resolve
`<omega_root>` from that installation before running:

```sh
uv run --locked --extra credentials --project <omega_root> temari-credentials --help
```

Read `<omega_root>/docs/credentials.md` for the current command schema. Values go
into the OS keyring. The private catalog defaults to
`~/.config/temari/credentials/` for the current OS user, independently of the
repository. An explicit `TEMARI_CREDENTIAL_HOME` or `--home` changes the catalog.
Never scan credential files, environment files, or the native store to discover
values.

When a credential is missing, prepare a capture command with the agreed profile,
service, environment, work or personal scope, exact HTTPS origin, and account
alias. Have the owner run it in their terminal. The helper hides and confirms
every credential field. Never ask for passwords or keys in chat, tool arguments,
source files, or a normal text questionnaire. Saving a credential does not
authenticate it or grant permission to use it. List and inspect commands return
metadata only.

Use profile references in worker requests. A trusted adapter may call
`CredentialStore.resolve` with the exact intended context and the host's existing
authorization callback. Carry forward the owner's current permission, including
read-only restrictions. Do not substitute a constant allow callback or treat a
worker name as an authenticated identity. The host policy handles grant scope,
expiry, and revocation. If no adapter is configured, prepare one for the selected
operation. Do not print the secret as a workaround.

Never return credential material as a tool result. Keep secret values inside the
trusted consumer and retain only selected non-sensitive assertions. The consumer
must verify destinations and redirects and enforce allowed application actions.
Credential metadata cannot do that. Agents sharing an OS user are not isolated
by this library.

Select production and test profiles separately. Do not infer permission from
account privilege, use a production fallback, migrate plaintext credentials
automatically, or inject credentials into `worker-run` or its inherited
environment. Local rotation and removal affect the stored copy only. Remote
changes need their own authorized workflow. The host-worker local-investigation
contract remains unchanged.
