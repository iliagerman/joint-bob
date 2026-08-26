# Business overview

## Purpose and domain

Joint Bob is a private, multi-node workspace for running Pi and Claude coding agents against local software projects. It gives an administrator one browser interface for project discovery, agent conversations, task planning, task ownership, node handoff, filesystem synchronization, and completion notifications.

The product assumes trusted machines connected over a private network. Each node runs its own Joint Bob service and keeps account and application state in `~/.joint-bob`. Repositories, transcripts, worktrees, ticket workspaces, and synchronized agent data remain files on disk.

## Users and operating model

The primary actor is a single administrator who installs Joint Bob on macOS or Linux nodes, pairs up to five active nodes, maps projects to node-local paths, and starts agent work from desktop or mobile browsers. Peer Joint Bob nodes are also actors. They exchange membership, replicated records, credentials, project inventories, task handoff messages, and proxied WebSocket traffic.

Production services run from `~/.local/share/joint-bob/app`, not from a source checkout. Linux uses `joint-bob.service`; macOS uses `com.joint-bob.node`.

## Current business capabilities

- Create, import, classify, rename, colour, synchronize, rescan, map, and delete projects.
- Discover Pi and Claude conversations across local, legacy, mapped, synchronized, and ticket-workspace paths.
- Start or resume agent conversations, stream text, thinking, and tool activity, attach files, rename sessions, mark reviews, abort runs, and request completion notifications.
- Choose the execution node for non-task chat. The browser includes `nodeId` in the WebSocket URL, and the local service proxies the socket to that node when needed.
- Route task chat by `TaskRecord.currentNodeId`. Task ownership overrides the browser's non-task node selection.
- Manage Kanban tasks through backlog, planning, in-progress, review, and done states. Tasks can use synchronized ticket workspaces or legacy Git worktrees.
- Hand tasks to another node after eligibility and synchronization checks. Legacy Git-backed work can transfer a branch bundle and merge to `main`.
- Pair nodes, replicate cluster state and GitHub credential assignments, and configure Syncthing folders and devices.
- Browse local or peer directories, download project files, discover Pi and Claude skills, and manage runtime settings.

## Model, thinking, and effort controls

Current conversation controls are split by agent engine:

- Pi models come from the embedded Pi model runtime. The browser presents configured `openai-codex` and `zai` models. WebSocket commands support `setModel`, `setThinking`, and `cycleThinking`, and session status reports the active thinking level and available levels. The current browser model dialog does not expose a Pi thinking-level selector.
- Claude presents Fable, Opus 5, Sonnet, and Haiku 4.5 choices. The same dialog exposes reasoning effort values `default`, `low`, `medium`, `high`, `xhigh`, and `max`. The browser sends `setEffort`; the server passes non-default effort to the Claude CLI as `--effort`.
- Task phase configuration stores `engine`, `provider`, `modelId`, and `effort` for planning, in-progress, and review phases. Current task model options encode `default` effort only; the task editor has no separate effort selector.

These controls are session or task configuration. No repository-wide model policy is exposed in the browser.

## Mobile navigation and top bar

The PWA is mobile-first. Below 1024 pixels, it displays one full-screen panel at a time and switches among Projects, Chats, Board, and Chat with a fixed four-button bottom navigation. `setMobileView` changes body classes, persists the view preference, and writes browser history so Back can return to the prior panel.

Each panel has a compact top bar. The chat top bar contains Back, a truncated conversation title, a truncated status line, an optional ticket backlink, connection status, and Stop. Execution node, agent, model, safeguards, transfer, notification, rename, and install controls sit in a second `.chat-toolbar` row. That row currently uses `overflow-x: auto` with its scrollbar hidden, so narrow screens require horizontal sliding to reach controls that do not fit.

## Business constraints and boundaries

- Cluster membership is capped at five active nodes.
- Pairing tokens are machine credentials. Documentation prohibits pairing over public HTTP and recommends Tailscale private HTTPS.
- GitHub credentials replicate through encrypted application records, not Syncthing.
- `.git`, `node_modules`, credentials, environment files, build output, and logs are excluded from synchronized project content.
- New ticket workspaces have no branch and no merge action. Existing Git-backed tasks retain worktree and merge behavior.
- No terminal-opening business capability exists in the scanned code. There is no terminal route, PTY, frontend action, or terminal dependency.
