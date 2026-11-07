# Native MCP sign-in in Resources

## Approved goal

The user asked to let Pi and Kiro sign in to MCP servers, either through a supported shared login on the same node or their own native sign-ins. MCP credentials must remain local to the user and execution node. A connected Claude plugin is not proof of Pi or Kiro access.

## Current evidence

- Shared account-managed MCP connections already serve all three agents through `src/mcp/agent.ts` and the broker in `src/server/routes/managed-mcp.ts`.
- `src/server/routes/resources.ts` and `public/app/resources.js` expose native sign-in only for Claude.
- The installed Pi 1.5.0 SDK supports native MCP connections, OAuth, refresh locking, callbacks, and an extension with an explicit `loadConfig` callback. `src/pi-session-core.ts` currently loads the shared broker extension, not that native extension. The bundled fallback dependency is 0.87.1, so availability must be checked against the selected SDK, not assumed.
- Joint Bob launches Kiro ACP v2. Kiro documents `_kiro.dev/mcp/oauth_request`, `_kiro.dev/mcp/server_initialized`, and `_kiro.dev/commands/execute`; native `/mcp auth`, `/mcp cancel-auth`, and `/mcp logout` exist. `src/harnesses/kiro/runtime.ts` currently drops MCP-specific notifications.
- A control-only Kiro probe on 2026-11-05, with no model prompt, returned `_kiro.dev/mcp/governance_disabled` and `/mcp` returned `{success:true,data:{servers:[],message:"No MCP servers configured",mode:"status"}}`. A follow-up probe captured `apiFailure:true`, so this is failure to retrieve governance settings, not proof of an administrator denial. `kiro-cli whoami` reported an existing IAM Identity Center login, profile `KiroProfile-us-east-1`. The V2 command catalog advertised only list/add/remove for `/mcp`, not the auth/logout/cancel-auth commands described in current documentation. OAuth event field shapes and supported MCP command argument shapes still need a verified native protocol contract before implementing their parser.
- Figma's remote-server documentation restricts access to catalog-approved clients. Joint Bob's registration received 403. Native support is not a promise that Figma will approve a particular client. Do not spoof another client's identity, extract another client's credentials, or silently fall back to it.

## Implementation choices

These are implementation choices, not additional user requirements:

1. Preserve existing shared connections and their sign-in UI. Add an explicit native-sign-in option when installing an account-managed MCP server. Existing definitions retain shared behavior.
2. Native-mode definitions remain account-owned and node-local. Feed the same authorized definitions into real harness runs and auth checks. Do not enable ambient machine resource discovery.
3. Show native status and sign-in controls per harness, keyed by execution node, user/runtime scope, harness, and server. A plugin-only row continues to describe only its owning harness.
4. Use native code for OAuth and persistence. Pi's SDK owns Pi OAuth; Claude's existing control process owns Claude OAuth; Kiro's ACP process owns Kiro OAuth. No token extraction, copying, or server-side OAuth reimplementation under another client's name.
5. Resolve the same configuration directory and runtime/profile context used by the intended conversation. A login for another profile must not appear connected for this profile. An ambiguous scope must be explicitly selected, not guessed.
6. On older Pi versions without native MCP support, show an actionable update-required state. Preserve the existing shared option; never silently switch modes.
7. Surface Kiro governance failures and unavailable native controls as explicit states. Do not start OAuth or attempt an alternative native account to bypass governance.
8. Sign-in flows are owned by their initiating user and scope. Cancellation, expiry, sign-out, and subprocess shutdown clean up listeners and pending requests. Pasted callback URLs must be checked against the active flow before delivery to the native client.
9. Keep errors beside the affected server, rather than only in a short-lived toast. Do not expose tokens, authorization codes, secrets, or raw credential-bearing upstream diagnostics.

## Verification

Use disposable HOME/data directories, synthetic identities, loopback MCP/OAuth services, and fake Claude/Kiro control processes for automated tests. Verify actual tool access after sign-in, not only a status label. Cover cross-user and cross-scope denial, cancellation, stale callbacks, denied registration, unsupported versions, Kiro governance, restart/refresh, sign-out, and native versus broker routing.

Native Kiro wire-contract verification is a prerequisite, not a license to invent successful fixture responses. Live Figma sign-in requires a separate user-approved provider check and must be reported separately from fixture results.

## Boundaries

No changes to scheduled-task, webhook, assistant model-profile/pool routing. No credential replication. No worktree or branch creation. No disabling strict resource isolation. No edits to unrelated shared-tree changes.
