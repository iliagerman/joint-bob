# Project auto-mapping and session node routing

## Requirements

1. Adding a project must use the existing server-side folder picker so the selected path belongs to the node running Master Bob.
2. A node must discover projects from reachable peers after administrator login. Unmapped projects must prompt for a local folder.
3. Mapping a synchronized project must configure Syncthing on both nodes without manual Syncthing work.
4. Each node may store a local project root. When source and destination roots are configured, imported projects map to the same relative path below the destination root.
5. Starting a task handoff to an online node with an unmapped project must open destination-folder mapping, configure Syncthing, then retry the handoff.
6. Pi/Claude and session selectors must remain visible in the chat header rather than hidden behind the overflow menu.
7. Chat must show a node selector. Selecting an online mapped node must route the session WebSocket to that node using machine authentication.
8. A remote session run must continue on its execution node if the browser or forwarding node disconnects.
9. Existing project, task, settings, and transcript data must remain intact.
10. “Physical E2E renamed” is identified as a live E2E artifact; it is not deleted without owner approval because it contains a task.
11. A newly connected empty conversation must remain usable until its first message creates the persisted session.
12. Chat controls must use user-facing labels: Runs on, Agent, Conversation, and Model. “New session” must be described as starting a new conversation.
13. An existing idle Pi conversation must expose a visible Continue on… action. It must work through a forwarding node and prompt for destination project mapping before transfer when required.
