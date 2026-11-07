# MCP servers in Joint Bob

Open **Settings → Resources → MCP servers → Add MCP servers** on the machine where the conversation runs.

- Enter a name and a remote streamable HTTP URL, or paste a JSON object containing several `mcpServers` entries.
- Choose shared connections for all three agents, or **Native Pi OAuth · Pi only**, then install and confirm. Neither option requires an external Pi plugin.
- Start a new conversation after installing. Existing Pi conversations can use `/reload` to reload tools.

For Figma, use the name `figma` and URL `https://mcp.figma.com/mcp`. If a native Figma server is already installed, remove the duplicate or choose a different name. Existing native/plugin MCP configurations and their Claude-only sign-ins remain separate; importing a server does not extract or copy native OAuth credentials.

## Sign in once on each machine

Choose **Check connections**, then **Sign in** beside the server. Approve access in the new browser tab, return and choose **Done**. If the browser ends at a localhost address it cannot reach, paste that full redirect address into Joint Bob's sign-in field and choose **Done**. Do not paste this address into a conversation.

The saved sign-in works for Claude, Pi and Kiro running for that same user on that same machine. Another user, or the same user on another machine, must sign in separately. Tokens and installed definitions live in node-local, per-account storage and are not replicated. Agents receive a conversation-scoped capability, not the upstream OAuth credentials.

After signing in, reopen an existing native harness conversation or use `/reload` in Pi if it previously reported a connection error. Sign out closes the shared connection and removes that account's saved OAuth credentials. Removing a shared-mode server removes its saved shared sign-in too. Signing out does not revoke static headers explicitly supplied in the server definition.

## Native Pi OAuth

Native mode uses the selected Pi SDK's own MCP client, OAuth registration, refresh and credential storage. It requires a Pi version with native MCP support, verified with 1.5.0. Older bundled Pi versions show an update-required error. Update the Pi harness in Settings; Joint Bob never silently switches a native server to the shared client.

Choose the intended project scope in Resources before signing in. The control-only sign-in worker runs in that project's OS runtime, exactly like its Pi conversations. Account-scoped setup uses your account's runtime. Grants are stored under `joint-bob-mcp/<account-hash>/mcp-auth.json` in that runtime's Pi agent directory. They are separate from model-provider profiles, other users, other runtimes and other nodes. OAuth callbacks remain bound to the person and runtime that started the flow, even if the Resources selection changes.

Native installations appear for Pi only. Claude's existing native/plugin controls and shared connections are unchanged; Kiro native OAuth is not enabled. Pi loads only Joint Bob-authorized native definitions through an explicit SDK configuration loader, not ambient `mcp.json` files. Personal assistant allowlists and activation decisions filter definitions when a session loads them. Reload or reopen Pi after changing those permissions. Tool calls still pass through Pi's tool pipeline and Guardian.

The native Sign in, Done, Cancel and Sign out controls use the SDK without sending a model prompt. After sign-in, reopen Pi or use `/reload` to discover the server's tools. Sign out deletes the grant for the selected runtime scope. Removing a native definition prevents future loads but does not erase grants in other runtimes; sign out in each relevant scope before removal. Static authorization headers are configuration, not an OAuth grant, and are unaffected by sign-out.

Native mode uses Pi's client identity. Some providers reject it. Joint Bob reports the failure without impersonating Claude, copying another client's login, or falling back to shared auth. Automated verification uses synthetic loopback services, not a claim of real Figma approval.

## Bulk configuration

```json
{
  "mcpServers": {
    "figma": { "url": "https://mcp.figma.com/mcp" },
    "local-tools": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"]
    }
  }
}
```

Remote servers use HTTPS, or HTTP on loopback for local services. Legacy SSE is not supported. Local commands run with the installing user's runtime permissions; install only servers you trust. `command` is an executable, not a shell command string. Shared definitions accept literal `args`, `env`, `cwd` and HTTP `headers`; their values are not evaluated. Native mode passes its configuration to Pi's SDK, which supports its own environment-variable and command expansion rules. Install only trusted definitions.

OAuth servers must support dynamic client registration for Joint Bob, or provide registered client details under `oauth.clientId` and optional `oauth.clientSecret`. A provider can reject unapproved clients; the UI reports sign-in failure rather than borrowing another client's identity or credentials. Real Figma approval is a separate live-account check; automated tests use a local OAuth fixture.

## Access and errors

Per-harness activation and personal assistant MCP allowlists are checked on every broker request, including requests from an already-open harness. Server removal and conversation capability revocation prevent subsequent calls. Tool mutations are not automatically replayed after an uncertain failure.

Tools and image results are supported. The bridge does not currently expose MCP resources, prompts or embedded MCP Apps. A connection failure is visible in Resources; Pi also exposes a connection-status tool rather than silently dropping the server. Upstream error details and stdio stderr are not exposed because they may contain credentials.
