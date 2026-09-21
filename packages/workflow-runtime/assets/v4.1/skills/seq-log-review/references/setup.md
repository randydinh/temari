# Connect Codex to Seq for read-only review

Use the organization's existing Seq MCP when it is already registered on the Codex host and its read-only surface can be verified. Otherwise install Datalust's official `seqcli` MCP server and skills. Keep the Seq URL and API key in host-owned configuration. Do not add them to a repository or paste them into a task.

## Check for the existing provider first

1. Run `codex mcp list` and inspect `/mcp` in Codex.
2. If an organization-managed Seq server is present, verify its registration or metadata identifies Seq and its tool descriptions cover only the required read operations for this workflow.
3. Confirm its credential has only Seq `Read` permission. Do not replace a working approved provider with `seqcli` merely because the server name differs.
4. If the provider is registered in another application or project only, add the equivalent registration to the Codex host through the normal host configuration process. A registration in Cursor, Claude, or another repository is not automatically available to Codex.

## Install seqcli and its skills

1. Install the current `seqcli` release for the host operating system and architecture. Datalust publishes self-contained archives on the GitHub release page. Verify the archive's SHA-256 digest against the digest in the GitHub release metadata before extracting it.

   Datalust also documents a .NET global-tool installation. If that package is valid for the current release, this command is sufficient:

   ```bash
   dotnet tool install --global seqcli
   seqcli version
   ```

   If the .NET command reports a missing or invalid `DotnetToolSettings.xml`, do not retry with an older version by guesswork. Install the matching self-contained archive from the official release instead, verify its published digest, and run `seqcli version`.

2. Ask a Seq administrator for an API key with only the Seq `Read` permission. Do not use a write-capable key.

3. Put the connection values in a secret manager or trusted launcher that sets these environment variables for Codex.

   ```text
   SEQCLI_CONNECTION_SERVERURL
   SEQCLI_CONNECTION_APIKEY
   ```

   Datalust notes that `seqcli` configuration stores API keys in plain text on macOS and Linux. Prefer injected environment variables on those systems.

4. Install Datalust's skills into the generic agent skill directory that Codex can discover.

   ```bash
   seqcli skills install --global
   ```

   Datalust documents named targets such as Claude and a generic default for other agents. Do not pass an undocumented `codex` target.

## Configure the local MCP server in Codex

`seqcli mcp install` does not currently list Codex as a named target. Register the verified executable directly with Codex. Use its absolute path so the registration does not depend on the shell's `PATH`.

```bash
codex mcp add seq -- /absolute/path/to/seqcli mcp run
```

The equivalent user-level `~/.codex/config.toml` entry is:

```toml
[mcp_servers.seq]
command = "/absolute/path/to/seqcli"
args = ["mcp", "run"]
env_vars = ["SEQCLI_CONNECTION_SERVERURL", "SEQCLI_CONNECTION_APIKEY"]
```

`env_vars` forwards values from the environment that launched Codex. It does not store the values in this file. Do not put the API key in a literal `[mcp_servers.seq.env]` table.

Restart the ChatGPT desktop app, Codex CLI, or Codex IDE extension after the change. These clients share the MCP configuration for the same Codex host.

## Verify the connection

1. Run `codex mcp list`. Confirm that the chosen Seq provider is enabled.
2. Open `/mcp` in Codex. Confirm that the Seq server connects and exposes read tools. Confirm that Codex discovers the `seq-search-and-query` skill.
3. In an authorized non-production Seq instance, ask Codex to list relevant saved signals for a 30-minute window. Confirm that the request performs no mutation and does not return full event bodies.
4. Ask Temari for a bounded Seq log review. The result must include the window, coverage, evidence references, and verification steps.

Do not claim end-to-end verification from configuration inspection alone. A live smoke test requires an authorized non-production Seq instance and a read-only key.

Official references include [Datalust's AI coding agents guide](https://datalust.co/docs/ai-coding-agents), [Datalust's seqcli command reference](https://datalust.co/docs/command-line-client), [Seq HTTP API guidance](https://datalust.co/docs/using-the-http-api), [Seq server endpoints](https://datalust.co/docs/server-http-api), and [OpenAI's Codex MCP configuration guide](https://developers.openai.com/codex/mcp). The HTTP API references are for verifying an organization-managed provider boundary; this review skill does not use direct HTTP as a fallback.
