# Component Inventory

## Inventory Summary

Health reflects structural/change risk, not current process availability.

| Component | Source | Responsibility | Main dependencies | Health |
|---|---|---|---|---|
| Application composition and transport | `server.ts`, `app.ts`, `websocket.ts`, `terminal-session.ts` | REST, WebSocket, proxying, startup, orchestration | All backend components | Degraded |
| Account and node state | `auth.ts`, `preferences.ts`, `settings.ts`, `audit.ts` | Identity, sessions, preferences, settings, audit | SQLite, crypto | At risk |
| Project domain and persistence | `store.ts`, `types.ts`, `names.ts`, `project-locks.ts` | Projects, aliases, types, names, locks | SQLite, filesystem, replication | At risk |
| Task domain and workspaces | `tasks.ts`, `task-workspaces.ts` | Tasks, leases, execution, handoff, ticket workspaces | SQLite, cluster, Syncthing, agents | At risk |
| Git worktree operations | `worktrees.ts` | Legacy worktrees, bundles, merge, abort | Git, filesystem | Healthy |
| Cluster and replication | `cluster.ts`, `replication.ts` | Membership, peers, tokens, outbox, receipts | SQLite, crypto, peer REST | At risk |
| GitHub credential management | `github-auth.ts` | Encrypted credential groups and replication | SQLite, crypto, cluster | At risk |
| Agent adapters | `pi-service.ts`, `claude-service.ts`, `harnesses.ts` | Engine execution and normalized events | Pi SDK, Claude CLI, filesystem | At risk |
| Conversation discovery | `session-paths.ts`, `watcher.ts`, `conversation-reviews.ts` | Discovery, watches, review state | Filesystem, project paths, SQLite | At risk |
| Syncthing adapter | `syncthing.ts` | Devices, folders, ignores, readiness, scans | Syncthing REST, settings | At risk |
| Push notifications | `push.ts` | VAPID keys, subscriptions, completion push | SQLite, crypto, Web Push | Healthy |
| Filesystem management | `managed-home.ts`, `project-directory-import.ts` | Managed roots, imports, moves, symlinks | Filesystem, settings | Healthy |
| Skill discovery | `skills.ts` | Pi and Claude skill inventory | Filesystem, harness IDs | Healthy |
| Browser PWA | `index.html`, `app.js`, `styles.css`, `boot.js`, `sw.js` | State, navigation, chat, settings, offline shell | REST, WebSocket, browser APIs | Degraded |
| Kanban board UI | `board.js` | Board and task-card rendering | Browser PWA callbacks | Healthy |
| Markdown renderer | `markdown.js` | Safe rich message rendering | DOM APIs | Healthy |
| CLI and packaging | `bin/`, package metadata | Install/doctor entry point and publish set | Node, npm, scripts | At risk |
| Deployment and smoke infrastructure | `scripts/`, `deploy/`, `Justfile`, release workflow | Install, services, deploy, smoke, release | Bash, Git, Terraform, AWS, GitHub | At risk |

## Backend Components

### Application composition and transport

Registers 86 Express handlers and `/ws`, enforces browser/machine authentication, serves the PWA, proxies peers, attaches terminals, runs tasks, and schedules reconciliation. At 3,719 lines, `server.ts` is the highest fan-in/fan-out component.

### Account and node state

Owns administrator setup, scrypt verification, browser sessions, cookies, password-change state, preferences, encrypted settings, and audit records. Separate SQLite handles and overlapping encryption utilities increase maintenance risk.

### Project domain and persistence

Owns project records, aliases, types, colours, node paths, replicated names, and project locks. `types.ts` is also a shared domain/transport contract, increasing fan-in.

### Task domain and workspaces

Owns board records, phase settings, leases, task execution state, two-phase handoffs, tombstones, and synchronized ticket workspace lifecycle. It coordinates the largest cross-boundary transaction after the server.

### Git worktree operations

Encapsulates legacy Git task validation, worktree creation/removal, checksummed branch bundles, incoming preparation, merge, and abort. New ticket workspaces do not use branches.

### Cluster and replication

Owns local identity, five-node membership, encrypted machine tokens, tombstones, outboxes, receipts, retries, and convergence. Many peer calls remain composed directly in `server.ts`.

### GitHub credential management

Owns encrypted groups, project assignments, credential event delivery, receipts, and legacy migration. Credentials replicate through application records, not Syncthing.

### Agent adapters

Pi runs in-process through the SDK; Claude runs as a stream-JSON child process. Both expose normalized session and event concepts, but execution differences remain visible in transport orchestration.

### Conversation discovery

Resolves canonical, mapped, legacy, encoded Claude, and ticket-workspace paths; watches transcript changes; and stores per-user review state. Broad compatibility increases isolation and timestamp complexity.

### Syncthing adapter

Discovers loopback configuration and manages devices, folders, ignore lists, readiness, status, and rescans. Current ordinary `__pycache__/` semantics directly cause blocked remote directory deletes in the live `beecomm` folder.

### Push notifications

Generates/encrypts VAPID keys, persists subscriptions, and sends completion notifications. The service worker displays and routes notification clicks.

### Filesystem management

Computes managed roots and performs copy, move, move-with-symlink, relocation, and rollback. Filesystem identity is a security boundary because agents and downloads operate within project paths.

### Skill discovery

Scans Pi and Claude user/project skill locations and returns normalized metadata. It is read-only apart from ordinary filesystem access.

## Browser and Delivery Components

### Browser PWA

An unbundled native JavaScript application. `app.js` owns state, APIs, WebSockets, stream batching, rendering, dialogs, responsive navigation, review actions, terminals, and notifications. Its 4,057-line size and untyped contracts make it a change hotspot.

### Kanban board UI

Renders columns/cards and delegates actions to callbacks in `app.js`. The file offers a useful rendering boundary but does not own task state or transport.

### Markdown renderer

Converts agent output to safe DOM structures for headings, links, lists, tables, code, copy, and downloads without a third-party Markdown runtime.

### CLI and packaging

Publishes `joint-bob` with `install`, `doctor`, and help. Package allowlisting, two lockfiles, runtime pins, and release metadata form the install contract.

### Deployment and smoke infrastructure

Installs pinned Node, Pi, Claude, and Syncthing; configures systemd/launchd; exposes private HTTPS; deploys exact commits; provisions temporary `/32`-restricted EC2 smoke hosts; and publishes tagged releases.

## Boundary Findings

- Source modules are independently testable, but shared SQLite weakens ownership isolation.
- `Application composition and transport` owns business workflows that should remain explicit even if later extracted into smaller internal modules.
- `Browser PWA` is a second composition root with state, networking, and rendering tightly coupled.
- External adapters are clear for Pi, Claude, Syncthing, Git, and Web Push; peer HTTP is less isolated.
- Conversation review and Syncthing ignore migration are small components with high correctness/data-loss consequences and require targeted regressions.
