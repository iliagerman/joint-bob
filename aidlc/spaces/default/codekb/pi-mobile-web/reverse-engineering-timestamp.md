# Reverse Engineering Timestamp

## Scan Record

- **Scan date:** `2026-08-30`
- **Repository:** `pi-mobile-web` (package `joint-bob`)
- **Active intent:** `260830-claude-session-transfer`
- **Commit:** `468d84f03e7488079faeda98dc31761a1d50a2de`
- **Branch:** `main`
- **Coverage kind:** `partial`
- **Scan breadth requested by the human:** full rescan of the whole repository, replacing the store built by intent `260827-conversation-review-sync`

The commit identifies `HEAD` at scan time. The working tree carried uncommitted changes to `public/app.js`, `public/index.html`, `public/manifest.webmanifest`, `public/styles.css`, `src/server.ts`, and several `test/*.test.ts` files; they were preserved and were read in their working-tree form.

## Coverage Notes

Every module under `src/` was read: 12 modules in full (`session-paths.ts`, `conversation-ownership.ts`, `claude-service.ts`, `claude-runtime.ts`, `harnesses.ts`, `types.ts`, `watcher.ts`, `update-recovery.ts`, `websocket.ts`, `app.ts`, `terminal-session.ts`, `managed-home.ts`), `src/syncthing.ts` at its export surface plus the full ignore/engine-folder configuration block (lines 40-145), `src/server.ts` (4,712 lines) at full import list, full route table, full top-level function index and full reads of the ownership/transfer/receive/takeover/recover region (lines 2370-2760), the dynamic filesystem routes (lines 1625-1660) and the Claude turn machinery (lines 3921-4060), and the remaining 19 modules at complete exported-symbol surface plus imports without line-by-line body reads. `src/` is therefore recorded as analyzed at directory granularity, with that qualification stated here rather than implied.

`public/app.js` was read for structure plus full reads of the state object, the session row menu (lines 2160-2210), `renderChatSessionControls` (lines 2835-2875), `openSessionTransferDialog` / `continueSessionOnNode` (lines 4080-4120) and the ownership-dialog wiring (lines 4430-4445). `public/sw.js`, `public/boot.js`, `public/manifest.webmanifest` and the dialog/section id map of `public/index.html` were read in full.

## Disclosure: Coverage Discarded Relative to the Previous Store

This run replaces the store written on `2026-08-27` by intent `260827-conversation-review-sync` (commit `9ab9b04d0d3e23d2bdcfb1bcb8b84b7183b36ce1`, fingerprint `16d7b51d9ecb68a4565be3fafa6993b57100c245`). This run went deeper on the Claude session transfer surface but shallower on several areas the earlier run covered deeply. The following paths drop from deep to shallow coverage and are recoverable from Git history at commit `9ab9b04d0d3e23d2bdcfb1bcb8b84b7183b36ce1`:

- `scripts/` — the 14 shell scripts were skimmed this run; only `scripts/install-claude-hooks.mjs` and `scripts/hooks/pre-push` were read in full.
- `deploy/` — the Terraform EC2 smoke-test harness, the systemd unit and the macOS launch agent were skimmed this run.
- `public/board.js`, `public/markdown.js` — heads and purpose only this run.
- `CONTRIBUTING.md`, `SECURITY.md` — presence and role only this run.
- `test/conversation-review-api.test.ts`, `test/conversation-status-indicators.test.ts`, `test/streaming-render-performance.test.ts`, `test/chat-session-ux.test.ts`, `test/syncthing.test.ts`, `test/syncthing-handoff-api.test.ts`, `test/startup-readiness.test.ts`, `test/node-project-sync.test.ts`, `test/public-distribution.test.ts` — deep in the earlier run, filename-inventory only in this one.

Newly deep in this run, and absent from the earlier analyzed set: `public/boot.js`, `public/manifest.webmanifest`, `.gitignore`, `test/session-paths.test.ts`, `test/claude-sync-conflict.test.ts`, `test/conversation-ownership.test.ts`, `test/conversation-ownership-mesh-api.test.ts`, `test/claude-session-reattach.test.ts`, plus full reads of the transfer/ownership regions of `src/server.ts`.

### Component taxonomy rename

The overwrite backstop also reports every component name from the previous store as discarded. That is a renaming artifact, not lost coverage: this run replaces the earlier coarse, role-based component names with one component per source module, so the strings no longer match literally. The mapping is:

| Previous store component | This store |
|---|---|
| Application composition and transport | HTTP and WebSocket Server, Application Entry Point, WebSocket Transport, Terminal Session |
| Account and node state | Authentication and Sessions, Node Settings, User Preferences, Audit Log, Secrets Vault, Managed Home |
| Project domain and persistence | Project Store, Project Locks, Project Directory Import, Name Overrides |
| Task domain and workspaces | Task Domain, Task Workspaces |
| Git worktree operations | Git Worktree Operations |
| Cluster and replication | Cluster Membership, Replication Outbox, Conversation Ownership State Machine |
| GitHub credential management | GitHub Credential Groups |
| Agent adapters | Harness Registry, Claude Code Service Adapter, Claude Runtime State, Pi Agent Service Adapter |
| Conversation discovery | Session Path Resolution, Session Watcher, Conversation Reviews, Update Recovery |
| Syncthing adapter | Syncthing Adapter |
| Push notifications | Web Push Notifications |
| Filesystem management | folded into HTTP and WebSocket Server (the `/api/filesystem/*` and `/api/cluster/filesystem/*` routes) |
| Skill discovery | Skill Discovery |
| Browser PWA | Browser PWA Client, Service Worker, Boot Loader |
| Kanban board UI | Kanban Board UI (skimmed this run) |
| Markdown renderer | Markdown Renderer (skimmed this run) |
| CLI and packaging | CLI Installer, Claude Hook Installer |
| Deployment and smoke infrastructure | Deployment and Smoke Infrastructure (skimmed this run) |

Only the last three rows represent a genuine reduction in depth; the rest is a one-to-many rename.

## Scope of Analysis

```yaml
scope_version: 1
kind: partial
intent: 260830-claude-session-transfer
fingerprint: 11cbb5149c36252812faa45ec351cbcdc177cb1d
analyzed:
  paths:
    - src/
    - public/app.js
    - public/index.html
    - public/sw.js
    - public/boot.js
    - public/manifest.webmanifest
    - bin/joint-bob.mjs
    - scripts/install-claude-hooks.mjs
    - scripts/hooks/pre-push
    - .github/workflows/release.yml
    - package.json
    - package-lock.json
    - npm-shrinkwrap.json
    - tsconfig.json
    - Justfile
    - README.md
    - AGENTS.md
    - CLAUDE.md
    - .gitignore
    - test/session-paths.test.ts
    - test/claude-sync-conflict.test.ts
    - test/conversation-ownership.test.ts
    - test/conversation-ownership-mesh-api.test.ts
    - test/claude-session-reattach.test.ts
  components:
    - HTTP and WebSocket Server
    - Application Entry Point
    - Conversation Ownership State Machine
    - Session Path Resolution
    - Claude Code Service Adapter
    - Claude Runtime State
    - Pi Agent Service Adapter
    - Harness Registry
    - Session Watcher
    - Update Recovery
    - WebSocket Transport
    - Terminal Session
    - Managed Home
    - Project Store
    - Cluster Membership
    - Replication Outbox
    - Task Domain
    - Git Worktree Operations
    - Task Workspaces
    - Syncthing Adapter
    - Authentication and Sessions
    - Audit Log
    - Secrets Vault
    - GitHub Credential Groups
    - Web Push Notifications
    - Node Settings
    - User Preferences
    - Name Overrides
    - Project Locks
    - Project Directory Import
    - Skill Discovery
    - Conversation Reviews
    - Shared Types
    - Browser PWA Client
    - Service Worker
    - Boot Loader
    - CLI Installer
    - Claude Hook Installer
shallow:
  paths:
    - scripts/
    - deploy/
    - test/
    - public/styles.css
    - public/board.js
    - public/markdown.js
    - CONTRIBUTING.md
    - CODE_OF_CONDUCT.md
    - SECURITY.md
    - LICENSE
    - .claude/
    - aidlc/
    - aidlc.archive/
    - node_modules/
    - dist/
    - .git/
    - app.js
    - index.html
    - server.ts
    - styles.css
    - sw.js
```
