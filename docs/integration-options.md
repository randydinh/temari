# Choose an external-service integration

Use this guide when deciding how an assistant should access a service such as
Slack. Start with the task, the user's preferences, and any working connection.
Recommend a route with reasons, provide alternatives and official setup links,
and let the user choose before configuring new access.

This guide is for the person choosing and setting up the connection. It documents
options; it does not configure a service or establish Temari host capability,
source admission, execution permission, or completion evidence. The host owns
tools and credentials; see [platform components](platform-components.md) and
[private overlays](overlays.md).

## Compare the available routes

A plugin packages capabilities and may include an MCP server and skills. MCP is
the protocol that exposes tools to an assistant. An API is a service's
programmatic interface. They can be layers of the same integration, so compare
the actual tools, authentication, and access rather than treating the labels as
competing architectures. See [OpenAI's plugin documentation](https://learn.chatgpt.com/docs/plugins)
and [Slack's MCP overview](https://docs.slack.dev/ai/slack-mcp-server/).

| Option | Advantages | Tradeoffs | Choose when |
| --- | --- | --- | --- |
| Existing desktop or browser access | Can reuse a signed-in session without setting up another integration | Loading and UI changes can affect reliability; poor fit for unattended jobs | Occasional reviews, or continuing work while a new connection is pending |
| Plugin or connector | Packaged discovery and connection flow; may include helpful workflow instructions | Exposed tools, requested permissions, supported clients, and dependencies vary by integration | The package supports the task and convenient setup matters |
| Direct official MCP | Standard agent tools; configuration and tool-selection controls in supported clients | App registration, OAuth, client compatibility, and connection maintenance may require additional work | The user prefers direct configuration or wants to avoid a particular package |
| Custom API integration | Precise endpoints and outputs for deterministic workflows | Requires code, credential handling, pagination, error handling, and maintenance | A custom recurring workflow justifies that work |

These advantages are practical judgments, not guarantees. Direct MCP is not
automatically faster, cheaper, or more secure than a plugin. Do not assume that a
particular plugin uses the provider's official MCP server or offers equivalent
tools without checking its documentation or dependencies.

## Give a recommendation and a choice

1. Establish the requested capability, frequency of use, current client, working
   connections, and user preferences. Ask only for missing facts that could
   change the decision.
2. Check the actual options. Compare complete-thread and private-content access,
   setup effort, approval requirements, granted permissions, credential handling,
   any intermediary service, rate limits, portability, and maintenance. Verify
   costs or mark them unknown.
3. State the recommended route and its reason, then explain what would make
   another route preferable. Distinguish documented support from access tested
   in this environment.
4. Offer the relevant choices and honor the user's selection. If a suitable
   connection already exists, continue the authorized task through it while a
   new setup choice is pending. Do not ask the user to choose again when their
   preference is already established.
5. Provide setup prerequisites, direct official documentation links, and a
   verification that exercises the requested content. A listed or authenticated
   connection alone does not prove that it can retrieve the needed material.

For example: for an occasional Slack thread review, recommend existing signed-in
access when it works. For frequent research, recommend a plugin if its tools and
permissions meet the user's needs and convenient setup is their priority. Offer
direct MCP when configuration control or avoiding the package matters. Recommend
a custom API when a specific automation needs deterministic behavior.

Keep the choice separate from authorization for installation, permission changes,
or external actions. Apply the host's existing approval rules. Choosing or
documenting a connection does not authorize posting messages. A discovered or
suggested plugin is not an installed, authenticated connection.

## Slack setup options

Official documentation checked on October 12, 2026. Recheck it and the installed
client's help before setup; commands, requirements, and availability can change.
Nothing below establishes a configured or approved connection in this checkout.

### Plugin

1. Open the host's Plugins browser and find Slack.
2. Review the available tools, dependencies, and requested account access.
3. If selected and authorized, install the plugin and complete its connection
   flow. Installation and authentication are separate steps.
4. Read a user-selected thread and confirm that the replies are included.

See [OpenAI's plugin installation and connection documentation](https://learn.chatgpt.com/docs/plugins).
Inspect the actual integration before claiming that its access can be limited to
reading or that it supports every client the user needs.

### Direct official MCP in Codex

Slack's server address is `https://mcp.slack.com/mcp`. Before setup, confirm an
eligible registered Slack app, the required OAuth access, and workspace approval.
Slack permits internal or Marketplace-published apps and documents its app
identity, authentication, scopes, and rate limits in the
[Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/).

1. Follow [Slack's Codex connection guide](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/#connect-to-codex)
   to establish the Slack prerequisites, including the app's client ID and
   workspace approval. Confirm that the selected app is eligible for MCP access;
   app-setting names can vary, so use Slack's current instructions rather than
   assuming that a particular server or agent toggle is available.
2. Follow [Codex's MCP configuration and OAuth guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
   for the client setup. Desktop settings support adding a Streamable HTTP
   server. For a pre-registered OAuth client, supply its client ID and register
   the exact callback displayed by Codex with Slack. Adding the server URL alone
   is not the complete setup.
3. For the desktop flow without a client secret, opt into **PKCE** under
   **OAuth & Permissions** only after reviewing and approving Slack's one-way
   setting; reversing it requires Slack support. See
   [Slack's PKCE requirements](https://docs.slack.dev/authentication/using-pkce/).
   Configure the intended user scopes, review the OAuth consent screen, and
   complete authentication. Restart or reload as directed and confirm that the
   required tools appear.
4. Retrieve a user-selected thread with its replies. Test private-channel access
   if the task needs it; do not assume access from a successful sign-in.

Slack's and OpenAI's guides currently show different CLI add examples. Check
`codex mcp add --help` and `codex mcp login --help` for the installed client before
giving or executing commands. Follow Slack's documentation for provider
requirements and Codex documentation/help for client flags and configuration.

When the integration permits it, request only the access needed for reading and
searching. Codex tool allowlists can limit what the assistant invokes, but do not
reduce an OAuth token's granted permissions. See the configuration and scope
references above.

For channel reading and searching, an explicit scoped login is:

```sh
codex mcp login slack --scopes channels:history,groups:history,search:read.public,search:read.private
```

Configure those user scopes in the Slack app before login. The CLI's initial
`mcp add` flow can request all scopes advertised by the server, including writes.
If it requests access beyond the selected task, stop before consent and restart
with the explicit scopes above. Slack also displays basic identity information
on the consent screen. Confirm the actual request before authorizing it.

Verify the selected connection on its actual host and account. This guide
preserves setup instructions; it makes no claim that a connection or private
conversation was tested as part of this documentation import.

### Custom API integration

Create or reuse an authorized Slack app, grant the required scopes, and implement
the workflow. The [conversations.replies endpoint](https://docs.slack.dev/reference/methods/conversations.replies/)
retrieves a thread using its channel and message timestamp. Handle pagination,
errors, and the documented rate limits. Verify the chosen token's access to the
specific conversation rather than assuming every bot or user token can read it.

### Existing desktop or browser access

Use available computer or browser tools to open the user-selected Slack thread
in their signed-in session. Confirm that the thread and relevant replies are
visible. If sign-in or unavailable UI access blocks the task, describe that
specific blocker and offer the connection alternatives above.

## Verify and recover

| Observed problem | Next action |
| --- | --- |
| OAuth does not complete | Check the registered callback, app identity, app eligibility, and workspace approval against Slack's connection guide |
| Connection appears but the requested tools are absent | Check token scopes, workspace restrictions, and the client's restart/reload requirements |
| Public content works but the requested private thread fails | Verify the authenticated identity's channel access and the integration's private-content scopes |
| Only part of a thread is returned | Check pagination or expand/load replies in the UI; report any remaining gap |
| API or MCP request is rate-limited | Follow the documented retry behavior; changing the integration label does not establish a higher limit |

After setup, report the selected route, authenticated workspace/account when
appropriate, the read operation actually verified, and remaining gaps. Keep
credentials out of chat and repository files. To discontinue a route, use the
host and provider's documented disconnect/revoke steps; disabling tools is not
equivalent to revoking access.
