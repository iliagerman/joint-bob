# Business Overview

## Business Description
Pi Mobile Web provides mobile access to local Pi and Claude coding-agent projects, conversations, files, and task boards.

## Business Transactions
- Register or remove a project workspace.
- Create and resume coding-agent sessions.
- Exchange streamed chat messages and attachments.
- Manage project tasks through a kanban board.
- Synchronize project folders and session changes between homeserver and Mac.

## Business Dictionary
- **Project**: Registered local workspace folder.
- **Session**: Persisted Pi or Claude conversation.
- **Task**: Project-scoped work item that can launch an agent run.
- **Synced project**: Workspace configured for Syncthing sharing with a Mac.

## Component Descriptions
- **Browser client**: Mobile-first project, session, board, and chat interface.
- **Express server**: REST, WebSocket, static-file, and agent orchestration layer.
- **Persistent stores**: JSON files for projects, tasks, and push subscriptions.
- **Agent services**: Pi SDK and Claude CLI adapters.
