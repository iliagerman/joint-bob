# API documentation

## API overview

`src/server.ts` registers 83 method/path combinations under `/api` plus one WebSocket endpoint at `/ws`. The browser uses a secure SQLite-backed session cookie and a CSRF header for state-changing requests. Selected machine routes also accept a bearer token compared with `timingSafeEqual`.

Zod validates HTTP and WebSocket input. Responses are handwritten JSON; file download streams bytes. There is no OpenAPI, AsyncAPI, exported JSON Schema, generated client, or formal versioning scheme.

## REST routes

### Authentication and account state

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/status` | Setup and login status |
| `POST` | `/api/auth/setup` | Create initial administrator |
| `POST` | `/api/auth/login` | Authenticate and create session |
| `POST` | `/api/auth/change-password` | Replace password, including forced initial change |
| `POST` | `/api/auth/logout` | End current session |
| `GET` | `/api/auth/sessions` | List login sessions |
| `DELETE` | `/api/auth/sessions/:sessionId` | Revoke a login session |
| `GET` | `/api/health` | Service and release health |
| `GET`, `PUT` | `/api/preferences` | Read or update UI preferences |
| `GET` | `/api/audit` | List audit events, with bounded `limit` |
| `GET`, `PUT` | `/api/settings` | Read or update runtime, Syncthing, and managed-home settings |

### Cluster, peer, and machine operations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cluster/invite` | Return pairing material |
| `GET`, `PUT` | `/api/cluster/node` | Read or update local node identity |
| `GET` | `/api/cluster/local-inventory` | Return local project inventory |
| `GET` | `/api/cluster/inventory` | Aggregate cluster inventory |
| `GET`, `POST` | `/api/cluster/peers` | List or pair peers |
| `POST` | `/api/cluster/peers/accept` | Accept reciprocal pairing |
| `POST` | `/api/cluster/membership/sync` | Merge membership and tombstones |
| `POST` | `/api/cluster/events` | Receive replicated domain events |
| `POST` | `/api/cluster/github/events` | Receive GitHub credential events |
| `POST` | `/api/cluster/projects/import` | Import a peer project record |
| `POST` | `/api/cluster/projects/map` | Map a peer project to a local path |
| `POST` | `/api/cluster/projects/discover` | Discover managed peer projects |
| `POST` | `/api/cluster/peers/:peerId/projects/:projectId/map` | Route project mapping to a peer |
| `POST` | `/api/cluster/sync/share` | Configure Syncthing folder sharing |
| `GET` | `/api/cluster/filesystem/directories` | Machine-authenticated local directory browse |
| `GET` | `/api/cluster/peers/:peerId/filesystem/directories` | Proxy directory browse to a peer |
| `DELETE` | `/api/cluster/peers/:peerId` | Remove peer and add membership tombstone |
| `POST` | `/api/cluster/sessions/transfer` | Route a session transfer |
| `POST` | `/api/cluster/sessions/receive` | Receive transferred session messages |
| `POST` | `/api/cluster/tasks/eligibility` | Check destination task eligibility |
| `POST` | `/api/cluster/tasks/status` | Read handoff protocol status |
| `POST` | `/api/cluster/tasks/prepare` | Prepare incoming handoff and optional Git bundle |
| `POST` | `/api/cluster/tasks/commit` | Commit incoming handoff |
| `POST` | `/api/cluster/tasks/settle` | Settle completed handoff |
| `POST` | `/api/cluster/tasks/abort` | Abort prepared handoff |
| `PATCH` | `/api/cluster/tasks/update` | Apply owner-routed task update |
| `DELETE` | `/api/cluster/tasks/delete` | Apply owner-routed task deletion |
| `POST` | `/api/cluster/tasks/archive` | Apply owner-routed task archive |
| `POST` | `/api/cluster/tasks/merge` | Apply owner-routed merge |
| `POST` | `/api/cluster/tasks/handoff` | Route handoff through current owner |

### Projects, conversations, and tasks

| Method | Path | Purpose |
|---|---|---|
| `GET`, `POST` | `/api/projects` | List or create/import projects |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:projectId` | Read, update, or remove a project |
| `POST` | `/api/projects/:projectId/sync/rescan` | Trigger Syncthing rescan |
| `PUT` | `/api/projects/:projectId/path-mapping` | Save node-local project mapping |
| `GET`, `PUT` | `/api/projects/:projectId/github-auth` | Read or assign project GitHub credentials |
| `PUT` | `/api/projects/:projectId/sessions/title` | Set conversation title override |
| `GET` | `/api/projects/:projectId/session-nodes` | List mapped and online execution nodes |
| `GET` | `/api/projects/:projectId/skills` | Discover agent skills |
| `GET` | `/api/projects/:projectId/sessions` | List merged Pi and Claude sessions, capped after discovery |
| `PUT` | `/api/projects/:projectId/sessions/reviewed` | Mark conversation reviewed |
| `POST` | `/api/projects/:projectId/sessions/transfer` | Transfer a non-task Pi session |
| `DELETE` | `/api/projects/:projectId/sessions` | Delete a project-scoped session |
| `GET`, `POST` | `/api/projects/:projectId/tasks` | List or create tasks |
| `GET` | `/api/projects/:projectId/tasks/:taskId/eligibility` | List handoff destinations and reasons |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId` | Update task or route update to owner |
| `POST` | `/api/projects/:projectId/tasks/:taskId/handoff` | Start node handoff |
| `POST` | `/api/projects/:projectId/tasks/:taskId/archive` | Archive task and workspace |
| `POST` | `/api/projects/:projectId/tasks/:taskId/merge` | Merge legacy Git-backed task |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId` | Delete task and owned workspace |
| `GET` | `/api/projects/:projectId/file` | Stream a project-relative file |

### Registries, credentials, push, and browsing

| Method | Path | Purpose |
|---|---|---|
| `GET`, `PUT` | `/api/project-types` | List or save project types |
| `DELETE` | `/api/project-types/:typeId` | Delete project type |
| `GET` | `/api/github-auth` | Read GitHub group and assignment status |
| `POST` | `/api/github-auth/groups` | Create GitHub credential group |
| `PUT`, `DELETE` | `/api/github-auth/groups/:groupId` | Update or remove group |
| `GET` | `/api/push/vapid-public-key` | Read browser push public key |
| `POST` | `/api/push/subscribe` | Save push subscription |
| `POST` | `/api/push/unsubscribe` | Remove push subscription |
| `GET` | `/api/harnesses` | List Pi and Claude harnesses |
| `GET` | `/api/models` | List available Pi runtime models |
| `GET` | `/api/filesystem/directories` | Browse local directories for authenticated UI |

## WebSocket contract

### Connection and routing

The endpoint is `/ws`. Browser authentication requires a valid session whose forced password change is complete. The request origin must exactly match the request host. The URL carries project, session, node, and optional task context.

- Non-task chat uses `nodeId`. A local entry node proxies to the selected peer when required.
- Task chat resolves `TaskRecord.currentNodeId`; task ownership takes precedence over the UI node override.
- Other modes include project watching and proxy bridging.
- Pi sessions may be shared by project, working directory, and session path. Claude connections track `projectId`, session identity, model, effort, child process, and transcript.

### Browser-to-server commands

| Command | Main effect |
|---|---|
| `ping` | Heartbeat |
| `prompt` | Submit text and optional image or text attachments |
| `setEngine` | Switch Pi or Claude, with handoff context |
| `setModel` | Change Pi runtime model or Claude model option |
| `models` | Request model inventory |
| `cycleModel` | Cycle Pi model |
| `setThinking` | Set Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `cycleThinking` | Cycle Pi thinking level |
| `setEffort` | Set Claude effort: `default`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `setSafeguards` | Enable or disable Pi safeguards |
| `rename` | Rename live Pi session |
| `abort` | Stop active work |

The frontend currently sends `setEffort` from the Claude model dialog. It does not currently send `setThinking` or `cycleThinking` from a dedicated Pi control.

### Server-to-browser events

Events cover:

- `ready`, connection `status`, errors, reconnect and peer proxy state.
- `userMessage`, `textDelta`, `assistantMessage`, `thinkingStart`, `thinkingDelta`, `thinkingEnd`.
- Tool start, update, output, and completion.
- Session name, model, thinking level, engine, queue, and safeguards changes.
- `sessionsChanged` and `tasksChanged` invalidation signals.
- Completion and abort outcomes.

Status includes session identity, model summary, current and available thinking levels, streaming and retry flags, pending message count, active tools, prompt templates, and optional safeguard state. Claude maps effort into the status `thinkingLevel` field.

## External integration contracts

| Integration | Protocol and operations | Failure boundary |
|---|---|---|
| Syncthing | REST for system status, device and folder config, ignore rules, folder status, scans | Network/API readiness errors block sync-dependent operations |
| Pi | Embedded SDK for models, sessions, prompts, tools, safeguards, events | SDK/session errors propagate to socket or HTTP handling |
| Claude | `claude -p --output-format stream-json`, optional resume, model, effort | Child process exit, malformed stream, transcript access |
| Git | Spawned `git` commands for repository checks, worktrees, bundles, merge, abort | Validation and subprocess errors map to task/worktree errors |
| Web Push | VAPID and Push API delivery | Subscription expiry and network failures |
| Peer Joint Bob | Bearer-authenticated REST and WebSocket proxying | Timeout, offline peer, mapping, receipt, and reconciliation failures |
| Filesystem | Project, transcript, skill, workspace, migration, and download paths | Path mapping, permissions, symlinks, and external file changes |

## Security and contract limitations

- Security headers include CSP, HSTS, frame denial, MIME sniff prevention, and strict referrer policy.
- Credentials use AES-256-GCM with a node-local mode-`0600` 32-byte key.
- `GET /api/projects/:projectId/file` verifies lexical containment with `path.relative`, then calls `stat` and `createReadStream`. Those calls follow symlinks, so an authenticated request can follow a symlink inside a project beyond the project root.
- Generic HTTP 500 middleware returns internal exception messages.
- Claude uses `--permission-mode bypassPermissions`; Pi safeguards can be disabled per session.
- Contract shapes are duplicated manually across TypeScript and native browser JavaScript.
