# Code structure

## Repository layout

| Path | Classification | Purpose |
|---|---|---|
| `src/` | Canonical TypeScript backend | REST, WebSocket, persistence, cluster, task, agent, sync, and filesystem logic |
| `public/` | Canonical unbundled PWA | HTML shell, CSS, browser state and rendering, board rendering, Markdown rendering, boot screen, service worker, manifest, icons |
| `test/` | TypeScript tests | Module, API, process, WebSocket, installer, and static source-contract tests |
| `bin/joint-bob.mjs` | Published CLI | `install` and `doctor` commands |
| `scripts/` | Bash operations | Installation, version pinning, service setup, deployment, HTTPS, Syncthing, Git hooks, EC2 smoke runner |
| `deploy/` | Runtime and test infrastructure | systemd, launchd, Terraform AWS EC2 smoke environment |
| `.github/workflows/release.yml` | Release automation | Tagged build, test, package, GitHub release, and npm publish |
| `dist/` | Generated output | TypeScript compiler output; not canonical source |
| Root `app.js`, `server.ts`, `styles.css`, `sw.js`, `index.html` | Ignored legacy copies | Non-canonical copies present beside `src/` and `public/` |
| `.pi-mobile-web/`, `.pi-mobile-web-attachments/` | Ignored runtime state | Legacy local state and attachments, outside canonical code |

There are no npm workspaces or separately versioned internal packages. `src/server.ts` is the application composition root. `src/app.ts` only re-exports the Express app for tests.

## Backend module map

All 27 TypeScript modules under `src/` were analyzed.

| Module | Responsibility |
|---|---|
| `app.ts` | Test-facing re-export of `app` and `createApp` |
| `audit.ts` | Audit schema and event persistence |
| `auth.ts` | Administrator setup, password hashing, sessions, revocation, cookies |
| `claude-service.ts` | Claude transcript discovery and streamed CLI execution |
| `cluster.ts` | Local node identity, peers, encrypted tokens, membership, tombstones, delivery tracking |
| `conversation-reviews.ts` | Reviewed/running/needs-review conversation state |
| `github-auth.ts` | Encrypted GitHub groups, project overrides, replication, legacy migration |
| `harnesses.ts` | Pi and Claude adapter registry and merged 50-session listing |
| `managed-home.ts` | Managed project and ticket root paths |
| `names.ts` | Replicated project names and session title overrides |
| `pi-service.ts` | Pi SDK runtime, sessions, model inventory, status, streamed event conversion |
| `preferences.ts` | Persistent user interface preferences |
| `project-directory-import.ts` | Copy, move, symlink, relocation, and rollback operations |
| `push.ts` | VAPID key storage, subscriptions, and notifications |
| `replication.ts` | Event outbox, receipts, retries, names and task replication |
| `server.ts` | Express routes, WebSockets, proxying, task orchestration, reconciliation, startup |
| `session-paths.ts` | Cross-node and cross-engine path encoding and resolution |
| `settings.ts` | Encrypted runtime, Syncthing, and managed-home settings |
| `skills.ts` | User and project skill discovery for Pi and Claude |
| `store.ts` | Project records, aliases, types, paths, colours, and migrations |
| `syncthing.ts` | Syncthing REST client, folders, devices, ignores, readiness, rescans |
| `task-workspaces.ts` | Synchronized ticket workspace paths and lifecycle |
| `tasks.ts` | Task records, leases, execution state, handoff state, replication |
| `types.ts` | Shared backend domain and transport types |
| `watcher.ts` | Filesystem watching for conversation changes |
| `websocket.ts` | WebSocket close-reason sanitization |
| `worktrees.ts` | Git validation, worktrees, bundles, merge, and abort |

## Frontend structure

| File | Current role |
|---|---|
| `public/index.html` | Full application shell and dialogs. Defines Projects, Conversations, Board, Chat, fixed mobile navigation, settings, task, model, and transfer controls. |
| `public/app.js` | Main browser module. Owns global UI state, REST calls, WebSockets, rendering, dialogs, preferences, history, chat streaming, project and session actions. |
| `public/board.js` | Board rendering and task-card behavior used by `app.js`. |
| `public/markdown.js` | Markdown-to-DOM rendering helpers. |
| `public/styles.css` | Design tokens, responsive layout, animations, accessibility rules, component selectors. |
| `public/boot.js` | Theme and boot-screen setup before the main module loads. |
| `public/sw.js` | App-shell cache, offline fallback, push notification display and navigation. |
| `public/manifest.webmanifest` | PWA metadata. |
| `public/icon.svg`, PNG icons | Browser and install icons. |

The frontend uses native ES modules and DOM APIs. It has no framework, bundler, transpilation, shared generated client, or static type checking.

## Current UI control placement

The mobile shell shows one `.view-panel` at a time. `body.view-projects`, `body.view-sessions`, `body.view-board`, and `body.view-chat` select the visible panel. A fixed four-column `.mobile-nav` changes views. Desktop switches at 1024 pixels to persistent Projects, Conversations, and content columns, with collapsible side rails.

The chat header and controls are separate rows:

- `.chat-topbar` contains back navigation, title, mini status, ticket backlink, connection status, and Stop.
- `.chat-toolbar` contains execution node, agent, model, safeguards, session transfer, notifications, rename, and install controls.
- `.chat-toolbar` uses `overflow-x: auto` and hides its scrollbar. On narrow screens, this row slides horizontally.
- The model dialog shows Claude effort controls only when Claude is active. Pi thinking information appears in status, while Pi thinking commands exist on the socket contract without a browser selector.

## Build and runtime flow

1. `npm run build` runs `tsc` and emits `src/**/*.ts` into `dist/` with `NodeNext`, ES2022, strict mode, and `skipLibCheck`.
2. `public/` remains unchanged and is served directly.
3. `npm start` rebuilds, then runs `dist/server.js`.
4. `npm run dev` uses `tsx watch src/server.ts`.
5. `npm test` uses Node's test runner through the `tsx` import hook.
6. `prepack` rebuilds before npm packaging.
7. Installed deployments package an exact Git commit into `~/.local/share/joint-bob/app`, back up SQLite, restart the native service, and verify health.

## Repeated implementation patterns

- Zod schemas validate HTTP bodies, query parameters, and WebSocket messages at transport boundaries.
- SQLite modules create their own tables and guarded alterations on startup. Writes commonly use explicit transactions and rollback.
- Peer mutations use bearer-authenticated REST, receipts, outboxes, retries, and reconciliation loops.
- Agent engines sit behind `HarnessAdapter`, but live execution still branches in `src/server.ts` because Pi is embedded and Claude is a subprocess.
- Persistent domain state uses SQLite; repositories, transcripts, worktrees, and synchronized data stay filesystem-owned.
- Legacy names, paths, environment variables, JSON stores, and service identities remain accepted during migration.
