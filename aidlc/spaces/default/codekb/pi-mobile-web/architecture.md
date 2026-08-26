# Architecture

## Architecture analysis

### System overview

Joint Bob is a stateful Node.js application deployed once per participating machine. One process hosts an Express REST API, a `ws` WebSocket endpoint, static PWA files, peer proxying, background reconciliation, and agent execution. Nodes communicate directly over HTTP and WebSocket. Syncthing handles selected filesystem replication outside the process.

The dominant style is a modular monolith with peer-to-peer cluster behavior. The TypeScript modules separate persistence and integration concerns, but `src/server.ts` remains the 3,521-line composition root and workflow orchestrator. Modules share one node-local SQLite file and often open independent handles to it, so data ownership is weaker than the source-file boundaries suggest.

### Component relationships

```mermaid
flowchart LR
    Browser[Browser PWA] -->|REST and WebSocket| Transport[Application composition and transport]
    Transport --> Account[Account and node state]
    Transport --> Projects[Project domain and persistence]
    Transport --> Tasks[Task domain and workspaces]
    Transport --> Cluster[Cluster and replication]
    Transport --> Agents[Agent adapters]
    Transport --> Discovery[Conversation discovery]
    Transport --> Sync[Syncthing adapter]
    Transport --> Push[Push notifications]
    Transport --> Files[Filesystem management]
    Transport --> Skills[Skill discovery]
    Tasks --> Git[Git worktree operations]
    Cluster -->|peer REST| Peer[Peer Joint Bob node]
    Transport --> DB[(node.db)]
    Projects --> DB
    Tasks --> DB
    Cluster --> DB
    Account --> DB
    Agents --> Disk[(Projects and transcripts)]
    Discovery --> Disk
    Files --> Disk
    Sync --> Syncthing[Syncthing service]
    Agents --> Pi[Pi SDK]
    Agents --> Claude[Claude CLI]
```

**Plain-text fallback:** Browser PWA calls the Node transport. The transport coordinates account, project, task, cluster, agent, discovery, sync, push, filesystem, skill, and Git modules. Application state goes to node-local SQLite; repositories and transcripts stay on disk. Peer nodes use REST and proxied WebSockets. Syncthing, Pi, and Claude are external processes or runtimes.

## Interaction diagrams

### Non-task chat on the UI-selected node

```mermaid
sequenceDiagram
    actor User
    participant PWA as Browser PWA
    participant Local as Local Joint Bob
    participant Peer as Selected peer node
    participant Adapter as Pi or Claude adapter
    participant Files as Project and transcript files

    User->>PWA: Select project, node, engine, and conversation
    PWA->>Local: WebSocket /ws with projectId, sessionPath, nodeId
    alt selected node is remote
        Local->>Peer: Proxy authenticated WebSocket
        Peer->>Peer: Resolve project and local session path
        Peer->>Adapter: Open or create session in project cwd
        Adapter->>Files: Read or append transcript
        PWA->>Peer: Prompt through proxied socket
        Peer->>Adapter: Run prompt with model and effort settings
        Adapter-->>PWA: Status, thinking, text, tools, completion
    else selected node is local
        Local->>Adapter: Open or create session in project cwd
        PWA->>Local: Prompt
        Adapter-->>PWA: Stream events
    end
```

**Plain-text fallback:** The browser puts the selected `nodeId` in the WebSocket URL. The local server handles local execution or proxies the socket to the chosen peer. The node that terminates the socket resolves the project path, opens Pi or Claude in that directory, and streams events back over the same connection.

### Task chat and ownership routing

```mermaid
sequenceDiagram
    actor User
    participant PWA as Browser PWA
    participant Entry as Connected Joint Bob node
    participant Owner as Task owner node
    participant Tasks as Task domain
    participant Workspace as Ticket workspace or Git worktree
    participant Agent as Pi or Claude adapter

    User->>PWA: Open task chat and send prompt
    PWA->>Entry: WebSocket /ws with projectId and taskId
    Entry->>Tasks: Load TaskRecord
    Tasks-->>Entry: currentNodeId and execution state
    alt owner is another node
        Entry->>Owner: Proxy socket to currentNodeId
    end
    Owner->>Workspace: Resolve task cwd
    Owner->>Tasks: Claim lease
    Owner->>Agent: Run configured phase engine and model
    Agent-->>Owner: Stream run events
    Owner->>Tasks: Complete or fail lease and advance state
    Owner-->>PWA: Events and task changes
```

**Plain-text fallback:** Task routing reads `TaskRecord.currentNodeId`; it does not honor a non-task UI node override. The owner node resolves the ticket workspace or legacy worktree, claims a lease, executes the configured phase through Pi or Claude, records the outcome, and streams updates to the browser.

### Task handoff between nodes

```mermaid
sequenceDiagram
    actor User
    participant Source as Source node
    participant SourceTasks as Source task domain
    participant Sync as Syncthing and filesystem
    participant Destination as Destination node
    participant DestTasks as Destination task domain
    participant Git as Git worktree operations

    User->>Source: Request handoff
    Source->>Destination: Check task eligibility
    Destination->>Sync: Check project or ticket workspace readiness
    alt synchronized ticket workspace
        Sync-->>Destination: Folder ready
    else legacy Git-backed task
        Source->>Git: Export branch bundle and checksum
        Source->>Destination: Prepare handoff with bundle
        Destination->>Git: Validate and prepare worktree
    end
    Source->>SourceTasks: Reserve outgoing handoff
    Source->>Destination: Commit handoff
    Destination->>DestTasks: Set currentNodeId and settle ownership
    Destination-->>Source: Acknowledge settlement
    Source->>SourceTasks: Complete outgoing handoff
```

**Plain-text fallback:** Source and destination first verify eligibility. Ticket workspaces rely on Syncthing readiness. Legacy worktrees use a checksummed Git bundle. A prepare, commit, settle, and acknowledgement protocol moves `currentNodeId` while preserving recoverable handoff state.

### Project import and synchronization

```mermaid
sequenceDiagram
    actor Admin
    participant PWA as Browser PWA
    participant API as Project API
    participant Import as Filesystem management
    participant Store as Project persistence
    participant Sync as Syncthing adapter
    participant Peer as Peer node

    Admin->>PWA: Import folder with copy, move, or move-link
    PWA->>API: POST /api/projects
    API->>Import: Copy or relocate project
    Import-->>API: Managed path
    API->>Store: Save project and aliases
    API->>Sync: Ensure project folder and ignore rules
    Sync->>Peer: Share Syncthing folder
    API-->>PWA: Project with sync status
```

**Plain-text fallback:** The API validates an import request, copies or relocates the directory, saves project aliases in SQLite, configures a Syncthing folder with ignore rules, shares it with peers, and returns project sync state.

## Data flow and ownership

| Data | Current owner | Storage and movement |
|---|---|---|
| Administrator, login sessions, preferences, settings, audit | Account and node-state modules | Tables in `~/.joint-bob/node.db`; sensitive settings encrypted with AES-256-GCM |
| Projects, aliases, types, locations, names | Project modules | SQLite plus filesystem paths; selected names and mappings replicate |
| Tasks, leases, handoffs, outboxes | Task and replication modules | SQLite transactions, peer REST, retry reconciliation |
| Repositories and worktrees | Filesystem and Git modules | Local disk; Git subprocesses and branch bundles |
| Ticket workspaces and shareable engine data | Filesystem and Syncthing adapter | Local disk synchronized by Syncthing |
| Pi and Claude transcripts | Agent adapters and discovery | Engine-owned filesystem JSON or JSONL files |
| GitHub, peer, push, and settings secrets | Credential-owning modules | Encrypted SQLite records using a local mode-`0600` key |
| PWA shell | Static server and service worker | `public/`, cache `joint-bob-v25` |

The source declares 43 SQLite tables and 23 guarded `ALTER TABLE` statements across modules. There is no central migration version or ordered migration runner.

## Observed design decisions and trade-offs

No ADRs record the original alternatives. The alternatives below are architectural comparisons, not claims about historical team decisions.

1. **Single deployable process instead of independent services.** This keeps installation, private-network operation, and debugging simple. It also concentrates routing and reconciliation in `src/server.ts` and scales all capabilities together. Separate services would isolate failures and ownership but add deployment and distributed-operations cost.
2. **Node-local SQLite plus filesystem ownership instead of a central database.** Nodes can operate near local repositories and agent installations without a central control plane. Replication, path mapping, tombstones, handoff settlement, and conflict handling become application responsibilities. A central store would simplify consistency but weaken local autonomy and require network availability.
3. **Syncthing for file replication instead of application-level file transfer.** Syncthing supplies device and folder synchronization while Joint Bob manages readiness and ignore policy. This creates an external operational dependency and eventual-consistency boundary. Direct file transfer would increase application code and security responsibility.
4. **Native browser modules instead of a frontend framework and build pipeline.** Static files package and serve directly. The cost is a 3,568-line `public/app.js`, manually duplicated contracts, no frontend static types, and source-regex tests.
5. **Pi SDK adapter plus Claude CLI adapter.** Joint Bob can expose two engines through one UI, but their model and reasoning controls are not symmetrical. Pi exposes runtime thinking APIs; Claude uses CLI `--effort`. Claude runs with `--permission-mode bypassPermissions`.

Security depends on authenticated administration, strict WebSocket origin checks, encrypted secrets, private networking, and filesystem boundaries. No compliance regime is documented. The symlink-following project file download and bypassable agent safeguards make filesystem isolation a material boundary.

## Coupling hotspots and architectural risks

- `src/server.ts` imports nearly every backend module and owns HTTP, WebSocket, peer routing, task execution, background reconciliation, and startup.
- Multiple modules write the same SQLite database through separate handles with different lifecycle and migration behavior.
- Encryption and key-loading logic is duplicated across four credential modules.
- `public/app.js` combines client state, rendering, routing, API calls, dialogs, board coordination, and WebSocket handling.
- Conversation discovery intentionally spans current, mapped, legacy, learned-node, parent-encoded Claude, and ticket-workspace paths. This supports migration but makes isolation rules difficult to reason about.
- Browser/server REST and socket contracts have no generated shared schema.
- The mobile chat top bar is compact, but its associated control toolbar scrolls horizontally with a hidden scrollbar. The fixed bottom navigation itself uses four equal grid columns and does not slide.
