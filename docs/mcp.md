# MCP servers in Joint Bob

Open **Settings → Resources → MCP servers → Add MCP servers** on the machine where the conversation runs.

- Enter a name and a remote streamable HTTP URL, or paste a JSON object containing several `mcpServers` entries.
- Choose **Install for all three agents** and confirm. The MCP client ships with Joint Bob; Pi needs no separately installed extension or package.
- Start a new conversation after installing. Existing Pi conversations can use `/reload` to reload tools.

For Figma, use the name `figma` and URL `https://mcp.figma.com/mcp`. If a native Figma server is already installed, remove the duplicate or choose a different name. Existing native/plugin MCP configurations and their Claude-only sign-ins remain separate; importing a server does not extract or copy native OAuth credentials.

## Sign in once on each machine

Choose **Check shared connections**, then **Sign in** beside the server. Approve access in the new browser tab, return and choose **Done**. If the browser ends at a localhost address it cannot reach, paste that full redirect address into Joint Bob's sign-in field and choose **Done**. Do not paste this address into a conversation.

The saved sign-in works for Claude, Pi and Kiro running for that same user on that same machine. Another user, or the same user on another machine, must sign in separately. Tokens and installed definitions live in node-local, per-account storage and are not replicated. Agents receive a conversation-scoped capability, not the upstream OAuth credentials.

After signing in, reopen an existing native harness conversation or use `/reload` in Pi if it previously reported a connection error. Sign out closes the shared connection and removes that account's saved OAuth credentials. Removing a server removes its saved sign-in too. Signing out does not revoke static headers explicitly supplied in the server definition.

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

Remote servers use HTTPS, or HTTP on loopback for local services. Legacy SSE is not supported. Local commands run with the installing user's runtime permissions; install only servers you trust. `command` is an executable, not a shell command string. Definitions accept literal `args`, `env`, `cwd` and HTTP `headers`. Shell commands and environment-variable interpolation in configuration values are not evaluated.

OAuth servers must support dynamic client registration for Joint Bob, or provide registered client details under `oauth.clientId` and optional `oauth.clientSecret`. A provider can reject unapproved clients; the UI reports sign-in failure rather than borrowing another client's identity or credentials. Real Figma approval is a separate live-account check; automated tests use a local OAuth fixture.

## Access and errors

Per-harness activation and personal assistant MCP allowlists are checked on every broker request, including requests from an already-open harness. Server removal and conversation capability revocation prevent subsequent calls. Tool mutations are not automatically replayed after an uncertain failure.

Tools and image results are supported. The bridge does not currently expose MCP resources, prompts or embedded MCP Apps. A connection failure is visible in Resources; Pi also exposes a connection-status tool rather than silently dropping the server. Upstream error details and stdio stderr are not exposed because they may contain credentials.
