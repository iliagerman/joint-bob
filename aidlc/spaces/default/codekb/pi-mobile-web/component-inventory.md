# Component inventory

## Inventory summary

Joint Bob is one deployable application with internal source modules, static browser modules, a published CLI, and operational assets. Health ratings reflect current structural risk, not runtime availability.

| Component | Source | Owns | Depends on | Health |
|---|---|---|---|---|
| Application composition and transport | `src/server.ts`, `src/app.ts`, `src/websocket.ts` | HTTP, WebSocket, proxy, orchestration, startup | Nearly every backend component | Degraded |
| Account and node state | `auth.ts`, `preferences.ts`, `settings.ts`, `audit.ts` | Administrator, sessions, preferences, settings, audit | SQLite, crypto, managed home | At risk |
| Project domain and persistence | `store.ts`, `types.ts`, `names.ts` | Projects, aliases, types, colours, locations, names | SQLite, replication, filesystem | At risk |
| Task domain and workspaces | `tasks.ts`, `task-workspaces.ts` | Tasks, leases, execution, handoffs, ticket workspace lifecycle | SQLite, replication, cluster, filesystem, worktrees | At risk |
| Git worktree operations | `worktrees.ts` | Legacy worktrees, branch bundles, merge and abort | Git subprocess, filesystem | Healthy |
| Cluster and replication | `cluster.ts`, `replication.ts` | Nodes, peers, tokens, tombstones, event outbox and receipts | SQLite, crypto, peer REST | At risk |
| GitHub credential management | `github-auth.ts` | Credential groups, project assignments, encrypted replication | SQLite, crypto, cluster, audit | At risk |
| Agent adapters | `pi-service.ts`, `claude-service.ts`, `harnesses.ts` | Model inventory, session access, agent execution, transcript conversion | Pi SDK, Claude CLI, settings, paths, GitHub env | At risk |
| Conversation discovery | `session-paths.ts`, `watcher.ts`, `conversation-reviews.ts` | Path mapping, session watches, review state | Filesystem, SQLite, project records | At risk |
| Syncthing adapter | `syncthing.ts` | Devices, folders, ignores, readiness, scans, sync status | Syncthing REST, settings, task workspace paths | Healthy |
| Push notifications | `push.ts` | VAPID keys, subscriptions, completion notifications | SQLite, crypto, `web-push` | Healthy |
| Filesystem management | `project-directory-import.ts`, `managed-home.ts` | Managed roots, imports, moves, symlinks, relocation rollback | Filesystem, settings | Healthy |
| Skill discovery | `skills.ts` | Pi and Claude skill inventory | Filesystem, harness IDs | Healthy |
| Browser PWA | `public/index.html`, `app.js`, `styles.css`, `boot.js`, `sw.js`, manifest and icons | UI state, navigation, chat, settings, offline shell, notifications | REST, WebSocket, browser APIs | Degraded |
| Kanban board UI | `public/board.js` | Board columns and task-card rendering | Browser PWA state and callbacks | Healthy |
| Markdown renderer | `public/markdown.js` | Safe chat content rendering and code/table presentation | DOM APIs | Healthy |
| CLI and packaging | `bin/joint-bob.mjs`, `package.json`, lockfiles | npm entry point, install and doctor, published file set | Node, npm, scripts | At risk |
| Deployment and smoke infrastructure | `scripts/`, `deploy/`, `Justfile`, release workflow | Native services, pinned runtimes, deployment, EC2 smoke tests, npm release | Bash, Terraform, AWS, GitHub Actions | At risk |

## Backend components

### Application composition and transport

Central composition root. Registers 83 REST method/path combinations and `/ws`, applies authentication and security headers, proxies peer traffic, runs tasks, starts watchers, serves static files, and schedules reconciliation. Its high fan-in and 3,521-line size make it the main coupling hotspot.

### Account and node state

Owns administrator setup, scrypt password verification, browser sessions, forced password changes, CSRF-related session state, preferences, encrypted settings, and audit events. Modules open separate handles to `node.db`; encryption helpers overlap with other credential components.

### Project domain and persistence

Owns project records, aliases, user-defined project types, paths, colours, node locations, names, and legacy migration. `types.ts` defines shared project, task, session, model, and status structures, so it also acts as a cross-component contract file.

### Task domain and workspaces

Owns Kanban records, phase configuration, execution leases, handoff protocol state, task replication, synchronized ticket workspace paths, and workspace deletion. It coordinates with agent execution and Git worktree operations through the transport component.

### Git worktree operations

Encapsulates Git repository validation, worktree creation and removal, branch bundle export and checksum, incoming preparation, fast-forward checks, merge, and abort. It is used only for legacy Git-backed tasks.

### Cluster and replication

Owns the five-node membership model, encrypted peer tokens, membership tombstones, event outboxes, peer receipts, retries, task and name replication support, and peer liveness. Direct peer calls remain orchestrated in `server.ts`.

### GitHub credential management

Owns encrypted GitHub credential groups, project overrides, authenticated replication events, delivery receipts, and migration from legacy storage. It injects credentials into agent and Git subprocess environments.

### Agent adapters

`harnesses.ts` provides a small shared registry for Pi and Claude session discovery. Pi runs through an embedded SDK and exposes model and thinking-level APIs. Claude runs as a CLI subprocess with streamed JSON and accepts model and effort arguments. Different execution models force engine-specific branches in `server.ts`.

### Conversation discovery

Maps project paths across nodes and legacy locations, scans Pi and encoded Claude transcript directories, watches filesystem changes, and stores review status. The broad search paths improve migration compatibility but expand conversation-isolation logic.

### Syncthing adapter

Wraps Syncthing's REST API for device and folder setup, ignore rules, folder status, readiness, engine config shares, ticket workspaces, project folders, and rescans.

### Push notifications

Generates and encrypts VAPID keys, stores subscriptions, and sends completion notifications. The service worker displays and routes notification clicks.

### Filesystem management

Computes managed roots and performs project copy, move, move-with-symlink, and relocation operations. Rollback logic protects failed relocations.

### Skill discovery

Scans Pi and Claude user and project skill directories and returns normalized skill metadata to the browser.

## Browser and operations components

### Browser PWA

Unbundled native JavaScript application. It owns project and conversation lists, settings, dialogs, chat state, socket lifecycle, reconnection, attachments, notifications, responsive view state, and most rendering. At mobile widths it shows one panel and a fixed bottom navigation. Chat controls below the top bar currently overflow into a horizontally scrollable hidden-scrollbar row.

Model controls are engine-specific. The dialog lists Pi models or fixed Claude models. Claude also shows a reasoning effort selector. Pi thinking commands exist in the WebSocket API, but the current PWA has no direct Pi thinking selector.

### Kanban board UI

Renders task columns and cards and reports task actions through callbacks owned by `app.js`. Keeping board rendering separate reduces some pressure on the main browser module.

### Markdown renderer

Converts agent text into DOM content, including code blocks, links, lists, tables, and copy/download affordances. It avoids a third-party Markdown runtime.

### CLI and packaging

Publishes the `joint-bob` executable and application assets. The CLI exposes installation and diagnostics. `package-lock.json` and `npm-shrinkwrap.json` are identical lockfile-version-3 files and must remain synchronized.

### Deployment and smoke infrastructure

Installs pinned Node, Pi, Claude, and Syncthing versions; creates systemd or launchd services; supports Tailscale Serve; deploys exact Git commits to installed copies; provisions temporary AWS EC2 smoke infrastructure; and publishes tagged npm releases.

## Component boundary findings

- Source-file boundaries are real enough for focused module tests but do not enforce data ownership. Several modules create and alter tables in the same SQLite database.
- `Application composition and transport` owns business orchestration that could otherwise define clearer interfaces among tasks, peers, agents, and synchronization.
- `Browser PWA` is a second composition hotspot. It combines view state, domain actions, networking, and rendering in one file.
- External systems have identifiable adapters, especially Syncthing, Pi, Claude, Git, and Web Push. Peer Joint Bob calls are less isolated because `server.ts` constructs many requests directly.
