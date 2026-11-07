# Native MCP sign-in implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Resources initiate and verify native MCP sign-ins for Pi, Claude, and Kiro while preserving the existing shared node-local connection mode.

**Architecture:** Account-managed server definitions explicitly choose shared or native authentication. Shared servers continue through the current broker. Native servers are supplied to each harness's native MCP client; Resources uses the same client and execution scope for authentication. Credentials remain in native node-local storage and never enter server-definition responses or replication.

**Tech stack:** TypeScript, Node.js, Express, existing MCP SDK, selected Pi SDK, Claude stream-json controls, Kiro ACP v2, vanilla browser JavaScript, Node tests and the isolated UI harness.

**Spec:** `docs/superpowers/specs/2026-11-05-native-mcp-sign-in.md`

## Global constraints

- Preserve strict resource isolation. Load only definitions authorized by Joint Bob, not ambient native configuration discovered as a side effect.
- Credentials are per user/runtime scope and execution node. Never replicate, extract, copy, print, or put them into agent capabilities.
- Use native client identity. No client-name spoofing, account fallback, or governance bypass.
- No model prompts are needed to inspect or authenticate MCP.
- Keep existing shared-mode definitions backward compatible.
- Verify selected Pi SDK support at the boundary; unsupported versions get an update-required error, never a silent alternate login.
- Reuse the current runtime/profile selection for the selected conversation. Do not change model pool scheduling or routing.
- Run tests through `npm run test:file`; browser tests use disposable fixture nodes, synthetic accounts, and loopback services.
- Leave unrelated edits and `.agents/knowledge/` unstaged. No branch/worktree creation.

## Review focus

- A native login succeeds but a turn uses a different config directory or selected provider profile: prove the same scope in auth and execution tests.
- A connected Claude plugin is mistaken for Pi/Kiro access: render distinct statuses and do not invent installation on other harnesses.
- A native-mode server is also emitted as a broker server: assert exclusive routing and collision behavior before spawning.
- A callback from another user, harness, node, or expired flow is submitted: reject without forwarding it or consuming the valid flow.
- Kiro governance blocks MCP, or the selected Pi SDK lacks support: expose the exact safe capability state with no sign-in attempt or silent fallback.

---

## Task 1: Establish the native client contracts

**Files:**
- Create: `test/kiro-mcp-auth-fixture.ts`
- Create: `test/pi-mcp-auth-fixture.ts`
- Reference: `src/harnesses/kiro/transport.ts`, `src/harnesses/kiro/runtime.ts`, `src/pi-sdk.ts`

**Produces:** Verified synthetic subprocess fixtures for native auth-control responses. These are prerequisites for Tasks 3 and 4, not invented successful responses.

- [ ] Record the selected Pi SDK's native MCP entry points and feature detection. The installed 1.5.0 SDK has `createMcpExtension`, `McpServerConnection`, `McpOAuthCredentialStore`, and `signInMcpServer`; the bundled fallback must not be assumed to have them. Use a disposable store and loopback OAuth server to prove sign-in, cancellation, persistence, and reconnect without a model call.
- [ ] Verify Kiro v2 ACP OAuth/startup notification payloads and MCP command argument shapes using a control-only process and a loopback OAuth server. Send no `session/prompt`. Capture field shapes, not credential values. The previous probe saw `_kiro.dev/mcp/governance_disabled`; inspect its `apiFailure` boolean before describing the cause. If governance still prevents contract verification, report that blocker and do not fabricate Kiro success fixtures or bypass policy with another account.
- [ ] Capture `/mcp`, `/mcp auth`, `/mcp cancel-auth`, and `/mcp logout` through `_kiro.dev/commands/execute`. Confirm callback handling and status completion before choosing a Kiro callback adapter. Use native APIs, not native token-file parsing.
- [ ] Convert observed exchanges into synthetic fixtures that reject unknown commands and unexpected fields. They must support denied registration, cancelled flow, lost process, and governance failure as well as success.

## Task 2: Route native definitions into real harness runs

**Files:**
- Modify: `src/mcp/store.ts`, `src/mcp/agent.ts`
- Modify: `src/harnesses/claude/resources.ts`, `src/harnesses/kiro/resources.ts`
- Modify: `src/pi-service.ts`, `src/pi-session-core.ts`, `src/pi-sdk.ts`
- Modify: `test/managed-mcp.test.ts`, `test/managed-mcp-harnesses.test.ts`

**Interfaces:**
- Add optional `authMode: "shared" | "native"` to `ManagedMcpServer`; absence means the existing shared behavior.
- Keep `managedMcpBridgeConfigs()` exclusively for shared servers and Joint Bob's built-in tool server.
- Add `nativeMcpServerConfigs(): Record<string, ManagedMcpServer>` for authorized account-local native definitions, with `authMode` stripped before delivery to native clients.
- Add explicit native MCP entries to `PiResources`. Use an explicit config loader when loading Pi's native MCP extension.

- [ ] Write failing tests proving old definitions still route through the broker and native definitions route directly, once, into each harness.
- [ ] Add failures for invalid modes, duplicate native/broker names, disabled harnesses, assistant allowlists, and unsupported selected Pi SDKs.
- [ ] Run `npm run test:file -- test/managed-mcp.test.ts test/managed-mcp-harnesses.test.ts` and inspect the expected failures.
- [ ] Implement the schema and routing changes without broadening native resource discovery. Use the same authorized definitions for auth and execution.
- [ ] Load Pi's native MCP extension only when native definitions exist, with explicit entries and the intended native credential-store scope. Keep the current broker extension for shared servers.
- [ ] Run the tests again, plus existing Pi resource-isolation and Kiro profile tests. Verify native sign-in persistence is actually consumed by a subsequent tool call, including after reopening.

## Task 3: Add native auth adapters and scoped routes

**Files:**
- Create: `src/harnesses/pi/mcp-auth.ts`
- Create: `src/harnesses/kiro/mcp-auth.ts`
- Create: `src/mcp/native-auth.ts`
- Modify: `src/server/routes/resources.ts`
- Test: `test/pi-mcp-auth.test.ts`, `test/kiro-mcp-auth.test.ts`, `test/native-mcp-auth-api.test.ts`
- Retain: `src/harnesses/claude/mcp-auth.ts` and its existing tests

**Interfaces:**
- `NativeMcpHarness = "claude" | "pi" | "kiro"`.
- Auth adapters expose `status(context)`, `start(context, serverName)`, `finish(flowId, ownerKey, callbackUrl?)`, `cancel(flowId, ownerKey)`, and `signOut(context, serverName)`, following the existing Claude adapter's return shapes.
- Extend `/api/resources/mcp/auth` and the associated mutations with `harness`, defaulting to `claude` for backward compatibility. Include explicit conversation/profile scope where required to select the same native config as a turn.
- Flow ownership binds harness, initiating user, execution/runtime scope, server, and expiry. Completion never resolves scope from the viewer's new selection.

- [ ] Write failing adapter tests for successful loopback and pasted-URL completion; invalid state/origin; cross-owner and cross-harness access; cancellation; expiry; subprocess failure; restart; and sign-out.
- [ ] Add Pi tests for a missing native SDK capability and for tokens being consumed by the selected native client without export to the broker or model.
- [ ] Add Kiro tests for the verified native notification and command formats, plus governance-disabled and governance-API-failure states. Assert no model prompt and no alternative auth path.
- [ ] Add API tests for the same account/runtime/profile directory in status, sign-in, and execution. Reject ambiguous scope rather than borrowing the node default's login.
- [ ] Run these tests and confirm expected failures before implementation.
- [ ] Implement Pi auth using the native SDK's auth and persistence code. If it must run under another runtime account, use the project's existing subprocess/worker mechanism; do not move credentials to the service process.
- [ ] Implement a control-only Kiro process using the verified contract. Keep it alive through OAuth and let native Kiro persist its credentials. Respect governance and capability failures.
- [ ] Dispatch routes by harness and preserve Claude behavior. Bound control requests and flows, sanitize errors, and clean up listeners/processes on completion or cancellation.
- [ ] Rerun adapter/API tests and `test/claude-mcp-auth.test.ts`.

## Task 4: Add per-harness controls to Resources

**Files:**
- Modify: `public/app/resources.js`, `public/app/managed-mcp.js`
- Modify: `test/ui/ui-mcp-sign-in.test.ts`, `test/ui/ui-managed-mcp.test.ts`
- Modify: `docs/mcp.md`

- [ ] Write failing UI journeys for native-mode installation, independent Pi/Claude/Kiro status, sign-in popup, pasted callback, cancellation, sign-out, and restart advice.
- [ ] Assert a Claude-only plugin never displays Pi/Kiro as connected. Switching node/project/profile must not reuse status from the prior scope.
- [ ] Assert provider rejection, unsupported Pi SDK, and Kiro governance failures remain visible beside the affected server and disable inappropriate actions.
- [ ] Run the UI files individually through `npm run test:file` and confirm expected failures.
- [ ] Add a native/shared sign-in choice to account-managed installation. Keep old installations and the current shared controls unchanged.
- [ ] Add labeled native controls for each installed harness and pass the selected scope through the auth APIs. Track statuses by scope, harness, and server, not server name alone.
- [ ] Preserve popup-blocker handling, one active UI flow, explicit cancellation, and safe callback delivery. Never put callbacks or credentials in logs or toasts.
- [ ] Update `docs/mcp.md` to explain native versus shared logins, node ownership, required restarts/reload, and provider approval limits. Do not present Figma remote access as guaranteed for an unapproved client.
- [ ] Rerun both UI journeys and inspect their actual assertions and browser errors.

## Task 5: Verify and integrate

- [ ] Run all changed MCP tests plus `test/claude-isolation-mcp.test.ts`, relevant Pi isolation tests, and Kiro runtime/profile tests.
- [ ] Run `npm run typecheck`, `npm run build`, and the full repository test command; identify unrelated failures rather than hiding them.
- [ ] Verify real native client boundaries against the synthetic OAuth service: sign in, call a read-only tool, reopen, call again, sign out, and prove the next call requires sign-in. Exercise all supported harnesses; report any unavailable live boundary explicitly.
- [ ] Obtain a fresh review of scoped changes, especially credential ownership, callback validation, strict isolation, profile selection, and native/broker name collisions.
- [ ] Check `git diff` for unrelated edits. Commit only this feature's hunks through a private index, not the shared index. Leave `.agents/knowledge/` uncommitted unless requested.
- [ ] Report fixture verification separately from real Figma approval. Do not claim all three can access Figma without a successful real read-only tool call from each requested path.
