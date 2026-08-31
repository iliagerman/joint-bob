# Business Overview — Joint Bob

**Repository:** `joint-bob` (`/Users/iliagerman/Work/personal_projects/joint-bob`)
**Package:** `joint-bob` version `0.2.0`, MIT, published to npm with `--provenance --access public`
**Self-description:** "Private multi-node workspace for Pi and Claude coding agents"

## What the product is

Joint Bob is a **self-hosted web application that lets one person drive AI coding agents from
anywhere**, including a phone. It runs as a small HTTP + WebSocket server on the machines the
owner already controls — a laptop, a home server, a cloud box — and serves a browser client
(installable as a PWA, a web app that can be added to a phone's home screen and works offline
for its shell).

Two coding agents are embedded as libraries rather than shelled out to as products:

- **Pi** (`@earendil-works/pi-coding-agent` 0.84.2)
- **Claude Code** (`@anthropic-ai/claude-code` 2.1.239)

Each machine that runs Joint Bob is called a **node**. Nodes are paired into a small private
**cluster**. A conversation, a ticket, or a project can live on one node and be reached, taken
over, or handed off from another.

## The problem it solves

Coding agents run where the code is. That normally pins the operator to one machine: the agent's
session, its git worktree, its credentials, and its transcript all live on that machine's disk.
Joint Bob's whole reason to exist is to break that pin without giving up the "code stays on my
own hardware" property:

1. **Access from anywhere** — the agent still runs on the machine that holds the repository, but
   the operator drives it through a browser over an authenticated link.
2. **More than one machine** — projects, tickets, conversation ownership, and credentials are
   reconciled across paired nodes so work started on the laptop can be continued on the server.
3. **No third-party custody** — there is no SaaS backend. Every byte of state lives in a local
   SQLite file (`~/.joint-bob/node.db`) on each node, and secrets are encrypted at rest with a
   key that never leaves the node (`~/.joint-bob/secret.key`).

## Who uses it and why

The product is built for a **single technical owner**, not for teams or tenants. Evidence in the
code: authentication is a single-user password login with sessions (`src/auth.ts`, tables `users`,
`login_sessions`, `login_attempts`); there is no tenant, organisation, or role concept anywhere in
the 49-table schema; `README.md` frames node pairing as something the owner does between their own
machines using a machine credential.

Typical uses, drawn from the feature surface actually present in the code:

| Who / when | What they do | Backed by |
|---|---|---|
| Owner, at a desk | Starts a Claude or Pi conversation in a project, streams the reply live | WebSocket chat mode, `src/server.ts` |
| Owner, on a phone | Reads back a conversation, sends a follow-up prompt, gets a push notification when a long run finishes | PWA client `public/`, `src/push.ts` (VAPID web push) |
| Owner, planning | Files work as cards on a Kanban board; a card gets its own isolated git workspace | `src/tasks.ts`, `src/task-workspaces.ts`, `src/worktrees.ts` |
| Owner, moving machines | Transfers or force-takes a running conversation from the laptop to the home server | `src/conversation-ownership.ts` |
| Owner, doing shell work | Opens a real terminal in the project folder from the browser | `src/terminal-session.ts` (node-pty), xterm.js client |
| Owner, reviewing | Marks conversations reviewed, reads a pending-review queue | `src/conversation-reviews.ts` |
| Owner, setting up | Pairs a second node, syncs project files, pushes GitHub credentials to it deliberately | `src/cluster.ts`, `src/syncthing.ts`, `src/github-auth.ts` |

## Key functionality

**Conversations.** Per-project chat with either agent, streamed over WebSocket, with model and
effort selection, tool toggles, safeguards, compaction, abort, and rename. Transcripts are the
agent's own on-disk session files, not a Joint Bob copy.

**Projects.** A project is a directory on disk plus an identity that survives across nodes. It has
a name, a colour, a **project type** (a user-defined category whose id doubles as a folder name
under the managed home), optional Syncthing folder, and per-node path mappings.

**Ticket board.** Kanban cards with eligibility rules, leases, handoffs between nodes, archival,
and merge. Each card can get an isolated worktree under `<home>/tickets/<project-id>/<ticket-id>`.

**Credentials.** Two systems today (see below), both encrypted at rest, both injected into agent
processes as environment variables at spawn time.

**File sync.** Syncthing (pinned to 2.1.3, checksum-verified per platform) is installed and
controlled by the app to replicate project files between nodes, with a `.stignore` that
deliberately excludes `.git`, `node_modules/`, `dist/`, and every credential-shaped file.

**Embedded terminal.** A real pseudo-terminal in the project folder, so interactive programs,
colours, job control, and resize behave like a local shell.

**File editor.** Browse and edit project files from the browser, backed by CodeMirror 5.

## The credential domain — the part this workspace is currently changing

Credentials are the business-critical part of the product: an agent that cannot authenticate to
GitHub, AWS, or Google cannot do the work it was asked to do. Joint Bob currently ships **two
separate credential systems that overlap but share no model**:

**GitHub credential groups** (`src/github-auth.ts`, 9 tables). A *group* is a named GitHub identity
— `{ id, label, isDefault }` — holding one token. Exactly one group is the default. A project
resolves its token through a **four-tier, first-hit-wins chain**: the project's own token override,
the project's assigned group, the project type's group, then the default group; a dangling group
reference falls through instead of blocking. Group tokens **replicate to other nodes**, but only
when the owner explicitly asks (Settings → GitHub → Sync). This is the only credential path that
makes `git push` work, because the token reaches git through a generated `GIT_ASKPASS` helper
script and the `PI_GITHUB_TOKEN` variable.

**Generic secret accounts** (`src/secrets.ts`, 2 tables). A named bundle of environment variables
for one of four providers (`aws`, `google`, `github`, `custom`), each variable being either a plain
value or a file whose content is written to disk and whose *path* is exported. Accounts are assigned
to scopes — today only `project` and `project_type` — and resolution is a **two-tier merge** where a
project-scoped account overrides a project-type-scoped one per variable name. These are
**deliberately node-local**: they never replicate, and only their metadata is ever sent to the
browser.

**Where the two collide.** `agentEnvironment(projectId)` (`src/secrets.ts:235`) spreads the GitHub
group environment first and the generic secrets last, so a generic `github`-provider account
overrides `GH_TOKEN` and `GITHUB_TOKEN` — but *not* `PI_GITHUB_TOKEN`, `GIT_ASKPASS`, or
`GIT_TERMINAL_PROMPT`. In business terms: the agent's `gh` CLI and the agent's `git push` can end
up authenticating as **two different GitHub identities**. The UI documents this in prose rather
than fixing it.

**What is missing from the domain.** There is no *workspace* tier — every occurrence of "workspace"
in `src/` refers to *ticket* workspaces, not a credential scope. There is no *conversation* tier
either, and conversation identity has three different derivations depending on the engine. Secrets
are resolved and injected exactly once, at process spawn, before a brand-new conversation
necessarily has an id at all.

## Business rules worth preserving

These are decisions encoded in the code and its comments; a redesign must keep them or replace
them deliberately.

- **Credentials never leave a node by accident.** `github-auth.ts:465` — "Nothing is ever enrolled
  automatically: credentials stay on this node until the user asks for a sync." Generic secrets go
  further and never replicate at all.
- **Secret values never reach the browser.** `GET /api/secrets` returns metadata only; the client
  renders variable names and kinds, never values (`public/app.js:5677`).
- **Renaming is safe.** A group's `id` is stable so renaming its `label` never breaks project
  assignments (`github-auth.ts:9`). The same holds for project types.
- **A deleted default never leaves the system unauthenticated silently.** Deleting a group rewrites
  every project that referenced it to "no group" and re-elects a default.
- **A deleted project type stays deleted.** Seed data is inserted only into an empty table.
- **Project types are filesystem-coupled.** A project type's id is a real directory name under the
  managed home, so changing a project's type **physically relocates the directory** and reconfigures
  its Syncthing folder.
- **Pairing tokens are machine credentials.** `README.md` warns against pairing nodes over plain
  public HTTP.

## Success and failure, in operator terms

The product succeeds when the owner can open a browser on any device, pick a project, and have an
agent do authenticated work — `git push`, `aws s3`, `gh pr create` — without ever being asked for a
key, and without a key ever being visible to the agent or to the browser. It fails when the
resolution chain silently produces the wrong identity, when a credential fails to reach the node the
work moved to, or when an assignment is orphaned by a rename, a merge, or a delete. All three of
those failure modes are present in the code today and are documented in
[code-quality-assessment.md](code-quality-assessment.md).
