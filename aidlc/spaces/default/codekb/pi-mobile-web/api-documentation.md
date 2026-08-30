# API Documentation

## Surfaces

Joint Bob exposes four API surfaces and consumes three more.

| Direction | Surface | Location |
|---|---|---|
| Inbound | HTTP REST over Express | `src/server.ts` — 105 explicit `app.<verb>()` handlers, 2 registered in a loop, 5 `app.use` mounts |
| Inbound | WebSocket, single endpoint | `new WebSocketServer({ server, path: "/ws" })` |
| Inbound | Claude hook events | posted by the hooks installed by `scripts/install-claude-hooks.mjs`, ingested by `src/claude-runtime.ts` |
| Outbound | Peer-to-peer HTTP | `fetch` with `Authorization: Bearer <machine token>` and `AbortSignal.timeout` |
| Outbound | Process API — `claude` CLI | `claude -p --output-format stream-json --verbose --include-partial-messages …` |
| Outbound | SDK — Pi agent | `@earendil-works/pi-coding-agent` `SessionManager` / `AgentSession` |
| Outbound | Syncthing REST | `/rest/...` with `X-API-Key` |

All request bodies are validated with **zod**. Errors funnel through one terminal `app.use((error, ...))` handler.

## HTTP Authentication Classes

Three classes, enforced by middleware:

### Unauthenticated

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/status` | whether first-run setup has happened |
| `GET` | `/api/health` | liveness |
| `POST` | `/api/auth/setup` | first-run password creation |
| `POST` | `/api/auth/login` | password login, issues the session cookie |
| `GET` | `/favicon.ico` | static |
| `GET` | static assets | `express.static` over `public/` |

### User session — signed cookie plus CSRF middleware

Everything else under `/api/` that is not `/api/cluster/*`. Grouped by domain:

| Group | Representative routes |
|---|---|
| Auth | `/api/auth/*` beyond the unauthenticated four |
| Preferences and settings | per-user preferences, node settings |
| Audit | audit log read |
| Engines | harnesses and models listing |
| Projects | project CRUD, project types, `GET /api/projects/:id/file` |
| Sessions | `/api/projects/:id/sessions` and its sub-routes |
| Reviews | `GET /api/reviews/pending`, `POST /api/projects/:id/sessions/reviewed`, `POST /api/projects/:id/sessions/reviewed-all` |
| Tasks | `/api/projects/:id/tasks` and its sub-routes |
| Secrets | encrypted secret CRUD |
| GitHub auth | GitHub credential group CRUD |
| Push | web push subscription registration |
| Skills | skill discovery |
| Cluster admin | `POST /api/cluster/invite`, `GET /api/cluster/node`, `GET /api/cluster/peers` |
| Filesystem | `/api/filesystem/directories` — registered through a loop, not a literal `app.get` |

One session route carries an engine restriction relevant to the active intent:

| Method | Path | Restriction |
|---|---|---|
| `POST` | `/api/projects/:projectId/sessions/recover` (`src/server.ts:2700`) | throws `"Only Pi transcripts support conflict recovery"` for a `claude:` path. This is a **distinct** limitation from the three transfer gates — Syncthing conflict recovery is implemented only for Pi transcripts in `src/session-paths.ts`. |

### Machine — `Authorization: Bearer <machine token>`

Roughly 40 routes under `/api/cluster/*`. The middleware compares tokens with `timingSafeEqual` and sets `response.locals.machineAuth`.

| Group | Routes |
|---|---|
| Membership | membership snapshot exchange, tombstones |
| Replication | replication event push/pull |
| GitHub credentials | GitHub credential replication events |
| Tasks | eligibility, prepare, commit, settle, abort, handoff, merge, archive, delete |
| Projects | project import, map, discover |
| Sync | sync share |
| Filesystem | `/api/cluster/filesystem/directories` (loop-registered), project-file read, project-file write |
| **Ownership and transfer** | see the dedicated table below |

## Conversation Ownership and Transfer API

This is the contract the `260830-claude-session-transfer` intent extends. **All of it is already engine-agnostic on the server side.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/cluster/sessions/ownership` | machine | read current ownership rows |
| `POST` | `/api/cluster/sessions/ownership/claim` | machine | claim ownership of a conversation |
| `POST` | `/api/cluster/sessions/ownership/claim/cas` | machine | compare-and-set claim at an expected epoch — the fencing primitive |
| `POST` | `/api/cluster/sessions/ownership/claim/commit` | machine | commit a fenced claim |
| `POST` | `/api/cluster/sessions/ownership/apply` | machine | apply a replicated ownership event |
| `POST` | `/api/cluster/sessions/transfer` | machine | routed transfer request; 35s client timeout |
| `POST` | `/api/cluster/sessions/take-ownership` | machine | forced takeover of an unreachable owner; 35s client timeout |
| `POST` | `/api/cluster/sessions/receive` | machine | destination-side receive; 30s client timeout |

### Contract of `POST /api/cluster/sessions/receive`

Handler at `src/server.ts:2668`. Sequence:

1. Validate the payload with zod. The payload carries `engine`, so the handler **already branches on `payload.engine`**.
2. Call `resolveLocalSessionPath` to re-root the sender's session path under this node's home directory.
3. `await access(localPath, fsConstants.R_OK)` — a readability check that currently succeeds for Claude only because Syncthing mirrors `~/.claude` wholesale (`CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude"`, `src/syncthing.ts:41`).
4. Branch: `createPiSession` for `engine === "pi"`, `loadClaudeMessages` for `engine === "claude"`. `loadClaudeMessages` validates only that the path is inside `claudeProjectsRoot()`.
5. Acknowledge.

Test hook: `src/server.ts:2691` reads `JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE` and destroys the socket mid-receive, guarded by `NODE_ENV === "test"`. `test/conversation-ownership-mesh-api.test.ts` uses it to exercise a dropped acknowledgement across two real nodes.

### Contract of `takeLocalSessionOwnership`

Not a route in itself but the function behind `POST /api/cluster/sessions/take-ownership`, at `src/server.ts:2469`. It currently throws `TaskWorktreeError("Only Pi conversations can be taken over")` for any `claude:` path, and hardcodes `"pi"` in its subsequent `conversationIsActive(project.id, "pi", …)` and `takeConversationOwnership("pi", …)` calls. Both helpers it depends on — `conversationIsActive` (`src/server.ts:2428`) and `conversationSessionIsOpen` (`:2434`) — **already handle `engine === "claude"` correctly** via `activeClaudeConnections`.

## WebSocket API

One endpoint, `/ws`, multiplexing three logical channels: chat (Pi or Claude), project watch, and terminal. Sockets addressed at a peer node are proxied verbatim by `proxySocket`.

### Client to server

| Message | Channel | Purpose |
|---|---|---|
| `prompt` | chat | send a user turn |
| `abort` | chat | cancel the in-flight turn |
| `setModel` | chat | change the model |
| `setEffort` | chat | change the effort level |
| `models` | chat | request the available model list |
| `setThinking` | chat | toggle extended thinking |
| `rename` | chat | rename the conversation |
| `switchEngine` | chat | move the conversation between Pi and Claude |
| `terminalInput` | terminal | keystrokes to the pty |

### Server to client

| Message | Channel | Purpose |
|---|---|---|
| `textDelta` | chat | streamed assistant text |
| `thinkingDelta` | chat | streamed reasoning |
| `toolStart` | chat | a tool invocation began |
| `toolEnd` | chat | a tool invocation finished |
| `userMessage` | chat | echo of a user turn |
| `agent_start` | chat | the agent run began |
| `agent_end` | chat | the agent run finished |
| `assistantError` | chat | the agent errored |
| `sessionFile` | watch | the transcript file changed |
| `queueUpdate` | chat | queued-prompt state |
| `status` | chat | run status |
| `sessionsChanged` | watch | the project's session list changed |
| `tasksChanged` | watch | the project's task list changed |
| `updatePreparing` | watch | a service update is staging |
| `terminalOutput` | terminal | pty output |
| `terminalReady` | terminal | pty attached |
| `terminalExit` | terminal | pty ended |

Terminal framing is implemented in `src/terminal-session.ts`.

## Outbound Peer HTTP Contract

Every peer call is a `fetch` carrying `Authorization: Bearer <machine token>` and an explicit `AbortSignal.timeout`. The budgets are per-operation and encode the expected latency of each:

| Operation | Timeout |
|---|---|
| Ownership probe | 3 s |
| Session receive | 30 s |
| Routed transfer / takeover | 35 s |
| Inventory | 10 s |

The 35 s routed budget deliberately exceeds the 30 s receive budget so that a routing node outlives the receive it is waiting on.

## Outbound Process and SDK APIs

### `claude` CLI

Spawned as a subprocess with:

```
claude -p --output-format stream-json --verbose --include-partial-messages
       <permission-mode flag>
       [--resume <sessionId> | --session-id <sessionId>]
       [--model <model>] [--effort <effort>]
```

Driven from `runClaudeTurn` / `handleClaudeCommand` (`src/server.ts:3921`-`4060`). `runClaudeTurn` passes `resumeSessionId: connection.claude.sessionId` while spawning with `cwd: connection.cwd`. **`claude --resume <id>` locates the transcript through the directory derived from that cwd** — which is the mechanism the transferred-path gap breaks.

Session listing and transcript parsing live in `src/claude-service.ts`: `listClaudeSessions` (line 177) enumerates `claudeProjectDirs(project, claudeProjectsRoot())`; `loadClaudeMessages` reads a transcript after validating it is inside `claudeProjectsRoot()`. Concurrency is bounded by `CLAUDE_LIST_CONCURRENCY`, whose source comment records a 1 GB memory peak on a 340-file project.

### Pi agent SDK

`@earendil-works/pi-coding-agent` used in-process through `SessionManager` and `AgentSession`, wrapped by `src/pi-service.ts` which also handles model selection and message simplification.

### Syncthing REST

`src/syncthing.ts` calls `/rest/...` endpoints with an `X-API-Key` header to provision folders and ignore patterns. The engine folder constants and ignore policy sit at `src/syncthing.ts:40`-`145`, including `CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude"` at line 41 with path `~/.claude`.

### Git

Invoked via `execFile` — no shell interpolation — from `src/worktrees.ts` and `src/tasks.ts`.

### User shell

`src/terminal-session.ts` spawns the user's `$SHELL` for the terminal channel.

## Internal Module API Surface

Roughly 180 exported functions and types across `src/`. The exports most relevant to the active intent:

| Module | Export | Signature note |
|---|---|---|
| `src/conversation-ownership.ts` | `ConversationEngine` | `"pi" \| "claude"` |
| | `claimConversationOwnership` | takes `engine`; no Pi branch |
| | `beginConversationTransfer` | takes `engine`; no Pi branch |
| | `commitConversationTransfer` | takes `engine`; no Pi branch |
| | `takeConversationOwnership` | takes `engine`; no Pi branch |
| | `beginConversationRecovery` | takes `engine`; no Pi branch |
| | `applyConversationOwnershipEvent` | takes `engine`; no Pi branch |
| | `ownershipPayload` | zod validator accepting both engines |
| `src/session-paths.ts` | `resolveLocalSessionPath` (line 17) | splits at the last `.claude` segment, re-roots the whole suffix |
| | `claudeProjectDir` | encoding `cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-")` |
| | `claudeProjectDirs` (line 49) | returns **multiple** directories — one per `sessionCwd` plus each parent; default root `~/.claude/projects` |
| | `recoveryDiagnostic` | hardcodes `localNodeId: "local"` |
| `src/claude-service.ts` | `claudeProjectsRoot()` | settings-aware, honours `settings.claude.sessionPath` / `configPath` |
| | `listClaudeSessions` (line 177) | enumerates `claudeProjectDirs(project, claudeProjectsRoot())` |
| | `loadClaudeMessages` | validates path is inside `claudeProjectsRoot()` |
| `src/watcher.ts` | `sessionWatchDirs` (line 33) | calls `claudeProjectDirs(project)` with **no root argument** |
| `src/app.ts` | `{ app, createApp }` | one-line re-export, the test entry point |
