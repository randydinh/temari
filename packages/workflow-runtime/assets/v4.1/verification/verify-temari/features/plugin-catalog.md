# Plugin catalog

The plugin catalog is the package identity a host loads from this repository: name temari, skill tree, and agents.

## Sub-features

- `catalog-identity` reports `name`, `displayName`, and `version` from `.cursor-plugin/plugin.json`.
- `catalog-skills` lists every `skills/<name>/SKILL.md` the plugin pointer `./skills/` would load.
- `catalog-agents` lists every `agents/*.md` slug from `./agents/` (currently `comment-sicko`, `dr-eggbot`, and `poteto-agent`).
- `catalog-required` fails closed if poteto-mode, setup-pstack, poteto-agent, or comment-sicko is missing. `dr-eggbot` is catalogued from disk but is not a doctor required-file check.

## How to get to it (user POV)

- Load the repository through the host's normal plugin or skill installation path.
- Open plugin details and read the published name `temari` and its skill list.

## Driving it with control-temari

Preconditions:

- The git checkout is the revision under test.
- `control-temari doctor` reports `plugin_name=temari` and `healthy=yes`.
- No orch store is required. Catalog inspection is read-only.

- **Read identity.** Ask the catalog who it is. Run `control-temari plugin-catalog`. Stdout contains `name=temari`, `displayName=temari`, `version=0.15.2` (or the `version` field currently in `.cursor-plugin/plugin.json`), `skills_ptr=./skills/`, and `agents_ptr=./agents/`.
- **List skills.** Continue from that stdout. `skills=` includes the public entry skills `temari`, `poteto-mode`, and `closeout`, plus `setup-pstack`, `create-verification-skill`, `show-me-your-work`, and `automate-me`. `skill_count` matches the number of `skills/*/SKILL.md` files.
- **List agents.** `agents=` is the sorted `agents/*.md` slugs (`comment-sicko,dr-eggbot,poteto-agent` on this tree) and `agent_count` matches that count (3 here). Assert the live files, not a remembered count, if an agent is added or removed.
- **Doctor required files.** Run `control-temari doctor`. Output includes `check` failures only when a required file is missing; on a healthy tree the command exits 0 with `healthy=yes`.
- **Proof.** Save the catalog transcript. Run `control-temari capture 01-plugin-catalog -- plugin-catalog`. `01-plugin-catalog.stdout.txt` still contains `name=temari` after you re-read it. Confirm it matches `.cursor-plugin/plugin.json` rather than a remembered version string.

## Gotchas

- Host-native plugin loading is not automatable from this harness. Catalog proof is the manifest and file tree that a host would load, not a click in plugin settings.
- Host adapter installs (`adapters/*/`, `scripts/install-host.sh`) are a separate user path. `plugin-catalog` scans the package-root `skills/` and `agents/` trees, not adapter stub copies.
- Skill folder names and YAML `name:` fields are not always identical (`poteto-mode` vs `Poteto Mode`, `make-bot-ui` vs `Make Bot UI`). Assert folder names from `plugin-catalog` unless the feature under test is frontmatter.
- `version` in `plugin.json` is `0.15.2` at the import this map was written against. Assert the live file, not this sentence, if the version field moved.
- Do not treat `skills/` as the verification directory. The plugin pointer is `./skills/` at the repo root. The verifier lives under `verification/verify-temari/` and is repository-owned.
