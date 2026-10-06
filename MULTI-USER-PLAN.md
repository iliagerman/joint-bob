# Multiple users on one node — plan for review

Status: **draft, not implemented.** Mockups: [mockups/multi-user.html](mockups/multi-user.html). Open it in a browser and use "View as" to compare the admin, a member, and the same member signed in on another node.

## 1. Goal

Several people sign in to the same node and work at the same time.

- **A wall between users.** No user, including the admin, can see or reach another user's projects, conversations, files, settings, secrets, processes or activity, through the app or through an agent or terminal.
- **One admin, hidden from everyone else.** The first user on a node is its admin. Members never see admin features: no menu entries, no read-only views, no "ask your admin" hints. The server answers admin routes with 404 for them.
- **Settings follow the user.** Signing in on another node in your clusters feels like signing in at home: same theme, shortcuts, labels, commands, skills, model defaults and notification setup.
- **Terminal off by default**, enabled only by the admin.
- **Every chat message shows its author.**
- **The cloned-user feature keeps working.** Its limits on the visited node stay exactly as they are. Section 3.8 extends it so the user's own settings come along.

## 2. What exists today

- **One local user per node.** `createAdministrator` refuses once any user exists (`src/auth.ts:166`). The "home user" is the single row with `home_node_id IS NULL`, and `getHomeUserForReplication` assumes there is exactly one.
- **Replicated users** are copies of another node's home user (`src/user-replication.ts`). They log in with `isRemoteLogin` and get only the `conversations` feature (`src/features.ts`). They can't open the terminal (`src/server/chat-socket.ts:216`) and see only projects shared through their home node's clusters (`src/server/routes/projects.ts:32`).
- **No ownership on data.** `workspaces`, `projects`, `secret_accounts`, `cron_tasks`, `browser_profiles`, `routing_configs` and `quick_notes` have no owner column. Node settings live in one `node_settings` table.
- **Per-user data is keyed by bare username and replicates everywhere.** This covers pins, recents, canvas shortcuts and review watermarks (`src/canvas-shortcuts.ts:10`). Events without a project "are user-global and replicate everywhere" (`src/replication.ts:91`). A different person with the same username on another node would share these rows.
- **No process isolation.** The server, every harness, the terminal and background tasks all run as one OS user. That includes Claude with `bypassPermissions`, Kiro with `--trust-all-tools`, and Pi inside the server process. Any agent shell can therefore read:
  - `~/.joint-bob/node.db`
  - `secret.key`, which decrypts every secret
  - `supervisor.db`, which holds the admin token
  - every transcript under `~/.claude`, `~/.pi` and `~/.kiro`
- **The terminal is always on for local browsers** (`src/server/routes/projects.ts:321`).
- **Messages have no author.** `ChatMessage` (`src/types.ts:197`) has no user field.

Hiding things in the UI is therefore not isolation. **The wall needs a separate OS account for every Joint Bob user, the admin included.** In multi-user mode the service account runs only the Joint Bob server itself.

## 3. Design

### 3.1 Identity
- **Every account has an `accountId`**, a random UUID created with the user that never changes. It's the key for ownership, replication and message authors. Accounts created before this change get a deterministic id, `sha256(homeNodeId + ":" + username)`, so every node computes the same one without coordinating.
- **Every user has an email.** It's required when the admin creates a user and is unique, case-insensitively, on the node and in everything replicated to it. A replicated user whose email belongs to a different account is rejected, as usernames are today. After the upgrade, the existing home user is asked for an email at their next sign-in.
- **The UI shows the email** wherever it shows a person: the Users tab, message authors, cluster member lists and My nodes. Sign-in accepts either the email or the username.
- Local accounts have `users.role` set to `admin` or `member`. Replicated accounts have no local role.
- Every username-keyed table becomes keyed by `accountId`: pins, recents, canvas shortcuts, review watermarks, notification preferences and subscription plans. Existing rows move to the node's current home user. This closes the existing gap where two different people named "noam" on two nodes would share rows.

### 3.2 Admin
- The first local user is the admin. On upgrade, the existing home user becomes the admin. A node has exactly one admin, who can transfer the role to a member; the member must accept. A node never has zero admins.
- The admin creates, disables and deletes users. A new user gets a one-time password and must change it at first sign-in (the existing `must_change_password` flow).
- **The admin sees accounts, not activity.** The Users tab shows only username, role, status and creation date. It shows no projects, conversations, usage, running turns or sign-in history for other users.
- Deleting a user deletes their data: OS account, home folder, rows and replicated copies. It takes a typed confirmation. There is no "transfer to admin" option, because that would breach the wall.
- Password reset: see open question 3.

### 3.3 Admin features are invisible to members
- `GET /api/auth/status` returns `role`. The client renders admin pages and menu entries only when `role === "admin"`. Members see no Users tab, node settings, updates, restart, audit log, twins, Syncthing, runtime paths, limits or terminal policy, not even as disabled or read-only entries.
- **The server is the real gate.** Admin routes answer non-admins with **404**, the same as an unknown route. This covers settings writes, users, updates, deploy, twins, node identity, Syncthing, the audit log and terminal policy.
- Node-wide events are neutral for members. An update restart shows "Joint Bob is restarting, reconnecting…". A member is never told about pending updates, other users, or who the admin is.
- Admin-only settings:
  - users and the terminal policy
  - per-user limits
  - harness executables and config/session paths
  - `projects.homePath` and global resource paths
  - Syncthing
  - auto-update and deploy
  - `shellCommandTimeoutSeconds`, `subprocessMaxLifetimeMinutes` and `conversationRetentionDays`
  - `remoteTerminal`
  - the browser executor configuration
  - twins and the node keypair
  - the node audit log

### 3.4 Terminal
- New node setting `terminalAccess`: `off` (default), `admin`, `everyone`, or `selected` with a user list.
- The server enforces it in the `mode=terminal` socket and in the project payload (`terminal` is computed, never hard-coded).
- **When it's off, members see no terminal button at all.** If a member reaches the socket another way, it is refused with a generic "Not available".
- Each terminal runs as its user's OS account, in that user's project directory.
- Limits, set by the admin:
  - at most 2 open terminals per user (default)
  - idle terminals close after 30 minutes (default)
  - every open and close is written to the audit log
- `remoteTerminal` (twins and other nodes) stays as it is and is checked after `terminalAccess`.

### 3.5 The wall
Every route, socket event, search, list and background job is scoped to the signed-in account. This table is the acceptance criteria.

| Data | Owner | Other users on the node (incl. admin) | Cluster peers |
|---|---|---|---|
| Projects, tickets, conversations, files | full | invisible (404) | only projects the owner shared with that cluster |
| Settings, commands, skills, shortcuts, labels, pins | full | invisible | only nodes the owner signed in to (3.8, 3.9) |
| Secrets and their labels | full | invisible | only with today's opt-in replicate flag, to the owner's own sessions |
| Running turns, background tasks, browser sessions, usage, cost | full | invisible | — |
| Audit events about the user's own data | full | invisible | — |
| Existence of the account | — | admin sees the username in Users; members see nothing | members of the same cluster see it in that cluster's member list |

Users signed in from other nodes get the same wall on the node they visit.

**In the app:**
- Add `owner` (account) to `workspaces`, `projects`, `secret_accounts`, `cron_tasks`, `browser_profiles`, `browser_monitor_monitors`, `routing_configs`, `quick_notes`, scoped skills and skill shares. Tickets and conversations inherit their project's owner. Migration assigns existing rows to the admin.
- Every lookup filters by owner, and a foreign id returns **404**, never 403.
- Errors are uniform and never name another user's resource. Example: no "path already used by project X".
- `broadcastToAllClients` and `broadcastToProject` deliver only to the owner's sockets. The same applies to search (`src/search.ts`), the usage dashboard, task lists, browser profiles and notifications.
- Browser profile sharing scopes change. "Machine" becomes "all my conversations on this machine", and "workspace" and "project" are limited to the owner's own. No scope can reach another local user.
- Singletons become per user: the routing selection, the quick-note queue, and the `ntfy.services` list.
- Server logs never contain prompts, file contents or secrets. Pre-deploy database backups are readable only by the service account.

**On the machine:**
- Every user, the admin included, gets an OS account `jb-<username>` in group `jointbob-users`, with a `0700` home folder. Each account holds its transcripts, MCP config, commands, skills, `TMPDIR`, git credential helper and managed `~/JointBob` projects.
- **Model subscriptions are node-wide.** The admin signs in to Claude, Kiro or Codex once, in the service account. The server hands each run the node's credentials (an OAuth token in the environment, or a read-only credentials file in that user's own config directory), while sessions and transcripts stay in the user's home. A user's agent can read the credential it's given, so sharing the subscription means sharing that credential; the admin chooses that by signing in. Later, a user can sign in with their own account, which then overrides the node's for their runs.
- The service account owns `~/.joint-bob` (`0700`). It reads users' homes through group permissions so it can show their transcripts. No `jb-*` account can read the service home or another user's home.
- A root-owned helper, `joint-bob-userctl`, is installed once with `sudo` (`just install-multi-user`). It can only:
  - create a `jb-*` account
  - delete a `jb-*` account
  - run a command as a `jb-*` account

  It refuses any account outside `jointbob-users`. On Linux it uses `useradd`/`userdel` plus a sudoers rule for exactly this helper. On macOS it uses `sysadminctl` with a hidden `dscl` user.
- These run as the user's account:
  - Claude and Kiro processes
  - the supervised shell (`scripts/supervised-shell-worker.mjs`)
  - background tasks
  - the terminal (`src/terminal-session.ts`)
  - **a Pi worker process per user.** Pi leaves the server process, because its file tools would otherwise run with server privileges and `PI_CODING_AGENT_DIR` is process-wide. This is the largest single engineering item.
- Supervisor and browser CLIs reach the server through its HTTP API with the existing scoped tokens. The raw supervisor socket stays service-only. `JOINT_BOB_TASK_DATA_DIR` is no longer exported to agents.
- **Processes.** Linux mounts `/proc` with `hidepid=2` (set by the installer), so users can't list each other's processes. macOS already hides other users' process arguments and environments. Secrets and prompts are never passed in argv.
- **Local ports.** A user's processes can't connect to ports opened by another user's processes, such as dev servers or debug ports. Linux uses `nftables` rules matching the socket owner (`meta skuid`). macOS uses `pf` rules with `user`. The Joint Bob server port stays reachable and is authenticated anyway.
- **Syncthing** runs as the service account. It syncs users' project folders through the same group permissions, and its UI and folder list are admin-only.
- **Self-test.** "Add user" stays disabled until a self-test passes. The self-test creates two throwaway accounts and confirms each can't read the other's home, `node.db` or `secret.key`, can't see the other's process arguments, and can't connect to the other's local port. It then deletes both accounts.

**Entering multi-user mode** happens once, when the admin installs the helper. The admin's agent runtime moves from the service account into `jb-<admin>`:
- `~/.claude`, `~/.pi` and `~/.kiro` sessions and logins
- MCP config, commands and skills
- `~/JointBob` projects, with project paths rewritten through the existing project-path mapping

A full backup is taken first, and the move refuses to start while any turn is running. Single-user nodes that never enable multi-user mode are untouched.

### 3.6 Per-user resources
| Resource | Today | Plan |
|---|---|---|
| Theme, sounds, canvas layout, keymap | `user_preferences` | unchanged, plus roaming (3.9) |
| Pins, recents, canvas shortcuts, push/ntfy subscriptions | bare username | keyed by account, plus roaming |
| Conversation labels, history days, auto-compact, digest attachments, start/end prompts, default models | `node_settings` | moved to the user's profile; the admin keeps the current values |
| Commands, user skills, MCP | harness config dir, `.agent-resources` | in the user's home, plus roaming |
| Scoped and shared skills | `scoped-skills/index.json`, `skill_*` | add an owner, filter |
| Secrets and labels, GitHub accounts | `secret_accounts` | add an owner; scopes only to the owner's workspaces, projects and conversations |
| ntfy servers | encrypted `node_settings` | per user, plus roaming |
| Cron, browser profiles and monitors, routing configs, quick notes and queue | node or project | add an owner |
| Usage and cost | node-wide events | per account; each user sees only their own |
| Model sign-ins (Claude, Kiro, Codex) | service account home | **node-wide and shared**: the admin signs in once and every user's runs use it (3.5) |

### 3.7 Clusters per user
- Node identity, keypair and the cluster protocol stay node-level, and peers still trust nodes. A local table `cluster_local_members(cluster_id, account, joined_at)` records which users joined each cluster. The node is a member while at least one local user is.
- Members create, join and leave clusters themselves. A user can share only their own projects, and only to clusters they joined. Received projects are visible only to the local users who joined that cluster.
- **Joining a cluster lets you sign in on every node in it**, unless that node blocks your home node (3.10).
- Project and event payloads carry `owner`, so peers know whose project it is.
- Twins stay node pairs and admin-only.

### 3.8 Replication scope (fixes today's leak, ships first)
**Today:** per-user events are keyed by bare username, and any event without a project goes to every peer (`src/replication.ts:91`). Recents carry conversation titles and file paths. Renamed conversations and conversation ownership also go everywhere.

**Rule: every event type declares a scope, and anything without one is not sent.** A test lists every `entityType` and fails when one has no scope.

| Scope | Goes to | Event types |
|---|---|---|
| **Credentials** | Every node in every cluster the user joined, minus nodes that block the user's home node, or that the home node blocks. This is what lets you sign in anywhere in your clusters. | the login record (today's user replication: password hash, MFA) |
| **Account** | The user's home node, its twin, and **only the nodes the user has signed in to** (3.9). | profile, pins, recents, canvas shortcuts, review watermarks, notification preferences, personal conversation names |
| **Project** | Nodes the project is shared with (today's sharing filter). | tasks, conversation records, queue, goals, routing, locks, usage of shared projects, project names |
| **Node** | Cluster members, as today. | membership, hubs, ownership of shared conversations, blocks (3.10) |

On top of the scope:
- **Keyed by account.** Every per-user row and event uses `(homeNodeId, username)`, so two different "noam"s never share data. Existing rows move to the node's current home user.
- **Minimal payloads.** Account events carry ids, timestamps and setting values only, with no conversation titles, file paths or prompt text. The receiving node shows titles from records it's already allowed to see.
- **Dropped when the receiver can't see the target.** A pin or recent pointing at a conversation the receiving node can't reach isn't sent.
- **Older peers.** For peers on the old version, the sender adds the legacy fields only for peers in the same cluster, and stops once every peer has upgraded.

### 3.9 Roaming: you on another node (extends the cloned-user feature)
**Signing in.** Your login record is on every node in your clusters (credentials scope), so you can sign in on any of them unless it's blocked. There you are a replicated user, as today: `isRemoteLogin` is set, you get no terminal, and you can't see that node's admin features, users or settings. The replication payload, signature, home-node check and `upsertReplicatedUser` rules are unchanged, so older peers still accept them.

**Your information follows you to every node you sign in to, and only there:**
1. On your first sign-in on a node, your home node sends it a signed snapshot of your profile. Until the snapshot lands, the pages show "Loading your settings from studio-mac…".
2. From then on, every account-scope event also goes to that node, so it stays current.
3. The copy stays there until any of these happens:
   - you choose **Forget this node**
   - you leave the last cluster you share with it
   - your account is deleted
   - either node blocks the other

   When that happens, the node deletes the copy and your home node stops sending to it.

**The profile contains:**
- preferences, pins, recents and canvas shortcuts
- conversation labels, model defaults and start/end prompts
- ntfy servers and subscriptions
- commands
- skills and MCP definitions
- secret labels and metadata, never secret values

**What you see there:**
- **My settings, My clusters, My nodes, My secrets, Commands & skills and Shortcuts**, showing your own values.
- Projects shared into clusters you're in, your own and other people's, as today.
- **Your unshared projects too** (phase 7, section 3.13), through a live link to your home node.

**Edits** you make there are forwarded to your home node, which applies them and sends them back out. If your home node is offline, your settings pages are read-only, with a banner.

**Where agents run.** In your own projects, shared or not, the agent always runs at home, under your account, with your skills, MCP and secrets, using the node's model subscription. That's exactly as if you were at home. In a project someone shared with you, the agent runs in the owner's environment, as today. Your UI settings, labels and commands (expanded as prompt text) still apply there, but your skills, MCP and secrets are never copied into another user's account.

**The wall holds on the visited node too.** That node's local users and admin can't see your profile, your sessions or what you do there.

**My nodes** (new page): every node in your clusters, each with a status: home, signed in, can sign in, or not available. It has a **Forget this node** button. "Not available" covers both offline and blocked, and says no more.

### 3.10 Blocking nodes
- **Admin-only setting: Blocked nodes.** The admin picks any node from the clusters this node's users belong to. The default is none. Blocking doesn't remove anyone from a cluster, and the other members are unaffected.
- **A block works both ways.** When studio-mac blocks build-01:
  - studio-mac refuses build-01's signed requests and proxied sockets.
  - It removes replicated users from build-01 along with their profile copies, ends their sessions, and accepts no new login records from build-01.
  - Its users' login records and profiles are no longer sent to build-01, and build-01 is told to delete the copies it has.
  - Projects shared between the two nodes stop syncing in both directions. Each side keeps what it owns.
  - Events from build-01 are dropped even when another member relays them through a hub, checked by origin signature.
- **The cluster stays consistent.** studio-mac publishes a signed block notice to the cluster, so hubs stop relaying between the pair. Membership administration (invitations, manager transfer, removal) still flows, because it carries no user data.
- **Visibility.** build-01's admin sees "studio-mac doesn't accept connections from this node". build-01's users just see studio-mac as "not available" in My nodes.
- **Twins can't be blocked.** The admin unpairs first.
- **Unblocking** restores sync. Users get a fresh profile copy at their next sign-in.

### 3.11 Message authors
- `ChatMessage.author?: { username, homeNodeId }`.
- The author is captured at the socket from the login session and stored on the prompt-queue row. It is included in `userMessage` and `queuedPrompts` events and persisted in `conversation_message_authors(conversation_key, message_id, username, home_node_id)`, because harness transcripts can't carry extra fields. History reload joins it back in.
- Across nodes, the proxied socket adds a signed `x-joint-bob-author` header. The owning node accepts it only with a verified peer signature.
- Every user bubble shows the name before the timestamp. A user from another node shows as `dana · homeserver`. Older messages show no name.
- When more than one person has written in a conversation, the agent sees `[dana]` before each prompt. Single-author conversations are unchanged.
- Authors only ever appear in shared cluster projects and in your own conversations, so they don't breach the wall.

### 3.12 Running at the same time
- Each user has their own queues, Pi worker, harness processes and model sign-ins, so nothing is shared between users' turns.
- Process-global state is removed: Pi's `PI_CODING_AGENT_DIR` (now per worker) and the routing and quick-note singletons. Project locks are recorded as `nodeId:account`.
- The admin can cap concurrent agent turns per user (default 3). CPU, memory and disk quotas are a later phase.

### 3.13 Your unshared projects on other nodes (phase 7)
Signed in on another node, you see all your own projects, not only the shared ones, as if you were at home. They **travel live and are never copied**:
- **Live link.** The visited node relays your requests to your home node through the same signed peer proxy that conversations already use (`src/server/chat.ts` `proxySocket`). Each request carries your account in a signed header (as in 3.11). Your home node answers only if all of these hold:
  - the request has a valid peer signature
  - the visited node is in one of your clusters
  - neither node blocks the other
  - your account has signed in there
- **Nothing is stored on the visited node.** Your unshared projects create no replication events and no Syncthing folders. Responses aren't written to disk or put in any cache, and file downloads stream straight to your browser. When you sign out, the visited node has nothing of them left.
- **Everything runs at home.** Conversations, agents, files, git and tasks all run on your home node, under your account, with your skills, MCP and secrets, using the node's model subscription. The visited node never runs anything for these projects. As before, you get no terminal on another node.
- **Your control:**
  - **Show my projects on other nodes** in My settings, on by default.
  - A per-project **Hide from other nodes** switch.
  - **Forget this node** (3.9) ends the link to that node.
- **Offline.** If your home node is offline, these projects are listed as "home offline" and can't be opened. Nothing is held on the visited node that could show stale content.
- **The wall.** The relay is server code on the visited node. That node's users and admin get no view of it in the app, its logs carry no content, and the trust boundary for someone with `sudo` there is the same as in open question 8.
- **Sharing is unchanged.** Other people still see only what you share into a cluster.

## 4. Phases

Each phase ships on its own. Single-user nodes keep today's behaviour, except that the terminal is off by default.

1. **Replication scope and node blocking.** Account keys, a declared scope for every event type, minimal payloads, the legacy fallback for older peers, and Blocked nodes. Fixes today's leak and doesn't need multi-user mode.
2. **Roles and hidden admin.** `users.role`, admin-only gating with 404s, the hidden admin UI, and the terminal policy with its limits and audit.
3. **Message authors.** Data model, queue, events, peer header and UI. Independent of the rest.
4. **Machine wall.** `joint-bob-userctl`, OS accounts, run-as for all agent processes, the Pi worker, permissions, `hidepid`, port rules, the self-test, and the admin's move into `jb-<admin>`. This is the largest phase, and no second user can be added before it ships.
5. **App wall and users.** Users tab, owner columns, 404 scoping on every route, socket, search and usage, and per-user resources. Turns on "Add user".
6. **Clusters and roaming.** Per-user cluster memberships, credentials for every user replicated to their clusters, profile snapshots on first sign-in, My nodes, and edit forwarding.
7. **Your unshared projects on other nodes** (3.13). The live link home, relay without storage, per-project hiding, and offline handling. Builds on phase 6.

## 5. Testing

Following `TESTING.md` (disposable data dirs, synthetic accounts, loopback servers):

- **Machine wall**, run on Ubuntu (EC2 smoke test) and macOS:
  - From user A's agent and terminal, reading `node.db`, `secret.key`, `supervisor.db`, B's home and B's transcripts is refused.
  - A can't see B's process arguments or connect to B's dev server port.
  - The admin's agent gets the same results against a member.
- **App wall:** a generated test calls every registered route with B's ids from A's session and expects 404.
  - WebSocket: A receives no event about B.
  - Search, usage, tasks, browser profiles and notifications return nothing of B's.
  - Error messages never contain B's names or paths.
- **Hidden admin:** as a member, the rendered DOM contains no admin entries, and every admin route returns 404.
- **Roaming:**
  - B signs in on a peer and sees their own theme, labels, shortcuts, commands and skills.
  - An edit there lands on B's home node and comes back.
  - With the home node offline, the pages are read-only.
  - A same-named user on the peer never receives B's profile.
  - B's profile reaches a node only after B signs in there, and is deleted after "Forget this node".
  - B can sign in on every node in B's clusters, except one that blocks B's home node.
- **Replication scope:**
  - Every `entityType` has a declared scope.
  - An account event never reaches a node the user hasn't signed in to.
  - Recents arrive without titles or paths.
  - A same-named user on another node receives nothing.
- **Blocking:**
  - After A blocks B, B's signed requests, sockets, sign-ins and hub-relayed events are refused.
  - Copies on both sides are deleted.
  - The rest of the cluster keeps syncing.
  - Unblocking restores sync.
- **Unshared projects on other nodes:**
  - B signs in on a peer and opens an unshared project. Every request lands on B's home node.
  - After a long session on the peer, its data directory, database and caches contain nothing from that project.
  - The link refuses requests without B's signed account, from a node outside B's clusters, from a blocked node, or for a project marked "Hide from other nodes".
  - With B's home node offline, the project shows "home offline" and can't be opened.
- **Cloned users (regression):** the existing replicated-user tests pass unchanged, and an older peer accepts the new payloads.
- **Concurrency:** two users run turns in parallel, each with their own Pi worker and model sign-in.
- **Authors:** local, replicated and peer-proxied prompts show the right name after reload.

## 6. Decisions

1. **Terminal on upgrade:** off everywhere, existing nodes included, with a one-time notice to the admin and one-click enable.
2. **Two local users in one cluster:** they don't see each other's projects shared with that cluster; they do see each other in its member list.
3. **Password reset:** the admin can't reset a password. A user uses an MFA recovery code, or the admin deletes the account and its data.
4. **Admins:** exactly one per node, transferable with the other person's acceptance.
5. **Model subscriptions:** node-wide, shared by every user on the node. Per-user sign-in that overrides the node's comes later.
6. **People across clusters:** identified by `accountId` and shown by their unique email (3.1).
7. **Blocking:** whole nodes only.
8. **Trust boundary:** the wall holds against every Joint Bob user, the admin included, not against someone with `sudo` on the machine. The docs say so.
