# Code Structure

## Repository Layout

| Path | Classification | Purpose |
|---|---|---|
| `src/` | Canonical TypeScript backend | HTTP, WebSocket, persistence, cluster, tasks, agents, Syncthing, terminal, and filesystem logic |
| `public/` | Canonical unbundled PWA | HTML shell, CSS, browser state, board, Markdown, service worker, manifest, icons |
| `test/` | TypeScript tests | Unit, API, WebSocket, process, persistence, installer, and source-contract tests |
| `bin/joint-bob.mjs` | Published CLI | `install`, `doctor`, and help |
| `scripts/` | Bash operations | Install, deployment, pinned runtimes, services, private HTTPS, hooks, smoke runner |
| `deploy/` | Runtime/infrastructure assets | systemd, launchd, and Terraform EC2 smoke environment |
| `.github/workflows/release.yml` | Release CI | Tag validation, packaging, GitHub release, npm provenance publish |
| `dist/` | Generated output | `tsc` output; not source of truth |
| `aidlc/`, `.claude/` | Development workflow state/framework | AI-DLC records and framework; not product runtime code |

There is one npm package, no workspace configuration, and no second `package.json`.

## Backend Module Map

All 29 `src/*.ts` modules were deeply analyzed.

| Module | Responsibility |
|---|---|
| `app.ts` | Test-facing re-export of the Express app |
| `audit.ts` | Audit event persistence |
| `auth.ts` | Administrator setup, scrypt passwords, sessions, cookies, revocation |
| `claude-service.ts` | Claude transcript handling and streamed CLI execution |
| `cluster.ts` | Node identity, peers, encrypted tokens, membership, tombstones |
| `conversation-reviews.ts` | Per-user conversation activity and review state |
| `github-auth.ts` | Encrypted GitHub groups, assignments, replication, migration |
| `harnesses.ts` | Pi/Claude registry and normalized session discovery |
| `managed-home.ts` | Managed project and ticket roots |
| `names.ts` | Project-name and session-title overrides |
| `pi-service.ts` | Pi SDK sessions, models, status, and event normalization |
| `preferences.ts` | Per-user UI preferences |
| `project-directory-import.ts` | Copy, move, symlink, relocation, rollback |
| `project-locks.ts` | Project lock ownership and persistence |
| `push.ts` | VAPID keys, subscriptions, notifications |
| `replication.ts` | Event outbox, receipts, retries, replicated entities |
| `server.ts` | Composition root: 86 REST registrations, `/ws`, orchestration, startup |
| `session-paths.ts` | Cross-node and cross-engine path resolution |
| `settings.ts` | Runtime, managed-home, and Syncthing settings |
| `skills.ts` | Pi and Claude skill discovery |
| `store.ts` | Projects, aliases, types, colours, locations, migrations |
| `syncthing.ts` | Syncthing REST adapter, folders, ignores, status, scans |
| `task-workspaces.ts` | Ticket workspace paths and lifecycle |
| `tasks.ts` | Tasks, leases, execution, handoffs, tombstones |
| `terminal-session.ts` | Project-scoped terminal process/socket attachment |
| `types.ts` | Shared backend domain and transport types |
| `watcher.ts` | Conversation filesystem watches |
| `websocket.ts` | Safe WebSocket close reasons |
| `worktrees.ts` | Git validation, worktrees, bundles, merge, abort |

## Frontend Structure

| File | Role |
|---|---|
| `public/index.html` | Application shell, panels, dialogs, controls |
| `public/app.js` | Main state store, REST calls, WebSockets, rendering, actions |
| `public/board.js` | Kanban board and task-card rendering |
| `public/markdown.js` | Safe message-to-DOM rendering |
| `public/styles.css` | Tokens, components, responsive states, active working-tree UI changes |
| `public/boot.js` | Early theme and boot handling |
| `public/sw.js` | App-shell cache `joint-bob-v34`, offline shell, push handling |
| `public/manifest.webmanifest`, icons | Install metadata and imagery |

The browser uses native ES modules. It has no framework, bundler, generated client, or static type checking.

## Build and Runtime Flow

1. `npm run typecheck` runs `tsc --noEmit` over `src/**/*.ts`.
2. `npm run build` emits ES2022 NodeNext JavaScript to `dist/`.
3. `npm test` runs `test/*.test.ts` with Node's test runner and `tsx`.
4. `npm start` rebuilds and launches `dist/server.js`.
5. Static `public/` files are served without transformation.
6. `npm prepack` builds before the package allowlist is assembled.
7. Native deployments install an exact release under `~/.local/share/joint-bob/app`, back up SQLite, restart the user service, and verify health.

## Recurring Code Patterns

- Zod schemas validate HTTP and WebSocket boundary input.
- Persistence modules lazily open independent `DatabaseSync` handles to one WAL-mode `node.db`.
- Multi-row writes commonly use explicit `BEGIN`/`COMMIT`/`ROLLBACK` transactions.
- Peer state converges through authenticated REST, outboxes, receipts, retries, and reconciliation.
- Pi and Claude are normalized behind adapter concepts, but execution still branches because one is an SDK and one a subprocess.
- Compatibility aliases support prior `.pi-mobile-web`, `PI_*`, and `MASTER_BOB_*` identities.

## Structural Hotspots

- `src/server.ts` is 3,719 lines and combines composition with domain orchestration.
- `public/app.js` is 4,057 lines and combines state, transport, rendering, and navigation.
- `src/store.ts`, `src/cluster.ts`, `src/tasks.ts`, and `src/github-auth.ts` exceed 500 lines.
- Handwritten browser/server contracts and distributed SQLite schema setup increase change coupling.
