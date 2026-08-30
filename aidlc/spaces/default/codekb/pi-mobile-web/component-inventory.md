# Component Inventory

One component per source module. Names in this file are matched literally by the reverse-engineering rerun guard against the `analyzed.components` list in `reverse-engineering-timestamp.md`; do not rename a heading without updating that block.

Dependency notation: **Depends on** lists internal modules imported. Every persistence component additionally opens `~/.joint-bob/node.db` directly via `node:sqlite`, which is stated once here rather than repeated per row.

## Composition Root

### HTTP and WebSocket Server

- **File:** `src/server.ts` — 4,712 lines / 235 KB, ~160 top-level functions.
- **Responsibility:** Express application, all 105 explicit `app.<verb>()` route handlers plus 2 loop-registered filesystem routes plus 5 `app.use` mounts, the single `/ws` WebSocket server, cross-node socket proxying (`proxySocket`), Claude subprocess orchestration (`runClaudeTurn`, `handleClaudeCommand`, `switchEngine`, lines 3921-4060), the conversation ownership/transfer/receive/takeover/recover region (lines 2370-2760), and six background reconcilers.
- **Depends on:** ~25 of the 32 sibling modules — `harnesses`, `conversation-ownership`, `replication`, `cluster`, `tasks`, `store`, `update-recovery`, `terminal-session`, `syncthing`, `auth`, `conversation-reviews`, `session-paths`, `claude-service`, `claude-runtime`, `pi-service`, `watcher`, `websocket`, `audit`, `secrets`, `github-auth`, `push`, `settings`, `preferences`, `names`, `project-locks`, `project-directory-import`, `task-workspaces`, `worktrees`, `managed-home`, `types`.
- **Depended on by:** `src/app.ts` only.
- **Notes:** Largest structural risk in the repository. Carries three `NODE_ENV === "test"` branches in shipped code (`:2691`, `:3886`, `:3901`).

### Application Entry Point

- **File:** `src/app.ts` — one line.
- **Responsibility:** Re-exports `{ app, createApp }` so tests can construct the app without starting the listener.
- **Depends on:** `server`.
- **Depended on by:** the test suite.

## Engine Layer

### Harness Registry

- **File:** `src/harnesses.ts`
- **Responsibility:** Unifies Pi and Claude behind one session listing/loading interface so the client sees a single conversation model.
- **Depends on:** `pi-service`, `claude-service`, `names`.
- **Depended on by:** `server`.

### Claude Code Service Adapter

- **File:** `src/claude-service.ts`
- **Responsibility:** Drives the `claude` CLI; enumerates and parses Claude transcripts. Key exports: `claudeProjectsRoot()` (settings-aware, honours `settings.claude.sessionPath` / `configPath`), `listClaudeSessions` (line 177, enumerates `claudeProjectDirs(project, claudeProjectsRoot())`), `loadClaudeMessages` (validates the path lies inside `claudeProjectsRoot()`).
- **Depends on:** `session-paths`, `settings`.
- **Depended on by:** `harnesses`, `server`.
- **Notes:** Bounds listing concurrency with `CLAUDE_LIST_CONCURRENCY`; a source comment records a 1 GB memory peak on a 340-file project.

### Claude Runtime State

- **File:** `src/claude-runtime.ts`
- **Responsibility:** Ingests Claude hook events and records running/stopped conversation state in SQLite.
- **Depends on:** SQLite.
- **Depended on by:** `server`.
- **Related:** hooks installed by `scripts/install-claude-hooks.mjs`.

### Pi Agent Service Adapter

- **File:** `src/pi-service.ts`
- **Responsibility:** Pi agent SDK session lifecycle via `SessionManager` / `AgentSession`, model handling, message simplification.
- **Depends on:** `@earendil-works/pi-coding-agent`, `session-paths`.
- **Depended on by:** `harnesses`, `server`.

### Session Path Resolution

- **File:** `src/session-paths.ts`
- **Responsibility:** Derives filesystem paths for Pi and Claude transcripts and recovers Pi transcripts from Syncthing conflict files.
- **Key exports:** `resolveLocalSessionPath` (line 17), `claudeProjectDir`, `claudeProjectDirs` (line 49), `recoveryDiagnostic`.
- **Depends on:** none internal.
- **Depended on by:** `claude-service`, `pi-service`, `watcher`, `tasks`, `server`.
- **Intent-area notes:** `resolveLocalSessionPath` splits the sender's path at the last `.claude` segment and re-roots the entire remaining suffix — including the sender-encoded project directory name — under the destination's home. `claudeProjectDirs` already computes the locally-correct directory set but returns **multiple** candidates, and its default root is `~/.claude/projects` rather than the settings-aware `claudeProjectsRoot()`. `recoveryDiagnostic` hardcodes `localNodeId: "local"`.

### Session Watcher

- **File:** `src/watcher.ts`
- **Responsibility:** Watches transcript directories and emits change notifications that become `sessionFile` / `sessionsChanged` frames.
- **Key export:** `sessionWatchDirs` (line 33).
- **Depends on:** `session-paths`.
- **Depended on by:** `server`.
- **Notes:** Calls `claudeProjectDirs(project)` with **no root argument**, so on a node with a non-default `claude.configPath` it watches directories that `listClaudeSessions` does not read.

### Update Recovery

- **File:** `src/update-recovery.ts`
- **Responsibility:** Persists in-flight agent runs so a service restart can resume them rather than orphaning the conversation.
- **Depends on:** SQLite.
- **Depended on by:** `server`.
- **Notes:** A source comment on `adoptSessionId` records the orphaned-run case.

## Cluster Layer

### Conversation Ownership State Machine

- **File:** `src/conversation-ownership.ts`
- **Responsibility:** Single-writer authority per `(engine, sessionId)`, carrying an epoch and a status. The invariant that makes a replicated transcript safe to continue on another node.
- **Key exports:** `ConversationEngine = "pi" | "claude"`, `claimConversationOwnership`, `beginConversationTransfer`, `commitConversationTransfer`, `takeConversationOwnership`, `beginConversationRecovery`, `applyConversationOwnershipEvent`, `ownershipPayload`, `ensureConversationOwnershipSchema`.
- **Depends on:** `replication` (mutual import), SQLite.
- **Depended on by:** `server`, `replication`.
- **Intent-area notes:** **Already fully engine-agnostic.** The SQLite table carries `CHECK(engine IN ('pi', 'claude'))`, `ownershipPayload` validates both, and every state-machine function takes `engine` as a parameter with no Pi-specific branch.

### Replication Outbox

- **File:** `src/replication.ts`
- **Responsibility:** Event outbox/inbox carrying cluster-wide state changes between peers; idempotent application on receipt.
- **Depends on:** `conversation-ownership` (mutual import), `cluster`, SQLite.
- **Depended on by:** `server`, `tasks`, `conversation-ownership`, `github-auth`.

### Cluster Membership

- **File:** `src/cluster.ts`
- **Responsibility:** Node identity, peer pairing, machine token issue and verification, membership snapshots and tombstones.
- **Depends on:** SQLite, `node:crypto`.
- **Depended on by:** `server`, `tasks`, `replication`.
- **Notes:** 14 `as unknown as` casts at the SQLite boundary.

## Domain Layer

### Project Store

- **File:** `src/store.ts`
- **Responsibility:** Projects, project types, aliases and imports.
- **Depends on:** SQLite.
- **Depended on by:** `server`, `tasks`.
- **Notes:** 12 `as unknown as` casts.

### Task Domain

- **File:** `src/tasks.ts` — 575 lines.
- **Responsibility:** Kanban tasks, leases, and the cross-node handoff protocol.
- **Depends on:** `cluster`, `replication`, `worktrees`, `task-workspaces`, `audit`, `session-paths`, SQLite.
- **Depended on by:** `server`.
- **Notes:** Holds two overlapping handoff mechanisms — Git bundle/worktree and Syncthing ticket workspace. 35 `as unknown as` casts, the highest count in the repository.

### Git Worktree Operations

- **File:** `src/worktrees.ts`
- **Responsibility:** Git worktree creation and Git-bundle task handoff. Documented in `README.md` as the legacy path.
- **Depends on:** `git` via `execFile`.
- **Depended on by:** `tasks`.

### Task Workspaces

- **File:** `src/task-workspaces.ts`
- **Responsibility:** Syncthing ticket workspaces — the current handoff path.
- **Depends on:** `syncthing`.
- **Depended on by:** `tasks`.
- **Notes:** Carries a `.pi-mobile-web/` ignore rule from the pre-rebrand naming.

### Conversation Reviews

- **File:** `src/conversation-reviews.ts`
- **Responsibility:** Per-user review watermarks and the review inbox that backs `GET /api/reviews/pending`.
- **Depends on:** SQLite.
- **Depended on by:** `server`.

### Project Locks

- **File:** `src/project-locks.ts`
- **Responsibility:** Project-level locking.
- **Depends on:** SQLite.
- **Depended on by:** `server`.

### Project Directory Import

- **File:** `src/project-directory-import.ts`
- **Responsibility:** Importing project directories discovered on peer nodes.
- **Depends on:** `store`, `cluster`.
- **Depended on by:** `server`.

## Platform Layer

### Authentication and Sessions

- **File:** `src/auth.ts`
- **Responsibility:** First-run password setup, scrypt password hashing, cookie session issue and verification. Backs the unauthenticated `POST /api/auth/setup` and `POST /api/auth/login`.
- **Depends on:** `node:crypto`, SQLite.
- **Depended on by:** `server`.

### Audit Log

- **File:** `src/audit.ts`
- **Responsibility:** Append-only audit record of privileged operations.
- **Depends on:** SQLite.
- **Depended on by:** `server`, `tasks`.

### Secrets Vault

- **File:** `src/secrets.ts`
- **Responsibility:** AES-encrypted secret storage.
- **Depends on:** `node:crypto`, SQLite.
- **Depended on by:** `server`.

### GitHub Credential Groups

- **File:** `src/github-auth.ts`
- **Responsibility:** GitHub credential groups, encrypted at rest and replicated across the mesh.
- **Depends on:** `secrets`, `replication`, SQLite.
- **Depended on by:** `server`, `push` flows.
- **Notes:** 9 `as unknown as` casts.

### Web Push Notifications

- **File:** `src/push.ts`
- **Responsibility:** Web push subscription storage and delivery via `web-push`; notifies when a conversation needs review.
- **Depends on:** `web-push`, `secrets`, SQLite.
- **Depended on by:** `server`.

### Node Settings

- **File:** `src/settings.ts`
- **Responsibility:** Per-node settings including `settings.claude.sessionPath` and `settings.claude.configPath`, which `claudeProjectsRoot()` reads.
- **Depends on:** SQLite.
- **Depended on by:** `claude-service`, `server`.

### User Preferences

- **File:** `src/preferences.ts`
- **Responsibility:** Per-user UI preferences.
- **Depends on:** SQLite.
- **Depended on by:** `server`.

### Name Overrides

- **File:** `src/names.ts`
- **Responsibility:** Human-friendly name overrides for nodes and conversations.
- **Depends on:** filesystem, SQLite.
- **Depended on by:** `harnesses`, `server`.
- **Notes:** Reads the legacy `PI_MOBILE_WEB_NAMES_PATH` environment variable.

### Syncthing Adapter

- **File:** `src/syncthing.ts`
- **Responsibility:** Syncthing REST client (`/rest/...` with `X-API-Key`), folder provisioning and ignore-pattern policy. Defines `CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude"` at line 41 with path `~/.claude` — the mechanism that puts every node's Claude transcripts on every other node.
- **Depends on:** Syncthing daemon.
- **Depended on by:** `server`, `task-workspaces`.
- **Notes:** Ignore rules still reference `.pi-mobile-web/`.

### Managed Home

- **File:** `src/managed-home.ts`
- **Responsibility:** Managed home-directory layout for agent runs.
- **Depends on:** filesystem.
- **Depended on by:** `server`.

### Terminal Session

- **File:** `src/terminal-session.ts`
- **Responsibility:** Spawns the user's `$SHELL` and frames the `terminalInput` / `terminalOutput` / `terminalReady` / `terminalExit` WebSocket channel.
- **Depends on:** `$SHELL`.
- **Depended on by:** `server`.

### WebSocket Transport

- **File:** `src/websocket.ts`
- **Responsibility:** WebSocket connection plumbing shared by the chat, watch and terminal channels.
- **Depends on:** `ws`.
- **Depended on by:** `server`.

### Shared Types

- **File:** `src/types.ts`
- **Responsibility:** Shared type surface across the server modules.
- **Depends on:** none.
- **Depended on by:** most `src/` modules.

## Client Components

### Browser PWA Client

- **File:** `public/app.js` — 4,776 lines, 226 functions.
- **Responsibility:** The whole application shell — chat, projects, sessions, settings — against one mutable `state` object of ~60 keys and an `elements` map cached by `document.querySelector`.
- **Depends on:** `public/board.js`, `public/markdown.js`, the `/api/*` HTTP surface, `/ws`.
- **Intent-area notes:** Holds all three client-side Claude transfer gates — the session row menu entry at `:2172-2174` (`disabled: isClaude`, title `"Claude transfer is not available yet"`), the toolbar transfer button at `:2844-2846`, `:2863-2864` and `:4104` (`transferable` requires `state.engine === "pi"`; `openSessionTransferDialog` emits `"Claude conversation transfer is not available yet"` and returns early), and the take-ownership button at `:4438` (`hidden = Boolean(state.activeTaskId || state.engine !== "pi")`).

### Kanban Board UI

- **File:** `public/board.js`
- **Responsibility:** The task board view.
- **Depends on:** the `/api/projects/:id/tasks*` surface.
- **Coverage:** skimmed only in this scan — head and purpose.

### Markdown Renderer

- **File:** `public/markdown.js`
- **Responsibility:** Dependency-free, XSS-safe Markdown rendering of assistant output.
- **Depends on:** none.
- **Coverage:** skimmed only in this scan — head and purpose.

### Service Worker

- **File:** `public/sw.js`
- **Responsibility:** Offline shell caching under a manually pinned `CACHE_NAME`, currently `joint-bob-v52`.
- **Notes:** `AGENTS.md` mandates bumping `CACHE_NAME` on any shell change; nothing enforces it, and two UI tests pin the current value, so a correct bump breaks unrelated tests.

### Boot Loader

- **File:** `public/boot.js`
- **Responsibility:** Startup bootstrap and service-worker registration.

## Packaging and Operations

### CLI Installer

- **File:** `bin/joint-bob.mjs` — the package `bin` entry.
- **Responsibility:** `joint-bob install` — staged copy, atomic rename, rollback. Driven by `scripts/install.sh` and `scripts/install-service.sh`.

### Claude Hook Installer

- **File:** `scripts/install-claude-hooks.mjs`
- **Responsibility:** Installs the Claude Code hooks that post runtime events consumed by `src/claude-runtime.ts`.

### Deployment and Smoke Infrastructure

- **Files:** `deploy/aws-ec2-test/{main,variables,outputs,versions}.tf`, `deploy/aws-ec2-test/tests/security.tftest.hcl`, `deploy/joint-bob.service`, `deploy/com.joint-bob.node.plist`.
- **Responsibility:** Terraform harness for the EC2 smoke test, a systemd user unit and a macOS launch agent for service management.
- **Coverage:** skimmed only in this scan.

### Test Suite

- **Files:** `test/*.test.ts` — 115 flat files, 12,565 lines, larger than `src/`.
- **Responsibility:** `node:test` + `node:assert/strict`, executed as `node --import tsx --test test/*.test.ts`. API tests boot real servers; `test/conversation-ownership-mesh-api.test.ts` spins up two real nodes and exercises transfer across a dropped acknowledgement and a restart. UI tests assert against `public/*.js` and `public/index.html` at DOM level.
- **Coverage:** 5 files read in this scan; the remaining 110 inventoried by filename.
