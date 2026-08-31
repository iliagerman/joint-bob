# API Documentation — Joint Bob

Three API surfaces exist: an **HTTP REST API** (109 endpoint registrations, all in
`src/server.ts`), a **WebSocket API** with two modes, and one **internal module contract** — the
credential injection surface — that behaves like an API because four call sites depend on its exact
shape.

## HTTP — transport, middleware, and the auth barrier

Middleware chain in registration order (`src/server.ts`):

| Line | Registration |
|---|---|
| 783 | `app.use(securityHeaders)` |
| 790 | `app.use("/vendor/codemirror", express.static(codemirrorDir, { index: false }))` |
| 791 | `app.use(express.static(publicDir))` |
| 792 | `app.use(express.json({ limit: "12mb" }))` |
| **848** | **`app.use("/api", requireHttpAuth, requireCsrf)`** |
| 849 | `app.use("/api", ...)` — additional per-request setup |
| 3324 | error handler |

**Everything registered after line 848 requires authentication and a CSRF token.** Four routes are
registered before it and are therefore public by design:

```
794 GET  /api/auth/status
798 GET  /api/health
809 POST /api/auth/setup
829 POST /api/auth/login
```

**Content Security Policy** (`server.ts:487`):
`default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'`

**Peer authentication.** The 41 `/api/cluster/*` endpoints are node-to-node. Callers present
`Authorization: Bearer <peer token>`; the token is stored encrypted in `cluster_peers.token` and
decrypted on use.

## HTTP — credential and scoping endpoints

These are the endpoints the current secrets work touches directly.

### Generic secret accounts

| Line | Method | Path | Contract |
|---|---|---|---|
| 1899 | GET | `/api/secrets` | `{ accounts: SecretAccount[] }` — **metadata only; values never leave the node** |
| 1902 | POST | `/api/secrets/accounts` | 201; body `secretAccountSchema.omit({ id: true })`; returns `{ accounts, account }` |
| 1905 | PUT | `/api/secrets/accounts/:accountId` | `accountId` must satisfy `z.string().uuid()` |
| 1908 | DELETE | `/api/secrets/accounts/:accountId` | |
| 1911 | GET | `/api/secrets/scopes/:scopeType/:scopeId` | `{ accountIds: string[] }` |
| 1914 | PUT | `/api/secrets/scopes/:scopeType/:scopeId` | body `{ accountIds }`, max 100; **replaces the whole set** |

Response and request shapes (`src/secrets.ts:8-15`):

```ts
export type SecretProvider = "aws" | "google" | "github" | "custom";
export type SecretKind = "value" | "file";
export type SecretScopeType = "project" | "project_type";

export interface SecretVariable { name: string; kind: SecretKind; configured: true }
export interface SecretAccount  { id: string; label: string; provider: SecretProvider; variables: SecretVariable[] }
export interface SecretAccountInput {
  id?: string; label: string; provider: SecretProvider;
  variables: Array<{ name: string; kind: SecretKind; value?: string }>;
}
```

Validation, enforced in `secrets.ts` independently of the zod layer:

- `assertAccountId` (line 65) — must match `UUID_PATTERN` (line 20), an RFC-4122 v1–v5 shape
- `assertScope` (line 69) — `scopeType` must be `"project"` or `"project_type"`; `scopeId` trimmed
  length 1–300
- `assertInput` (line 74) — provider in the four-value list; label 1–64 chars with no control
  characters; 1–20 variables; each name matches `/^[A-Za-z_][A-Za-z0-9_]*$/`; names unique within
  the account; kind in `value|file`; value at most 100,000 characters
- `assertNoCollision` (line 139) — at **assignment** time, rejects the whole write if two accounts
  in the same scope declare the same variable name: `"Selected secret accounts have duplicate environment variable names"`

Omitted-value semantics: a variable submitted with `value === undefined` or `""` **reuses the
stored value**, keyed by `` `${name}:${kind}` `` (`secrets.ts:165-170`). A genuinely new variable
with no value throws `"New secret variables require a value"`.

Scope canonicalisation (`canonicalScopeId`, `secrets.ts:119`): a `project_type` scope id must exist
in `project_types` or the call fails with `"Secret project type not found"`; a `project` scope id is
resolved through `project_aliases` and must exist in `projects` or the call fails with
`"Secret project not found"`.

### GitHub credential groups

| Line | Method | Path | Contract |
|---|---|---|---|
| 1729 | GET | `/api/github-auth` | `{ groups: GitHubGroup[] }` |
| 1737 | POST | `/api/github-auth/groups` | 201; body `githubGroupSaveSchema`; returns full status |
| 1747 | PUT | `/api/github-auth/groups/:groupId` | `groupId` via `githubGroupIdSchema` |
| 1758 | DELETE | `/api/github-auth/groups/:groupId` | |
| 1768 | POST | `/api/github-auth/sync` | body `{ peerIds: uuid[] }` (1–50); enrols then pushes to each peer synchronously; returns `{ results: [{ peerId, name, delivered, error? }] }` |
| 2043 | GET | `/api/projects/:projectId/github-auth` | `{ groups, project: { group, hasOverride, configured } }` |
| 2056 | PUT | `/api/projects/:projectId/github-auth` | body `projectGitHubAuthSchema` |

`getGitHubAuthStatus(projectId?)` (`github-auth.ts:305`) computes `hasOverride` as
`Boolean(project.token)` and `configured` as `Boolean(projectToken(...))` — that is, `configured`
answers "will anything actually authenticate", evaluated through the whole four-tier chain.

Semantics worth stating explicitly, because a client depends on them:

- Omitting `token` on a group update **keeps** the stored token.
- The first group ever created becomes the default automatically.
- Setting `isDefault` clears the flag on every other group.
- Deleting a group rewrites every `github_project_auth` row that referenced it to `account = ''`
  with a fresh version and its own replication event, then re-elects a default.
- On `PUT /api/projects/:projectId/github-auth`: `token === undefined` keeps the existing override;
  `token === null` or `""` clears it.

### Project types (the scope tier that carries a GitHub group)

| Line | Method | Path | Contract |
|---|---|---|---|
| 1918 | GET | `/api/project-types` | `{ types: ProjectTypeRecord[] }` |
| 1926 | PUT | `/api/project-types` | upsert `{ id?, label, githubGroup? }`; then `ensureManagedHome(...)` creates the type's folder |
| 1937 | DELETE | `/api/project-types/:typeId` | 204 |
| 2072 | PATCH | `/api/projects/:projectId` | includes the project-type change that **physically relocates the directory on disk** |

`DELETE /api/project-types/:typeId` refuses if any project uses the type
(`"Move or delete this type's projects before deleting it"`) and refuses to leave zero types
(`"Keep at least one project type"`). **It does not touch `secret_assignments`** — deleting a
project type strands any secret assignments scoped to it.

### Peer inboxes for credential and generic events

| Line | Method | Path | Contract |
|---|---|---|---|
| 1111 | POST | `/api/cluster/events` | peer inbox for generic replication events |
| 1124 | POST | `/api/cluster/github/events` | peer inbox for GitHub credential events, **max 100 per batch** |

### Zod schema block

All request schemas live in one block at `src/server.ts:265-322`:
`githubGroupIdSchema`, `githubGroupLabelSchema`, `githubCredentialEventSchema`,
`githubCredentialBatchSchema`, `githubCredentialSyncSchema`, `githubGroupSaveSchema`,
`projectGitHubAuthSchema`, `secretAccountSchema`, `secretScopeParamsSchema`, `secretScopeSchema`.

## HTTP — complete endpoint inventory by line number

```
 787 GET    /favicon.ico
 794 GET    /api/auth/status                      (unauthenticated)
 798 GET    /api/health                           (unauthenticated)
 809 POST   /api/auth/setup                       (unauthenticated)
 829 POST   /api/auth/login                       (unauthenticated)
 857 POST   /api/auth/change-password
 876 POST   /api/auth/logout
 883 GET    /api/auth/sessions
 888 DELETE /api/auth/sessions/:sessionId
 898 GET    /api/preferences
 903 PUT    /api/preferences
 912 GET    /api/audit
 925 GET    /api/settings
 929 PUT    /api/settings
 958 GET    /api/cluster/invite
 966 GET    /api/cluster/node
 974 PUT    /api/cluster/node
 983 GET    /api/cluster/local-inventory
1010 GET    /api/cluster/inventory
1034 GET    /api/cluster/peers
1042 POST   /api/cluster/peers
1087 POST   /api/cluster/peers/accept
1101 POST   /api/cluster/membership/sync
1111 POST   /api/cluster/events
1124 POST   /api/cluster/github/events
1132 POST   /api/cluster/tasks/eligibility
1141 POST   /api/cluster/tasks/status
1151 POST   /api/cluster/tasks/prepare
1190 POST   /api/cluster/tasks/commit
1206 POST   /api/cluster/tasks/settle
1216 POST   /api/cluster/tasks/abort
1457 PATCH  /api/cluster/tasks/update
1478 DELETE /api/cluster/tasks/delete
1496 POST   /api/cluster/tasks/archive
1513 POST   /api/cluster/tasks/merge
1531 POST   /api/cluster/tasks/handoff
1550 POST   /api/cluster/projects/import
1564 POST   /api/cluster/projects/map
1578 POST   /api/cluster/projects/discover
1597 POST   /api/cluster/peers/:peerId/projects/:projectId/map
1616 POST   /api/cluster/sync/share
1655 GET    (loop-registered filesystem browse routes)
1661 GET    /api/cluster/peers/:peerId/filesystem/directories
1675 DELETE /api/cluster/peers/:peerId
1688 GET    /api/push/vapid-public-key
1696 POST   /api/push/subscribe
1707 POST   /api/push/unsubscribe
1717 GET    /api/harnesses
1721 GET    /api/models
1729 GET    /api/github-auth
1737 POST   /api/github-auth/groups
1747 PUT    /api/github-auth/groups/:groupId
1758 DELETE /api/github-auth/groups/:groupId
1768 POST   /api/github-auth/sync
1899 GET    /api/secrets
1902 POST   /api/secrets/accounts
1905 PUT    /api/secrets/accounts/:accountId
1908 DELETE /api/secrets/accounts/:accountId
1911 GET    /api/secrets/scopes/:scopeType/:scopeId
1914 PUT    /api/secrets/scopes/:scopeType/:scopeId
1918 GET    /api/project-types
1926 PUT    /api/project-types
1937 DELETE /api/project-types/:typeId
1946 GET    /api/projects
1955 GET    /api/projects/:projectId
1968 POST   /api/projects/:projectId/sync/rescan
1986 POST   /api/projects
2025 PUT    /api/projects/:projectId/path-mapping
2043 GET    /api/projects/:projectId/github-auth
2056 PUT    /api/projects/:projectId/github-auth
2072 PATCH  /api/projects/:projectId
2101 PUT    /api/projects/:projectId/lock
2117 PUT    /api/projects/:projectId/sessions/title
2136 PUT    /api/projects/:projectId/sessions/color
2153 DELETE /api/projects/:projectId
2175 GET    /api/projects/:projectId/session-nodes
2195 GET    /api/projects/:projectId/skills
2208 GET    /api/projects/:projectId/commands
2263 GET    /api/projects/:projectId/sessions
2437 GET    /api/cluster/sessions/ownership
2446 POST   /api/cluster/sessions/ownership/claim
2454 POST   /api/cluster/sessions/ownership/claim/cas
2462 POST   /api/cluster/sessions/ownership/claim/commit
2471 POST   /api/cluster/sessions/ownership/apply
2570 PUT    /api/projects/:projectId/sessions/reviewed
2594 PUT    /api/projects/:projectId/sessions/reviewed-all
2625 GET    /api/reviews/pending
2652 POST   /api/projects/:projectId/sessions/transfer
2680 POST   /api/cluster/sessions/transfer
2694 POST   /api/cluster/sessions/take-ownership
2707 POST   /api/projects/:projectId/sessions/take-ownership
2724 POST   /api/cluster/sessions/receive
2756 POST   /api/projects/:projectId/sessions/recover
2779 DELETE /api/projects/:projectId/sessions
2826 GET    /api/projects/:projectId/tasks
2839 GET    /api/projects/:projectId/tasks/:taskId/eligibility
2872 POST   /api/projects/:projectId/tasks
2899 PATCH  /api/projects/:projectId/tasks/:taskId
2925 POST   /api/projects/:projectId/tasks/:taskId/handoff
2950 POST   /api/projects/:projectId/tasks/:taskId/archive
2972 POST   /api/projects/:projectId/tasks/:taskId/merge
2994 DELETE /api/projects/:projectId/tasks/:taskId
3202 GET    /api/cluster/project-file-resolution
3214 GET    /api/cluster/project-file
3223 GET    /api/projects/:projectId/file-resolution
3243 GET    /api/projects/:projectId/file
3281 GET    /api/cluster/project-file-content
3288 PUT    /api/cluster/project-file-content
3312 GET    /api/changelog
3316 POST   /api/update/prepare
```

## WebSocket API

Constructed at `src/server.ts:160` as `new WebSocketServer({ server, path: "/ws" })`. Two modes are
selected by query string; `?mode=terminal` (line 4610) hands the socket to `attachTerminalSession`.

### Chat mode — client to server (15 message types)

```
prompt   abort   compact   rename   models   tools   setModel   cycleModel
setEngine   setEffort   setThinking   cycleThinking   setTools   setSafeguards   ping
```

### Chat mode — server to client (23 message types)

```
messages   message   assistant   user   text   textDelta   image   status   ready
models   tools   engineChanged   queueUpdate   ownership   sessionFile
sessionFileChanged   sessionsChanged   tasksChanged   watchReady   updatePreparing
error   pong
```

### Terminal mode

Validated by `terminalMessageSchema` at `src/terminal-session.ts:5`.

| Direction | Type | Payload |
|---|---|---|
| client → server | `terminalInput` | `data`, max 16,000 characters |
| client → server | `terminalResize` | `cols` 2–500, `rows` 2–500 |
| server → client | `terminalReady` | `{ cwd, nodeId }` |
| server → client | `terminalOutput` | output chunk |
| server → client | `terminalExit` | `{ code, signal }` |
| server → client | `terminalError` | error text |

**The terminal receives no project credentials.** `terminal-session.ts:26` spawns the PTY with
`env: { ...process.env, TERM: "xterm-256color" }`.

### Peer WebSocket proxying

`server.ts:4579` and `:4591` rewrite `https:` → `wss:` and `http:` → `ws:` to forward a chat socket
to the node that owns the conversation.

## Node-to-node credential wire contract

`GitHubCredentialEvent` (`src/github-auth.ts:18`) is a three-way union. The payload is **encrypted
at rest** in `github_credential_events.payload_encrypted` but travels as **plaintext JSON over the
authenticated peer HTTPS link**.

```ts
export type GitHubCredentialEvent =
  | { id; entityType: "account";  key; operation: "upsert";
      value: { label: string; token: string; isDefault?: boolean } | string;
      updatedAt; originNodeId; createdAt }
  | { id; entityType: "project";  key; operation: "upsert";
      value: { account: string; token: string | null };
      updatedAt; originNodeId; createdAt }
  | { id; entityType: "account" | "project"; key; operation: "delete";
      updatedAt; originNodeId; createdAt };
```

The **bare-string `value` form is the pre-groups shape and is still accepted from older peers**
(`accountEventValue`, `github-auth.ts:421`, normalises it to `{ label, token }` using
`legacyAccountLabels`). Any future wire-format change needs equivalent tolerance.

**Two independent validation layers on the receiving side:**

1. `githubCredentialEventSchema` (`server.ts:269-273`), a strict zod union batched by
   `githubCredentialBatchSchema` = `z.object({ events: z.array(...).max(100) })`. Enforces `id` and
   `originNodeId` as UUIDs, `updatedAt` and `createdAt` as ISO datetimes, `key` max 64 for an
   account or 300 for a project, token 1–5000 characters, and `.strict()` on every object.
2. `validateEvent(event)` (`github-auth.ts:425`) inside the module, re-checking key shape, the
   `/^[0-9a-f]{8}-[0-9a-f-]{27}$/i` id pattern, date parseability, "delete must not carry a value",
   "upsert must carry one", and per-entity payload shape via `assertGroupLabel` / `assertToken`.

**Inbound application** — `receiveGitHubCredentialEvents` (`github-auth.ts:494`):

1. Validate every event first; any bad event fails the whole batch.
2. `BEGIN IMMEDIATE`.
3. `INSERT OR IGNORE INTO github_credential_inbox` — zero `changes` means already seen, so the event
   is acknowledged and skipped. Delivery is at-least-once; application is idempotent.
4. Project events are re-keyed through `resolveProjectAlias` (line 503).
5. Read the current version from the active table `UNION ALL` the tombstone table, newest first.
6. Apply only if `compareVersion(incoming, current) > 0`. A `delete` removes the row and writes a
   tombstone; an account `upsert` **re-encrypts the token with this node's key** and upserts,
   drops the tombstone, and clears `is_default` on every other group when `isDefault` is set; a
   project `upsert` re-encrypts and upserts and drops the tombstone.
7. Re-insert the event into this node's own `github_credential_events` (line 520) so it can relay
   onward.
8. `ensureOneDefaultGroup(db)` before commit.
9. Return the ids of every event received, including duplicates — this is the receipt.

**Outbound selection** — `githubCredentialEventsForPeer(peerId, now)` (`github-auth.ts:487`): joins
events to deliveries where `delivered_at IS NULL AND next_attempt_at <= now`, ordered by
`created_at, event_id`, `LIMIT 100`. It returns **only what an explicit
`enqueueGitHubCredentialSync` already enrolled for this peer** — deliberately unlike
`replication.ts:eventsForPeer` (line 75), which auto-enrols every outbox row on read.

**Retry** — `recordGitHubCredentialFailure` (`github-auth.ts:537`): `attempts += 1`,
`next_attempt_at = now + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000`, capped at 300 seconds.
Byte-identical to `replication.ts:81`.

**Transport** — `pushGitHubCredentialsToPeer(peer)` (`server.ts:4881`) loops until the queue drains,
`POST`s to `${peer.url}/api/cluster/github/events` with `Authorization: Bearer ${peer.token}` and
`AbortSignal.timeout(10_000)`, parses `replicationReceiptSchema`, and throws
`"Peer acknowledged no events"` if the receipt is empty, because a peer that acknowledges nothing
would loop forever on the same batch.

## Generic replication wire contract

```ts
export interface ReplicationEvent {
  id: string; originNodeId: string; entityType: string; entityKey: string;
  operation: string; payload: unknown; createdAt: string;
}
export interface ReplicationBatch { events: ReplicationEvent[]; }
```

**Payloads here are plain JSON, not encrypted** — the contrast with `payload_encrypted` is
deliberate. **Exactly four entity types are supported** (`receiveReplicationBatch`,
`replication.ts:172`, a chained ternary that throws `"Unsupported replication event"` on anything
else):

| `entityType` | Handler |
|---|---|
| `name.override` | `applyNameEvent` (`replication.ts:96`) |
| `project.lock` | `applyProjectLockEvent` (`replication.ts:115`) |
| `task` | `applyTaskEvent` (`replication.ts:133`) |
| `conversation.ownership` | `applyConversationOwnershipEvent` (imported from `conversation-ownership.ts`) |

Neither `secret_accounts` / `secret_assignments` nor `project_types` is among them.

Conversation ownership uses `entityKey` = `` `${engine}:${sessionId}` `` and the payload validator
`ownershipPayload` (`conversation-ownership.ts:249`) checks that the key matches the payload and
that `value.originNodeId === event.originNodeId`.

## Internal contract — the credential injection surface

This is the load-bearing internal API. It behaves like a public contract because exactly four
call sites depend on its shape and everything an agent can authenticate to flows through it.

```ts
// src/secrets.ts:235
export function agentEnvironment(projectId: string): NodeJS.ProcessEnv {
  return { ...gitHubEnvironment(projectId), ...genericSecretEnvironment(projectId) };
}
```

Generic secrets are spread **last**, so on a key collision the generic secret account wins over the
GitHub group.

**Four call sites for `agentEnvironment`:**

| Site | Context |
|---|---|
| `src/pi-service.ts:330` | `spawnHook: (context) => ({ ...context, env: { ...context.env, ...agentEnvironment(options.projectId) } })` |
| `src/server.ts:3766` | Claude chat spawn |
| `src/server.ts:3851` | Claude task run — `env: agentEnvironment(record.projectId), onEvent` |
| `src/server.ts:4195` | Claude connection spawn |

**Three call sites for `agentCredentialContext`** — a Markdown block prepended to the **first prompt
of a new conversation only, never on resume**:

| Site | Code |
|---|---|
| `src/server.ts:3762` | `const claudePrompt = resumeSessionId ? prompt : [agentCredentialContext(project.id), prompt].filter(Boolean).join("\n\n");` |
| `src/server.ts:4152` | `const fullPrompt = connection.claude.filePath ? basePrompt : [agentCredentialContext(connection.project.id), basePrompt].filter(Boolean).join("\n\n");` |
| `src/pi-service.ts:334` | `const credentialContext = agentCredentialContext(options.projectId);` |

**What `gitHubEnvironment` exports** (`github-auth.ts:549`) when a token resolves — and `{}` when
none does:

```ts
{ GH_TOKEN: token, GITHUB_TOKEN: token, PI_GITHUB_TOKEN: token,
  GIT_ASKPASS: askPassPath, GIT_TERMINAL_PROMPT: "0" }
```

**What `genericSecretEnvironment` exports** (`secrets.ts:214`): one variable per resolved account
variable — the decrypted value for `kind: "value"`, or the path to
`<dataDir>/secret-files/<accountId>/<VAR_NAME>` for `kind: "file"` — plus the `GH_TOKEN` ⇄
`GITHUB_TOKEN` cross-fill at lines 229-231.

**Consequence.** `PI_GITHUB_TOKEN`, `GIT_ASKPASS`, and `GIT_TERMINAL_PROMPT` come **only** from
`gitHubEnvironment`. A generic `github`-provider account can override `GH_TOKEN` and `GITHUB_TOKEN`
but not those three, so the agent's `gh` CLI and its `git push` can authenticate as two different
GitHub identities.

**Not injected anywhere:** the embedded terminal (`terminal-session.ts:26`).

## Terraform

`deploy/aws-ec2-test/` — 4 `.tf` files (194 lines total) plus `tests/security.tftest.hcl` (30
lines). Provisions an isolated Ubuntu EC2 instance with a public IPv4, inbound SSH and app access
restricted to a single operator `/32`, encrypted storage, and IMDSv2 required. Terraform
`>= 1.9, < 2.0`; AWS provider `~> 6.0`; region from `var.aws_region`.
