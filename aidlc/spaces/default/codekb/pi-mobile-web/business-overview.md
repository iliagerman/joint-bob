# Business Overview

## Purpose and Domain

Joint Bob is a private, multi-node workspace for running Pi and Claude coding agents against local software projects. It gives one authenticated administrator a browser interface for projects, conversations, Kanban tasks, agent execution, review tracking, node handoff, synchronized workspaces, terminals, and completion notifications.

Each macOS or Linux node runs one Joint Bob service. Application-owned state stays in node-local SQLite under `~/.joint-bob`; repositories, transcripts, worktrees, ticket workspaces, and Syncthing content remain filesystem-owned. Production runs from `~/.local/share/joint-bob/app`, not a source checkout.

## Users and Operating Model

The primary actor is an administrator using desktop or mobile browsers. The administrator installs nodes, maps local projects, pairs up to five active nodes, chooses execution locations, and supervises coding-agent work. Peer Joint Bob nodes act as authenticated machine clients for membership, replication, project mapping, credential delivery, task handoff, and proxied WebSockets.

The intended network boundary is a trusted private network, normally Tailscale Serve over HTTPS. Pairing tokens are machine credentials and must not cross public HTTP.

## Business Capabilities

- Create, import, classify, rename, colour, map, synchronize, rescan, and remove projects.
- Discover Pi and Claude conversations across canonical, mapped, legacy, synchronized, and ticket-workspace paths.
- Start, resume, steer, abort, rename, transfer, and review conversations while receiving streamed text, thinking, tool, and status events.
- Mark one or all conversations reviewed; preserve per-user review state in SQLite.
- Select an execution node for ordinary chat; route task chat to `TaskRecord.currentNodeId`.
- Manage tasks through board states, phase-specific agent settings, synchronized ticket workspaces, and legacy Git worktrees.
- Hand task ownership to another node using readiness checks and a prepare/commit/settle protocol.
- Pair nodes, converge membership and replicated records, and synchronize approved filesystem content through Syncthing.
- Manage encrypted GitHub credentials, runtime settings, push subscriptions, skills, files, and project-scoped terminal sessions.
- Install, diagnose, update, roll back, smoke-test, package, and release the service.

## Business Rules and Constraints

- Cluster membership is capped at five active nodes.
- Task ownership overrides the non-task node selected in the browser.
- GitHub credentials use encrypted application replication, never Syncthing.
- New ticket workspaces are synchronized folders without branches; legacy Git-backed tasks retain worktree, bundle, and merge behavior.
- `.git`, dependencies, credentials, environment files, logs, and generated output are excluded from project synchronization.
- Syncthing delete-allowed ignore semantics may apply only to proven generated caches. They must never be broadened to credentials, environment files, source, or arbitrary user rules.
- Agent execution is powerful: Claude uses `--permission-mode bypassPermissions`, and Pi safeguards can be changed. Authentication, project path boundaries, and private networking are therefore primary controls.

## Current Bug Context and Traceability

| Concern | Business impact | Evidence | Required verification |
|---|---|---|---|
| Delayed streamed replies | Users cannot steer a conversation before the turn ends | Pi and Claude emit delta events; `public/app.js` batches long-message rendering | A browser-visible delta must appear before final completion, then accept a follow-up prompt during the turn |
| Mark-all-reviewed reverts | The review inbox cannot be cleared reliably | `conversation-reviews.ts` marks against stored `last_activity_at`; current activity can race the bulk operation | Bulk and single review regressions must distinguish pre-click from genuine post-click activity |
| Syncthing `beecomm` errors | Remote deletes remain blocked and folder readiness fails | Live errors cite ignored `__pycache__`; the managed rule lacks Syncthing `(?d)` semantics | Migrate only the generated-cache rule and preserve all non-cache/user ignore semantics |

## Assumptions and Unknowns

- **Assumption:** The reported streamed-delay symptom affects one or both agent engines. The scan found the intended event chain but no runtime timing evidence proving the failing boundary.
- **Assumption:** `beecomm` is the intended folder; the reported spelling `beccomm` was not found.
- **Unknown:** No formal compliance regime, data-retention policy, or service-level objective is documented. Security observations here are engineering controls, not a compliance certification.
