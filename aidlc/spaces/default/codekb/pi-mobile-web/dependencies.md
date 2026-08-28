# Dependencies

## External Runtime Dependencies

| Dependency | Main consumers | Contract | Failure/security boundary |
|---|---|---|---|
| Pi SDK | `pi-service.ts`, `harnesses.ts`, `server.ts` | In-process sessions, models, prompts, tools, events | Node-local auth/models; broad agent capability |
| Claude CLI | `claude-service.ts`, `harnesses.ts`, `server.ts` | Child process and stream-JSON events | Process exit, malformed stream, credentials, bypassed permission prompts |
| Syncthing | `syncthing.ts` | Loopback REST for config, ignores, folders, status, scans | Readiness and eventual consistency; ignore rules can permit deletion |
| Git | `worktrees.ts`, scripts | Worktrees, bundles, merge, release/deploy commits | Subprocess and repository integrity |
| Peer Joint Bob nodes | `server.ts`, cluster/replication modules | Bearer REST and proxied WebSocket | Network partition, unsafe URL, token exposure |
| Web Push | `push.ts` | VAPID Push API | External delivery and expired subscriptions |
| Filesystem | Most modules | Projects, transcripts, skills, workspaces, settings | Path identity, permissions, symlinks, concurrent sync |
| SQLite | Persistence modules | Shared `~/.joint-bob/node.db` | Shared schema, lock contention, migration order |
| Tailscale Serve | Operations | Private HTTPS reverse proxy | Recommended deployment boundary, not enforced by app |
| AWS | `deploy/aws-ec2-test` | Temporary EC2 smoke environment | Test-only cloud cost and exposure |

## npm Dependency Roles

Production dependencies are `express`, `ws`, `zod`, `@earendil-works/pi-coding-agent`, `@anthropic-ai/claude-code`, `nanoid`, and `web-push`. Development dependencies are TypeScript, `tsx`, and `@types/*`. The package relies heavily on Node built-ins, especially `node:sqlite`, crypto, HTTP, filesystem, and child processes.

The two committed lockfiles represent the same resolved graph but impose a synchronization obligation. The explicit public-registry production audit found zero vulnerabilities during this scan.

## Internal Dependency Topology

| Upstream | Downstream dependencies | Coupling note |
|---|---|---|
| `src/server.ts` | Nearly every backend module | Highest fan-out; owns complete transactions |
| Browser PWA | REST, `/ws`, `board.js`, `markdown.js` | Handwritten, unversioned contract |
| Tasks/workspaces | Cluster, replication, Syncthing, worktrees, agents | Crosses persistence, network, filesystem, process boundaries |
| Agent adapters | Settings, session paths, filesystem, GitHub environment | Engine-specific execution beneath normalized events |
| Cluster/replication | Settings/crypto, SQLite, peer HTTP | Eventual convergence and retry state |
| Conversation discovery/review | Project paths, transcripts, watchers, SQLite | Path aliases and timestamps define correctness |
| Syncthing adapter | Settings, task workspace paths, external daemon | Managed ignore ownership mixed with preserved user rules |

Most source imports are acyclic, but module boundaries do not imply isolated data ownership because many components open the same SQLite file.

## Critical Dependency Chains

### Streamed Conversation

`public/app.js` → `/ws` in `src/server.ts` → local or peer/task-owner routing → `pi-service.ts` or `claude-service.ts` → normalized `textDelta` events → browser batching and `renderBubbleContent()`.

Correctness depends on event timing across SDK/CLI, server broadcast, WebSocket delivery, animation-frame/timer batching, and visible DOM paint.

### Conversation Review

Session discovery → `syncConversationReviewStates()` → `conversation_review_states` → single/bulk review route → `markConversationsReviewed()` → next session listing. Current activity timestamps must be reconciled before advancing `reviewed_at`; otherwise stale persistence can reclassify a just-reviewed conversation.

### Task Handoff

Browser/board → owner-routed REST → `tasks.ts` → `task-workspaces.ts` or `worktrees.ts` → `syncthing.ts` and destination peer → prepare/commit/settle/acknowledge. Readiness, ownership, and idempotent recovery are all required.

### Project Synchronization

Project API → `managed-home.ts` / `project-directory-import.ts` → `store.ts` → `syncthing.ts` → peer Syncthing device. Managed ignore reconciliation must remove obsolete generated-cache rules without reclassifying user rules or sensitive ignores as delete-allowed.

## Persistence Coupling

Authentication, audit, cluster, conversation reviews, GitHub auth, names, preferences, push, replication, settings, projects, and tasks use one `node.db`, often through separately cached `DatabaseSync` handles. WAL and busy timeouts reduce contention, but schema creation and guarded `ALTER TABLE` statements remain distributed with no central version ledger.

## Dependency Risks and Mitigations

- Keep Syncthing REST loopback-only and never broaden `(?d)` beyond proven generated caches.
- Keep peer traffic on private HTTPS; current general URL acceptance leaves administrator-configured SSRF and credential-exposure risk.
- Add realpath/lstat enforcement to project file reads before trusting lexical path containment.
- Preserve cookie, CSRF, origin, and timing-safe machine-token checks for every new transport path.
- Add contract tests or a published schema before splitting the handwritten browser/server protocol.
