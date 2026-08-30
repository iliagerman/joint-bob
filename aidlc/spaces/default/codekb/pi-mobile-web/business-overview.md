# Business Overview

## What Joint Bob Is

`joint-bob` is a private, self-hosted workspace for running AI coding-agent conversations from a phone. A user installs it on every machine they own — a laptop, a desktop, a Raspberry Pi, an EC2 box — pairs those machines into a cluster over Tailscale, and then drives coding work on any of them from a single mobile-first Progressive Web App.

The product is not a hosted SaaS. It is a single npm package (`joint-bob`, MIT licensed, published with `npm publish --provenance`) that a user installs onto their own hardware via `bin/joint-bob.mjs install`. There is no central server, no tenant model, and no external identity provider: each node holds its own SQLite database at `~/.joint-bob/node.db`, its own password-protected session cookie, and its own machine token used to authenticate peer-to-peer calls to the other nodes in the mesh.

Two coding agents are supported as first-class "engines":

- **Pi** — the `@earendil-works/pi-coding-agent` SDK, driven in-process through `SessionManager` / `AgentSession`.
- **Claude** — the `@anthropic-ai/claude-code` CLI, driven as a subprocess with `claude -p --output-format stream-json --verbose --include-partial-messages`.

Both are surfaced through one adapter registry (`src/harnesses.ts`), so the PWA presents a single chat experience regardless of which engine a conversation belongs to.

## Business Domain

The domain is **personal multi-machine coding-agent orchestration**. The recurring business problem it solves is that a coding agent's work is pinned to whichever machine happened to start it: the transcript, the working directory, the running process and the Git checkout all live there. The user, however, moves — between desk and phone, between home and office, between a laptop that sleeps and a Pi that does not.

Joint Bob's answer is a cluster of equal peers that share three things:

1. **Files**, replicated by Syncthing (including `~/.claude` wholesale as the `dot-claude` folder, `CLAUDE_ENGINE_SYNC_FOLDER_ID`, `src/syncthing.ts:41`).
2. **State**, replicated by an application-level event outbox/inbox (`src/replication.ts`).
3. **Single-writer authority over each conversation**, enforced by an explicit ownership state machine (`src/conversation-ownership.ts`).

The third is the load-bearing invention. Because the transcript file is on every node at once, two nodes appending to it simultaneously would corrupt the conversation. Ownership — an `(engine, sessionId)` row carrying an epoch and a status — is what makes "the same conversation, continued on another machine" a safe operation rather than a race.

## Key Functionality

| Capability | What the user does | Where it lives |
|---|---|---|
| Chat with a coding agent | Opens a project, picks an engine, sends prompts, watches streaming output and tool calls | WebSocket `/ws`, `src/server.ts`, `public/app.js` |
| Project management | Registers local directories as projects, assigns project types, imports directories discovered on peers | `src/store.ts`, `src/project-directory-import.ts` |
| Conversation transfer | Hands an in-flight conversation to another node and picks it up there | `POST /api/cluster/sessions/transfer`, `.../receive` |
| Conversation takeover | Forcibly seizes ownership when the owning node is unreachable | `POST /api/cluster/sessions/take-ownership` |
| Review inbox | Sees which conversations have new agent output the user has not read | `src/conversation-reviews.ts`, `GET /api/reviews/pending` |
| Kanban tasks | Files coding tasks on a board and leases them to specific nodes | `src/tasks.ts`, `public/board.js` |
| Terminal | Opens a shell on any node from the phone | `src/terminal-session.ts` |
| Node pairing | Invites a machine into the cluster and exchanges machine tokens | `src/cluster.ts`, `POST /api/cluster/invite` |
| Secrets and GitHub credentials | Stores encrypted secrets and GitHub credential groups, replicated across the mesh | `src/secrets.ts`, `src/github-auth.ts` |
| Push notifications | Gets a web push when a conversation needs review | `src/push.ts` |
| Update resilience | Survives a service restart mid-run and resumes the conversation | `src/update-recovery.ts` |

## The Active Intent in Business Terms

Intent `260830-claude-session-transfer` — *"Enable Claude conversation ownership transfer between paired nodes"* — closes the gap that Pi conversations can be moved between machines and Claude conversations cannot. Today the user sees a greyed-out **Continue on another node** menu entry on any Claude conversation, with the tooltip `"Claude transfer is not available yet"`.

The business value is symmetry: the whole premise of the product is that a conversation is not pinned to a machine, and half the supported engines currently violate that premise. The scan found that the ownership layer, the replication layer and the server-side transfer path are all already engine-agnostic — the remaining blockers are three client-side gates in `public/app.js`, one server-side guard in `takeLocalSessionOwnership`, and one genuine correctness gap in how a Claude transcript path is re-rooted on the receiving node (`resolveLocalSessionPath`, `src/session-paths.ts:17`).

## Users and Operating Assumptions

There is a single human operator per cluster. Authentication is a first-run password setup (`POST /api/auth/setup`) followed by cookie sessions with CSRF protection; there are no roles, no organisations and no sharing model. Nodes trust one another via long-lived machine tokens compared with `timingSafeEqual`.

The system assumes three external dependencies are already present and healthy on every node: **Tailscale** (the private network the nodes reach each other over), **Syncthing** (file replication, driven through its REST API with an `X-API-Key`), and at least one of the two agent runtimes. It also assumes Node.js `>=22.19.0`; CI and the installer both pin `22.23.2` via `scripts/versions.sh`.
