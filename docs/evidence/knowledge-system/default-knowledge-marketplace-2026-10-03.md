# Private Knowledge marketplace default policy candidate

The private Content Registrar Knowledge marketplace now requests
`INSTALLED_BY_DEFAULT` for its single local plugin, and the plugin version moves
from `0.1.1` to `0.1.2`. [OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins)
lists this installation policy and describes marketplace metadata as controlling
ordering and installation policies in the ChatGPT desktop app. This is a policy
request for a recipient who has added the private marketplace; it is not proof
that every Temari installation contains the plugin.

The two delivery choices have different scopes:

| Choice | What it changes | Current evidence and limit |
| --- | --- | --- |
| Marketplace default policy | Requests installation when a supported host processes the private catalog. Keeps the plugin independent and removable. | An isolated macOS Codex CLI probe with a modified `0.1.1` catalog did **not** install the plugin after `codex plugin marketplace add .` alone. The release README therefore keeps `codex plugin add content-registrar-knowledge@temari-knowledge` as the tested CLI step. Desktop behavior is unverified. |
| Temari installer fetch | Would obtain the plugin as part of a Temari install. | This would require a durable authorized distribution source, version pin, host-specific install and removal tests, and explicit treatment of the external Knowledge home. It is outside this policy-only increment. |

Python setup remains an explicit command after plugin installation. No key is
bundled or read, and local-only Registrar intake and BM25 retrieval require no
Jev request. The TypeSafe Jev policy and registered-source/local-only boundary
are unchanged.

Test-first, the version assertion failed on the existing `0.1.1` artifact.
With a synthetic `0.1.2` plugin artifact derived from a clean `0.1.1` artifact
for candidate verification, the Nx `workflow-runtime:knowledge-release-test`
target passed **12/12**. It verified the new catalog, README wording, and
successor packaging against the externally pinned `0.1.1` archive SHA256
`6859336960a6eca0c608ad2fb3a276ba8ef0df4df58e48f995ea3081897081b6`.
The Nx `workflow-runtime:knowledge-plugin-test` target passed **2/2**,
including relocated actual Registrar local-only intake and cited BM25 search.
The synthetic artifact is not a release. A clean `0.1.2` artifact, its digest,
and recipient installation checks must be recorded after the source commit.

This increment does not prove desktop default installation, native Windows
operation, public distribution rights, or a production lossless knowledge
system.
