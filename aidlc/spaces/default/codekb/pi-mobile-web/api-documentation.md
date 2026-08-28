# API Documentation

## API Overview

`src/server.ts` registers 86 Express method/path handlers, including `/api` resources and `/favicon.ico`, plus one WebSocket endpoint at `/ws`. Browser calls use a secure SQLite-backed session cookie and CSRF protection for state changes. A machine-authenticated subset accepts bearer tokens compared with `timingSafeEqual`.

Zod validates most untrusted bodies, queries, and socket commands. JSON and WebSocket contracts are handwritten; there is no OpenAPI, AsyncAPI, exported JSON Schema, generated client, GraphQL, gRPC, or formal API version.

## REST Surface

| Area | Representative methods and paths | Contract purpose |
|---|---|---|
| Authentication | `GET /api/auth/status`; `POST /api/auth/setup`; `POST /api/auth/login`; password/logout/session routes | First-run admin, login, password change, session revocation |
| Node state | `GET /api/health`; `GET|PUT /api/preferences`; `GET /api/audit`; `GET|PUT /api/settings` | Health, user preferences, audit, encrypted settings |
| Cluster | `/api/cluster/invite`, `/node`, `/peers`, `/membership/sync`, `/inventory` | Pairing, membership, tombstones, inventories |
| Replication | `POST /api/cluster/events`; `POST /api/cluster/github/events` | Receive event batches and credential events |
| Peer projects/files | Cluster project import/map/discover, sync share, filesystem browse | Node-local path mapping and Syncthing setup |
| Project registry | `GET|POST /api/projects`; `GET|PATCH|DELETE /api/projects/:projectId`; project types/locks/path mapping | Project lifecycle, types, colour, paths, locks |
| Conversations | project sessions list/title/delete/transfer, `session-nodes`, skills | Discover and manage Pi/Claude sessions |
| Review state | `PUT .../sessions/reviewed`; `PUT .../sessions/reviewed-all` | Mark one or all project conversations reviewed |
| Tasks | project task list/create/update/delete/archive/merge/handoff/eligibility | Board, ownership, phases, workspace lifecycle |
| GitHub credentials | `/api/github-auth`, groups, assignments, sync | Encrypted credential groups and delivery |
| Push | VAPID key, subscribe, unsubscribe | Browser completion notifications |
| Runtime inventory | `/api/harnesses`, `/api/models`, project skills | Agent and model discovery |
| Filesystem | `/api/filesystem/directories`; `/api/projects/:projectId/file` | Directory selection and file streaming |

The cluster machine route allowlist includes membership, inventory, replication, credential replication, project mapping, session transfer, task handoff phases, and folder sharing. Browser-only routes require an authenticated user and completed password change.

## Project and Conversation Contracts

`GET /api/projects/:projectId/sessions` merges Pi and Claude discovery, current running state, titles, node locations, and per-user review classification. Review states are `running`, `needs_review`, and `reviewed`.

`PUT /api/projects/:projectId/sessions/reviewed` marks one validated session path. `PUT /api/projects/:projectId/sessions/reviewed-all` re-lists sessions for membership validation and marks the requested/all paths. Current persistence advances `reviewed_at` to stored `last_activity_at`; activity not reconciled before the mark can reappear as `needs_review` on the next list.

Project file download accepts a project-relative path. The route lexically checks containment and then uses filesystem APIs that follow symlinks. A realpath/lstat boundary test is required before treating this as a complete isolation control.

## WebSocket Contract

### Connection Modes

`/ws` supports ordinary chat, task-owner routing, watch mode, terminal mode, and peer proxying. Browser sockets require a valid session, completed initial password change, and exact request-origin/host agreement. Machine proxying uses peer credentials.

- Non-task chat may use a UI-selected `nodeId`.
- Task chat resolves `TaskRecord.currentNodeId`; ownership wins over UI selection.
- `mode=terminal` attaches a project-scoped terminal session.
- Pi sessions may be shared and replay status/events; Claude tracks a child process and buffered live events for reattachment.

### Browser-to-Server Commands

| Command | Effect |
|---|---|
| `ping` | Heartbeat |
| `prompt` | Submit text and bounded attachments; can use follow-up streaming behavior |
| `setEngine` | Switch Pi/Claude with handoff context |
| `setModel`, `models`, `cycleModel` | Model selection/inventory |
| `setThinking`, `cycleThinking` | Pi thinking level control |
| `setEffort` | Claude effort control |
| `setSafeguards` | Pi safeguard state |
| `rename` | Rename active Pi session |
| `abort` | Stop active work |

Terminal mode has its own terminal input/resize lifecycle rather than the chat command set.

### Server-to-Browser Events

Events include readiness/status/errors; user messages; `textDelta`; final assistant messages; thinking start/delta/end; tool start/update/output/end; model/thinking/effort/safeguard changes; queue and retry state; `sessionsChanged`; `tasksChanged`; completion and abort; terminal output/exit.

Pi SDK `message_update` and Claude `content_block_delta` events normalize to partial text. The browser batches long-message DOM work. Existing tests prove event mapping and final flushing but not visible intermediate paint before completion.

## Internal APIs and Persistence Contracts

| Internal contract | Location | Purpose |
|---|---|---|
| Agent adapter APIs | `pi-service.ts`, `claude-service.ts`, `harnesses.ts` | Normalize models, sessions, transcripts, streaming events |
| Syncthing REST wrapper | `syncthing.ts` | System/config/folders/status/ignores/devices/scans |
| SQLite repositories | Module-local functions across `src/` | Users, projects, reviews, tasks, cluster, credentials, settings, audit |
| Git subprocess contract | `worktrees.ts` | Worktrees, checksummed bundles, merge, abort |
| Terminal process contract | `terminal-session.ts` | Attach input/output/resize to project-scoped shell process |
| Browser module contract | `public/app.js` → `board.js`, `markdown.js` | Rendering callbacks and safe message DOM |

No central database migration API exists. Modules create tables and guarded alterations when first opened.

## Failure and Security Semantics

- Zod validation failures return client errors; domain-specific filesystem/worktree errors are mapped near routes.
- Generic 500 handling exposes many thrown `Error.message` values, which can reveal operational detail.
- Peer calls can fail on offline nodes, invalid mappings, timeouts, stale ownership, or incomplete receipts; background reconciliation retries selected flows.
- Syncthing readiness intentionally blocks task handoff when state, remaining items, bytes, or errors are nonzero, but the public error collapses actionable details.
- Security headers include CSP, HSTS, frame denial, MIME-sniff prevention, and strict referrer policy.
- Secrets use AES-256-GCM with a node-local mode-`0600` key.
- Peer URL validation accepts general URLs. Documentation requires private HTTPS, but code does not enforce that deployment policy.

## Contract Gaps and Next Tests

- Add a timing-aware integration/browser test that sees a delta before completion and accepts steering during the same turn.
- Add bulk and single review tests around stale and concurrent activity timestamps.
- Add exact Syncthing ignore migration tests: old managed cache rule removed, delete-allowed cache rule added, user/sensitive rules unchanged.
- Add realpath/symlink download-boundary tests.
- Consider a shared schema only when contract drift continues; avoid introducing a generator without a demonstrated maintenance benefit.
