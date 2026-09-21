# Credential profiles

When work needs application credentials or API keys, Temari follows packaged credential-profile guidance instead of collecting secrets in chat. During the Omega cutover the helper is `temari-credentials` from a Temari Omega install, not a CLI bundled in this checkout.

## Sub-features

- `cred-link` requires `skills/temari/SKILL.md` to send credential work to [`skills/temari/references/credentials.md`](../../../skills/temari/references/credentials.md).
- `cred-no-chat` forbids asking for passwords or keys in chat, tool arguments, source files, or a normal text questionnaire.
- `cred-store` puts values in the OS keyring. The private catalog defaults to `~/.config/temari/credentials/` unless `TEMARI_CREDENTIAL_HOME` or `--home` is set.
- `cred-omega-helper` resolves `<omega_root>` and runs `uv run --locked --extra credentials --project <omega_root> temari-credentials --help`.
- `cred-not-auth` treats capture as storing a secret, not authenticating it or expanding permission.

## How to get to it (user POV)

- Ask Temari to use, capture, or rotate an application credential or API key.
- Follow the packaged guide at `skills/temari/references/credentials.md` when a helper is available.
- Have the owner run a capture command in their own terminal. Agents never scan credential files or environment files to discover values.

## Driving it with control-temari

Preconditions:

- The git checkout is the revision under test.
- `control-temari doctor` reports `healthy=yes`.
- Do not print, invent, or store a real secret as proof.
- The Omega helper is optional. Missing Omega is `verified-unreachable`, not a catalog failure.

- **Linked guidance.** Confirm the conversational entry points at the reference. Run `grep -n 'references/credentials.md' skills/temari/SKILL.md` and `test -f skills/temari/references/credentials.md`. Both succeed. The Temari skill tells the agent to follow credential profiles for application credentials or API keys.
- **Catalog still loads Temari.** Run `control-temari plugin-catalog`. `skills=` includes `temari`.
- **Omega helper.** The live helper is unreachable through this checkout alone. Attempt `command -v temari-credentials` and, when Omega's root is known, `uv run --locked --extra credentials --project <omega_root> temari-credentials --help`. Unmet prerequisite: a Temari Omega installation that provides that extra. Record `verified-unreachable` rather than treating the markdown file as a successful capture.
- **Proof.** Keep the grep/test transcript with the catalog line. Do not copy `~/.config/temari/credentials/` or keyring contents into evidence.

## Gotchas

- This checkout does not ship `temari-credentials`. A missing binary is an unmet Omega prerequisite, not a broken Temari skill.
- Saving a credential does not authenticate it. List and inspect commands return metadata only.
- Never scan credential files, `.env` files, or the native store to "prove" the feature.
- `control-temari` has no credentials subcommand. Do not add secrets to `log.sh` rows or orch standing orders as a substitute.
