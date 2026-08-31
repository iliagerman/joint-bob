# Component Inventory — Joint Bob

## Overview

A "component" here is a source module (or a coherent group of modules) with a distinct
responsibility. **None of these are deployment units** — everything below runs inside one Node.js
process per node, except the Web Client which runs in the browser and the Installer and Deployment
Scripts which run at install time.

Depth marker: components marked **deep** were read in full or in the specific line ranges named;
components marked **skimmed** were read only at export or signature granularity. See
[reverse-engineering-timestamp.md](reverse-engineering-timestamp.md) for the exact scope.

| Component | Primary files | Lines | Depth |
|---|---|---|---|
| HTTP and WebSocket Surface | `src/server.ts` | 4,972 | deep (named ranges) |
| Project Store | `src/store.ts` | 700 | deep |
| Generic Secrets | `src/secrets.ts` | 258 | deep |
| GitHub Credential Groups | `src/github-auth.ts` | 555 | deep |
| Cluster Identity and Pairing | `src/cluster.ts` | 592 | deep (named ranges) |
| Generic Replication | `src/replication.ts` | 183 | deep |
| Conversation Ownership | `src/conversation-ownership.ts` | 272 | deep |
| Names and Colours | `src/names.ts` | 196 | deep (named ranges) |
| Claude Agent Adapter | `src/claude-service.ts`, `src/claude-runtime.ts` | 538 | deep (named ranges) |
| Pi Agent Adapter | `src/pi-service.ts` | 457 | deep (named ranges) |
| Terminal Session | `src/terminal-session.ts` | 66 | deep |
| Tasks and Board | `src/tasks.ts` | 575 | skimmed |
| Worktrees and Task Workspaces | `src/worktrees.ts`, `src/task-workspaces.ts` | 308 | skimmed |
| Syncthing Control | `src/syncthing.ts` | 343 | skimmed |
| Authentication and Sessions | `src/auth.ts` | 277 | skimmed |
| Settings and Preferences | `src/settings.ts`, `src/preferences.ts` | 448 | skimmed |
| Push Notifications | `src/push.ts` | 283 | skimmed |
| Audit Log | `src/audit.ts` | 91 | skimmed |
| Conversation Reviews | `src/conversation-reviews.ts` | 206 | skimmed |
| Project Locks | `src/project-locks.ts` | 92 | skimmed |
| Managed Home and Project Import | `src/managed-home.ts`, `src/project-directory-import.ts` | 212 | skimmed |
| Session Paths and Watcher | `src/session-paths.ts`, `src/watcher.ts` | 351 | skimmed |
| Harnesses Commands and Skills | `src/harnesses.ts`, `src/commands.ts`, `src/skills.ts` | 333 | skimmed |
| Update Recovery and Changelog | `src/update-recovery.ts`, `src/changelog.ts` | 125 | skimmed |
| Shared Types | `src/types.ts` | 151 | deep |
| Web Client | `public/` | 9,415 | deep (named ranges) |
| Installer and Deployment Scripts | `bin/`, `scripts/`, `deploy/` | ~1,000 | skimmed |
| EC2 Smoke Test Infrastructure | `deploy/aws-ec2-test/` | 224 | skimmed |

---

## HTTP and WebSocket Surface

**File:** `src/server.ts` (4,972 lines / 248,022 bytes) — the largest file in the repository.

**Responsibility.** Everything that touches the network: 109 Express route registrations, 8
middleware registrations, the WebSocket server for chat and terminal modes, agent process
lifecycle, peer fan-out, task orchestration and leases, session transfer/recovery/take-ownership,
file resolution and the file editor, board endpoints, Syncthing reconciliation, push-notification
wiring, and the update-recovery startup path.

**Depends on:** every other server module.
**Depended on by:** nothing (it is the entry point).

**Key anchors.** WebSocket server construction line 160; CSP header line 487; zod schema block lines
265-322; auth and CSRF middleware chain lines 848-856; error handler line 3324; project helpers
lines 1788-1897 (`projectsWithSharedNames`, `ProjectLockedError`, `assertProjectEditable`,
`assertProjectRelocationIdle`, `relocateProjectType`, `notifyPeersOfProjectInventory`); credential
injection sites 3762, 3766, 3851, 4152, 4195; `pushGitHubCredentialsToPeer` 4881-4907; terminal-mode
dispatch 4610; peer WS proxy rewrites 4579 and 4591.

**Notable.** A project locked to a peer node cannot be edited locally, but the comment at lines
1810-1811 is explicit that "any node may clear the lock, so it is not a security boundary."

---

## Project Store

**File:** `src/store.ts` (700 lines).

**Responsibility.** Owns project identity, project locations per node, project aliases, and project
types. Owns the shared `DatabaseSync` handle bootstrap.

**Depends on:** `src/types.ts` **only**. It has no cluster or replication dependency — projects
cross nodes through explicit HTTP inventory calls (`POST /api/cluster/projects/import`, `/map`,
`/discover`), never through the outbox.
**Depended on by:** `server.ts`, `names.ts`, and indirectly by `secrets.ts` and `github-auth.ts`
through direct SQL against its tables.

**Tables (DDL as shipped, lines 351-384):**

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'personal',
  color TEXT,
  path TEXT NOT NULL UNIQUE,
  mac_path TEXT,
  sync_folder_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_sync_folder_id
  ON projects(sync_folder_id) WHERE sync_folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_locations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (project_id, node_id)
);

CREATE TABLE IF NOT EXISTS project_aliases (
  alias_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_aliases_project_id ON project_aliases(project_id);

CREATE TABLE IF NOT EXISTS project_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  github_group TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Bootstrap** — `initializeProjectDatabase()` (line 346): mkdir `0700` → open `DatabaseSync` →
`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;` → create the four tables → add
`projects.project_type` if missing (385) → `dropProjectTypeCheckConstraint` (388) → add
`projects.color` if missing (389) → `seedProjectTypes` (392) → `await migrateLegacyProjects` (393).

**Project identity.** IDs are `nanoid(10)` (line 490). `resolveProjectId(db, id)` (line 120) checks
`projects`, then `project_aliases`, then re-checks `projects`; **every public accessor funnels
through it.**

**Alias merge — `rekeyProjectState(db, aliasId, projectId)` (line 249)** calls exactly four re-key
functions: `rekeyTasks` (178), `rekeyTaskHandoffs` (187), `rekeyProjectNames` (217), and
`rekeyProjectGitHubAuth` (232). **There is no `rekeySecretAssignments`** — `secret_assignments` rows
scoped to a project are silently stranded when two nodes' project records merge under an alias.
This is a live defect.

**`removeProject(projectId)` (line 624)** guards on running tasks and unsettled handoffs, then
deletes from `tasks`, `task_tombstones`, `task_migrations`, `task_handoffs`, `name_overrides`,
`name_override_tombstones`, and finally `projects` (cascading to `project_locations` and
`project_aliases`). **It deletes neither `github_project_auth` rows nor `secret_assignments`
rows** — both are left orphaned.

**Project types.** `projectTypeIdFromLabel(label)` (661) lowercases and slugifies;
`reservedProjectTypeIds = new Set(["projects", "tickets"])` (41) because those names belong to the
managed home's own folders; `saveProjectType` (672) canonicalises the id **before** the reserved
check so `"../tickets"` reduces to `tickets` and is rejected; `deleteProjectType` (693) refuses if
any project uses the type and refuses to leave zero types; `seedProjectTypes` (327) inserts
`personal`/`Personal` and `work`/`Work` **only when the table is empty**, so a deleted type stays
deleted across restarts.

**Public API.** `listProjects`, `canonicalProjectId`, `projectAliasIds`, `registerProjectAliases`,
`getProject`, `addProject`, `importProject`, `renameProject`, `updateProjectColor`,
`updateProjectTypeAndPath`, `updateProjectMacPath`, `updateProjectSyncFolderId`, `removeProject`,
`touchProject`, `projectTypeIdFromLabel`, `listProjectTypes`, `saveProjectType`,
`deleteProjectType`.

**Side effect.** `addProject` with `options.synced` writes an `AGENTS.md` into the project directory
(`writeProjectInstructions`, line 418, flag `wx` so an existing file is never overwritten) naming
the local path, the Syncthing folder ID, and the line *"Do not synchronize .git or machine-specific
credentials."*

---

## Generic Secrets

**File:** `src/secrets.ts` (258 lines).

**Responsibility.** Node-local, encrypted, provider-tagged bundles of environment variables, scoped
to a project or a project type, and the composition point where the two credential systems meet.

**Depends on:** `src/github-auth.ts` (import at `secrets.ts:6` — the **only** edge between the two
credential systems), plus direct SQL against `projects`, `project_aliases`, and `project_types`.
**Depended on by:** `src/server.ts`, `src/pi-service.ts`.

**Tables — both created on one line at `secrets.ts:27`:**

```sql
CREATE TABLE IF NOT EXISTS secret_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  variables_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secret_assignments (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY(scope_type, scope_id, account_id)
);
```

**What is deliberately absent:** no `CHECK` on `scope_type`, no foreign key from
`secret_assignments.account_id` to `secret_accounts.id`, no `updated_at` or `origin_node_id` on
either table (so neither participates in the last-writer-wins rule used everywhere else), and no
index beyond the primary key. **Adding a third scope tier is a code-and-validation change, not a
table rebuild.**

**Encryption.** `key()` (31) prefers `JOINT_BOB_SECRET_KEY ?? MASTER_BOB_SECRET_KEY` (base64, must
decode to exactly 32 bytes), else reads `<dataDir>/secret.key`, else generates `randomBytes(32)` at
mode `0600`. `encrypt` (50) is AES-256-GCM with a 12-byte random IV serialised as
`` `${iv}.${authTag}.${body}` `` in base64. **This block is duplicated verbatim in
`github-auth.ts:40-72`.** All variables of one account are stored as a single encrypted JSON array
(`saveSecretAccount`, 172) — there is no per-variable row.

**Resolution — `resolved(project)` (line 147), the current two-tier model:**

```ts
function resolved(project: string): Array<{ row: AccountRow; direct: boolean }> {
  const projectId = canonicalScopeId("project", project);
  const type = db().prepare("SELECT project_type FROM projects WHERE id = ?").get(projectId) as { project_type: string } | undefined;
  const inherited = type?.project_type ? scopeRows("project_type", canonicalScopeId("project_type", type.project_type)) : [];
  const direct = scopeRows("project", projectId);
  const directIds = new Set(direct.map((row) => row.id));
  return [...inherited.filter((row) => !directIds.has(row.id)).map((row) => ({ row, direct: false })), ...direct.map((row) => ({ row, direct: true }))];
}
```

Inherited first, deduplicated by **account id**, direct last. **This is a merge, not a
first-hit-wins chain** — the opposite shape to GitHub group resolution.

**Collision policy at two layers with different rules.** `assertNoCollision` (139) rejects a
same-scope duplicate variable name at **assignment** time. `genericSecretEnvironment` (214) resolves
a cross-scope collision silently at **injection** time via
`if (!direct && variable.name in values) continue;`.

**File-kind secrets (219-227).** On **every** injection: mkdir
`<dataDir>/secret-files/<accountId>` at `0700`, write `<VAR_NAME>` at `0600`, export the path.
`clearFiles(id)` (111) runs only on account save (173) and delete (188). **Nothing removes a secret
file when a session ends.**

**Cross-fill (229-231).** `GH_TOKEN` ⇄ `GITHUB_TOKEN`, because "the gh CLI reads `GH_TOKEN` while
most other GitHub tooling reads `GITHUB_TOKEN`, so one pasted token fills both."

**Exports.** `listSecretAccounts`, `saveSecretAccount`, `deleteSecretAccount`,
`getScopeSecretAccounts`, `setScopeSecretAccounts`, `genericSecretEnvironment`, `agentEnvironment`,
`agentCredentialContext`.

---

## GitHub Credential Groups

**File:** `src/github-auth.ts` (555 lines) — the single largest domain module after `store.ts`.

**Responsibility.** Named GitHub identities ("groups"), per-project group assignment and token
override, the four-tier resolution chain, the `GIT_ASKPASS` mechanism that makes `git push` work,
legacy JSON migration, and the dedicated node-to-node credential replication pipeline.

**Depends on:** `src/audit.ts` (`appendAuditEvent`, `ensureAuditSchema`), `src/cluster.ts`
(`getClusterNode`).
**Depended on by:** `src/secrets.ts`, `src/server.ts`.

**Nine tables (lines 91-101, one `exec`):**

```sql
CREATE TABLE IF NOT EXISTS github_accounts (
  account TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS github_project_auth (
  project_id TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT,
  updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS github_auth_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_legacy_file_migrations (
  path TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_digest TEXT, migrated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_account_tombstones (
  account TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_project_auth_tombstones (
  project_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_credential_events (
  event_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, operation TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS github_credential_deliveries (
  event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL,
  delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id, peer_id));
CREATE TABLE IF NOT EXISTS github_credential_inbox (
  event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
```

**Naming legacy.** The *group* concept lives in a table called `github_accounts` with a primary key
column called `account`, and `github_project_auth.account` holds a **group id** (or `''` for "no
group"), not a GitHub username.

**Lazy column migrations in `authDatabase()` (102-111):** `github_accounts.origin_node_id` (102);
`github_accounts.label` (103) plus two backfills — `legacyAccountLabels` maps `personal` → `Personal`
and `sela` → `Sela` (105), then `UPDATE github_accounts SET label = account WHERE label = ''` (106);
`github_accounts.is_default` (107) then `ensureOneDefaultGroup` (108);
`github_project_auth.origin_node_id` (109); `github_legacy_file_migrations.applied_digest` (110);
`ensureAuditSchema` (111).

**Resolution chain — `projectToken(projectId, project)` (296)**, four tiers, first-hit-wins, with
fall-through on a dangling group reference:

1. `github_project_auth.token` — the per-project token override
2. `github_project_auth.account` — the project's assigned group
3. `projectTypeGroupId(projectId)` (272) — joins `projects` to `project_types` on
   `projects.project_type = project_types.id`, reads `project_types.github_group`, returns `null`
   when `project_types` does not exist
4. `defaultGroupId()` (289) — `SELECT account FROM github_accounts WHERE is_default = 1 LIMIT 1`

**Environment injection — `gitHubEnvironment(projectId)` (549):**

```ts
export function gitHubEnvironment(projectId: string): NodeJS.ProcessEnv {
  ensureLocalFiles();
  const project = projectAuth(projectId);
  const token = projectToken(projectId, project);
  if (!token) return {};
  return { GH_TOKEN: token, GITHUB_TOKEN: token, PI_GITHUB_TOKEN: token, GIT_ASKPASS: askPassPath, GIT_TERMINAL_PROMPT: "0" };
}
```

**`ensureLocalFiles()` (219)** rewrites `<dataDir>/github-askpass.sh` at mode `0700` on **every**
call:

```sh
#!/bin/sh
case "$1" in
  *Username*) printf "%s\n" "x-access-token" ;;
  *) printf "%s\n" "$PI_GITHUB_TOKEN" ;;
esac
```

**Version allocation — `nextVersion` (229):** reads the newest of the active row and the tombstone
for the key and returns `now.toISOString()` unless that is not strictly greater than the current
version, in which case `current + 1 ms`. Monotonic per key even under clock skew.

**Legacy JSON migration (120-217).** Sources: `JOINT_BOB_GITHUB_AUTH_PATH ??
PI_MOBILE_WEB_GITHUB_AUTH_PATH` if set, plus `<dataDir>/github-auth.json`, deduplicated. Each is
SHA-256 digested. Two independent markers gate the work: `github_auth_migrations['json']` (has any
migration run) and per-path `github_legacy_file_migrations.applied_digest` (has *this exact content*
been applied). `applyLegacySnapshot` (136) upserts each account with `personal` seeded as default,
tombstones accounts whose token is now absent, upserts every project mapping, and **tombstones every
previously-active project id missing from the snapshot** (156-161).
`cleanupLegacyGitHubCredentialFiles` (199) refuses to run without the `json` marker, re-digests each
file, refuses if a digest changed after migration
(`"Legacy GitHub credential file changed after migration"`), then unlinks.

**Public API.** `ensureGitHubCredentialMigration`, `cleanupLegacyGitHubCredentialFiles`,
`listGitHubGroups`, `getGitHubAuthStatus`, `saveGitHubGroup`, `deleteGitHubGroup`,
`updateProjectGitHubAuth`, `removeProjectGitHubAuth`, `enqueueGitHubCredentialSync`,
`githubCredentialEventsForPeer`, `receiveGitHubCredentialEvents`, `recordGitHubCredentialReceipt`,
`recordGitHubCredentialFailure`, `gitHubEnvironment`.

---

## Cluster Identity and Pairing

**File:** `src/cluster.ts` (592 lines).

**Responsibility.** This node's identity, peer records and their bearer tokens, the machine
credential used for pairing, membership state, and a **third** replication pipeline for membership.

**Depended on by:** `github-auth.ts` (`getClusterNode`), `names.ts`, `server.ts`.

**Tables.** `cluster_node`, `cluster_peers`, `cluster_machine_credentials`,
`cluster_membership_state`, `cluster_membership_deliveries`, `cluster_member_tombstones`,
`cluster_secret_migrations`.

**Credential handling.** `cluster_peers.token` is encrypted at rest with `encryptToken` /
`decryptToken` against the same `secret.key`. `cluster_secret_migrations` version `1`
(lines 219-226) is the pass that encrypted every previously-plaintext peer token in place; the
fresh-install path is at line 250. `getClusterMachineToken()` (262) returns the singleton machine
token used as the pairing credential — `README.md` warns *"Do not pair nodes over plain public HTTP
because pairing tokens are machine credentials."*

**Lazy migration.** `cluster_peers.last_seen_at` added via `tableHasColumn` at line 215. A legacy
store is migrated to `cluster_node` + `cluster_peers` at lines 236-253.

---

## Generic Replication

**File:** `src/replication.ts` (183 lines).

**Responsibility.** The general-purpose event outbox, inbox, and delivery tracking for four entity
types.

**Depends on:** `src/types.ts` (`PROJECT_COLORS`, `TaskRecord`), and mutually on
`src/conversation-ownership.ts`.
**Depended on by:** `conversation-ownership.ts`, `names.ts`, `server.ts`.

**Tables.** `replication_outbox` (`event_id` PK, `origin_node_id`, `entity_type`, `entity_key`,
`operation`, `payload` as JSON text, `created_at`), `replication_inbox` (`event_id` PK,
`origin_node_id`, `received_at`), `replication_deliveries` (`(event_id, peer_id)` PK, `attempts`,
`next_attempt_at`, `delivered_at`, `last_error`).

**Payloads are plain JSON, not encrypted** — the deliberate contrast with
`github_credential_events.payload_encrypted`.

**Four supported entity types** (`receiveReplicationBatch`, 172): `name.override` → `applyNameEvent`
(96), `project.lock` → `applyProjectLockEvent` (115), `task` → `applyTaskEvent` (133),
`conversation.ownership` → `applyConversationOwnershipEvent`. Anything else throws
`"Unsupported replication event"`. **Neither `secret_accounts`/`secret_assignments` nor
`project_types` is among them.**

**Auto-enrolment on read — `eventsForPeer` (75):** `INSERT OR IGNORE INTO replication_deliveries
... SELECT event_id, ?, 0, ?, NULL, NULL FROM replication_outbox`, then select undelivered rows due
now, ordered by `created_at, event_id`, `LIMIT 100`. **This is the opposite policy to the GitHub
pipeline.**

**Idempotency and relay (160).** `INSERT OR IGNORE INTO replication_inbox` — zero changes means
already seen. If `!applied`, the inbox row is removed so the event can be retried (only
`applyTaskEvent` can return `false`, when the task has an active handoff). Line 177: an event that
originated here and came back is re-queued for onward relay.

**`applyTaskEvent` (133)** resolves the project alias, refuses upserts for tasks whose
`currentNodeId` is tombstoned in `cluster_member_tombstones`, defers to an in-flight
`active_handoff_id`, and **preserves node-local fields** (`worktree_path`, `worktree_branch`,
`session_path`, `handoff_context`) when the incoming record is for this node and nulls them.

**Schema-ensure functions exported from here** rather than from the modules that own the data:
`ensureReplicationSchema` (29) and `ensureTaskSchema` (35, which also runs eight
`ALTER TABLE tasks ADD COLUMN` migrations). `ensureNameSchema` (52) and `ensureProjectLockSchema`
(59) are private duplicates of what `names.ts` and `project-locks.ts` also declare.

---

## Conversation Ownership

**File:** `src/conversation-ownership.ts` (272 lines).

**Responsibility.** Decides which node owns a conversation, fences writes during recovery and
transfer, and detects split brain.

**Depends on / depended on by:** `src/replication.ts`, mutually.

**Identity is the pair `(engine, sessionId)`:**

```ts
export type ConversationEngine = "pi" | "claude";
export type ConversationOwnershipStatus = "claiming" | "owned" | "recovering" | "transferring" | "conflict";

export interface ConversationOwnership {
  engine: ConversationEngine;
  sessionId: string;
  ownerNodeId: string;
  epoch: number;
  status: ConversationOwnershipStatus;
  transferToNodeId: string | null;
}
```

**Table (line 40):**

```sql
CREATE TABLE IF NOT EXISTS conversation_ownership (
  engine TEXT NOT NULL CHECK(engine IN ('pi', 'claude')),
  session_id TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  status TEXT NOT NULL CHECK(status IN ('claiming', 'owned', 'recovering', 'transferring', 'conflict')),
  transfer_to_node_id TEXT,
  PRIMARY KEY(engine, session_id)
);
```

`ensureConversationOwnershipSchema` (51) is a **rename-and-rebuild** migration: if the stored
`sqlite_master.sql` lacks both `'claiming'` and `'conflict'`, rename to
`conversation_ownership_old`, recreate, `INSERT ... SELECT` all six columns, drop the old table.
**There is no `project_id` column** — ownership is global to the node, not scoped to a project.

**Where `sessionId` comes from — three derivations for the same idea:**

1. **Claude** — `claude-service.ts:248`: `id: path.basename(filePath, ".jsonl")`, the transcript
   filename stem, deduplicated across `claudeProjectDirs` by keeping the first summary per id
   (262-267).
2. **Pi** — `pi-service.ts` `summarizeSession`: `id: String(record.id ?? record.path ?? randomUUID())`.
3. **Transcript path** — `SessionSummary.path`, which for Claude is the prefixed form
   `` `claude:${filePath}` `` (`claude-service.ts:249`) and for Pi is the bare filesystem path.
   `resolveClaudeSessionPath` (270) strips the prefix, resolves, and rejects anything outside
   `claudeProjectsRoot()`.

A **fourth keying** exists: `names.ts` stores per-conversation titles and colours in `name_overrides`
under `scope = 'sessions'` / `'session_colors'` with `key = conversationId`, where `conversationId`
is `SessionSummary.id` (`names.ts:183`, `:187`, `:192`).

**Lifecycle** (each mutation goes through `ownershipTransaction`, 110):
`claimConversationOwnership` (153, CAS from undefined to `{ epoch: 1, status: "owned" }`),
`finalizeConversationClaim` (161), `takeConversationOwnership` (169, force-take with
`epoch = (current?.epoch ?? 0) + 1`), `beginConversationRecovery` / `finishConversationRecovery`
(178, 187), `beginConversationTransfer` / `commitConversationTransfer` (196, 207),
`compareAndSetConversationOwnership` (135, the primitive, idempotent when current equals proposed).

**Split brain — `applyConversationOwnershipEvent` (231):** a `conflict` record is terminal; lower
epochs are rejected; an equal-epoch differing record is accepted only for a
`validSameEpochTransition` (224 — same owner, and `claiming → owned` or `owned → recovering|transferring`),
otherwise a `conflictOwnership` record is written with the two owner ids sorted and a
`conversation_ownership_split_brain` diagnostic is logged. `ConversationOwnershipError` (265) then
fences writes with *"Conversation ownership is conflicted; writes are fenced"*.

**Timing constraint that matters for conversation-scoped credentials.** Secrets are injected once at
spawn, before a new conversation necessarily has an id. `server.ts:3802-3806` reads a new Pi
conversation's id back only *after* creation.

---

## Names and Colours

**File:** `src/names.ts` (196 lines).

**Responsibility.** User-set names and colours for projects and conversations, replicated through
the generic outbox.

**Depends on:** `cluster.ts`, `replication.ts`, `store.ts`.

**Tables.** `name_overrides`, `name_override_tombstones`, `name_override_migrations`.

**Keying.** `scope = 'projects'` with `key = projectId`; `scope = 'sessions'` and
`scope = 'session_colors'` with `key = conversationId`. `migrateStableProjectIds` (lines 38-53,
marker `'stable-project-id-v1'`) re-keys project name overrides from `projectKey(path)` to the
stable project id, matching only when exactly one project's path basename matches. Legacy source
`.pi-mobile-web/names.json` (or `JOINT_BOB_NAMES_PATH` / `PI_MOBILE_WEB_NAMES_PATH`) is imported at
lines 90-103.

---

## Claude Agent Adapter

**Files:** `src/claude-service.ts` (464 lines), `src/claude-runtime.ts` (74 lines).

**Responsibility.** Lists, reads, and summarises Claude Code sessions from their on-disk
transcripts; builds handoff context; owns the `claude_runtime_sessions` table.

**Key functions** (lines 234-300): `listClaudeSessions`, `resolveClaudeSessionPath`,
`claudeSessionTitle`, `loadClaudeMessages`, `buildHandoffContext`.

**Two decisions encoded as comments.** Lines 256-258: *"Syncthing rewrites mtime when a peer
advertises new metadata, so a synchronized transcript looks freshly active with no new message. The
transcript itself is the only honest record of when this conversation last moved."* Lines 262-265:
*"A conversation claimed from another node exists under that node's encoded directory as well as
this node's, so the same transcript is read twice."*

---

## Pi Agent Adapter

**File:** `src/pi-service.ts` (457 lines).

**Responsibility.** Wraps `@earendil-works/pi-coding-agent` (`SessionManager`, `AgentSession`,
`AgentSessionEvent`); lists and summarises Pi sessions; spawns Pi with injected credentials.

**Depends on:** `src/secrets.ts`.

**Key functions** (lines 255-300): `summarizeSession`, `listSessionsForDirectory`, `sessionsForCwd`,
`listPiSessions`. Spawn hook at line 330:
`spawnHook: (context) => ({ ...context, env: { ...context.env, ...agentEnvironment(options.projectId) } })`.
Credential context at line 334.

---

## Terminal Session

**File:** `src/terminal-session.ts` (66 lines).

**Responsibility.** Attaches a WebSocket to a real pseudo-terminal in the project folder, via
`node-pty`.

**Message schema** at line 5 (`terminalMessageSchema`). Comment at lines 22-23: *"A real
pseudo-terminal, so interactive programs, colours, job control, and xterm resize all behave exactly
like a local terminal in the project folder."*

**Credential gap.** Line 26 spawns with `env: { ...process.env, TERM: "xterm-256color" }` — **no
project secrets, no GitHub token.** A project that is fully authenticated for the agent is
unauthenticated in the terminal.

---

## Tasks and Board

**File:** `src/tasks.ts` (575 lines). **Skimmed.**

**Responsibility.** Kanban cards, eligibility rules, leases, handoffs between nodes, archival, and
merge. Tables `tasks`, `task_tombstones`, `task_handoffs`, `task_handoff_rejections`,
`task_migrations`. The `tasks` schema is actually ensured from `replication.ts:35`, which also runs
eight `ALTER TABLE tasks ADD COLUMN` migrations.

---

## Worktrees and Task Workspaces

**Files:** `src/worktrees.ts` (226 lines), `src/task-workspaces.ts` (82 lines). **Skimmed at
signature level, with one cross-cutting analysis run in full.**

**Responsibility.** Git worktree creation and teardown, ticket workspaces under
`<home>/tickets/<project-id>/<ticket-id>`.

**Load-bearing fact, verified across the whole tree:** `worktrees.ts` runs `git` via
`execFileAsync("git", ["-C", cwd, ...args])` for `status`, `rev-parse`, `show-ref`, `merge-base`,
`merge`, `worktree add/remove/list`, `branch`, `bundle create/list-heads/verify`, `fetch`, and
`check-ref-format` — **but never `push`.** There is no in-process git push anywhere in the
codebase; the agent runs `git push` itself, so the injected environment *is* the push contract.

---

## Syncthing Control

**File:** `src/syncthing.ts` (343 lines). **Skimmed.**

**Responsibility.** Installs, configures, and drives Syncthing 2.1.3 (SHA-256 checksummed per
platform in `scripts/versions.sh`) to replicate project file content between nodes. `.stignore`
excludes `.git`, `node_modules/`, `dist/`, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.joint-bob/`,
`credentials.json`, and `service-account*.json`, so credential material cannot leak through file
sync.

---

## Authentication and Sessions

**File:** `src/auth.ts` (277 lines). **Skimmed.**

**Responsibility.** Single-user password login, session cookies, CSRF, login-attempt throttling.
Tables `users`, `login_sessions`, `login_attempts`. Consumed by the `requireHttpAuth` /
`requireCsrf` middleware pair registered at `server.ts:848`.

---

## Settings and Preferences

**Files:** `src/settings.ts` (224 lines), `src/preferences.ts` (224 lines). **Skimmed.**

**Responsibility.** Node settings (`node_settings`) and per-user preferences (`user_preferences`).
`settings.projects.homePath` is the managed home root that determines where
`<home>/<type>/<project-name>` and `<home>/tickets/...` land.

---

## Push Notifications

**File:** `src/push.ts` (283 lines). **Skimmed.**

**Responsibility.** VAPID web push via `web-push` 3.6.7. Tables `push_subscriptions`,
`push_session_subscriptions`, `push_vapid_keys` (the keypair is encrypted), `push_migrations`.

---

## Audit Log

**File:** `src/audit.ts` (91 lines). **Skimmed.**

**Responsibility.** `audit_events`, written inside the same transaction as the mutation being
audited. Known event names from the credential path: `github.group.saved`,
`github.group.deleted` (with `{ orphanedProjects }`), `github.project.updated`,
`github.credentials.sync` (with `{ peers, enrolled }`). Exposed by `GET /api/audit`.

---

## Conversation Reviews

**File:** `src/conversation-reviews.ts` (206 lines). **Skimmed.** Tables
`conversation_review_states`, `conversation_review_tracking`. Backs
`PUT /api/projects/:projectId/sessions/reviewed`, `.../reviewed-all`, and `GET /api/reviews/pending`.

---

## Project Locks

**File:** `src/project-locks.ts` (92 lines). **Skimmed.** Table `project_locks`, replicated through
the generic outbox as `project.lock`. Explicitly **not a security boundary** — any node may clear a
lock (`server.ts:1810-1811`).

---

## Managed Home and Project Import

**Files:** `src/managed-home.ts` (63 lines), `src/project-directory-import.ts` (149 lines).
**Skimmed.**

**Responsibility.** The managed home layout — `<home>/projects/<personal|work>/<project-name>` for
the legacy default types, `<home>/<type>/<project-name>` where a project type's id doubles as the
folder name, and `<home>/tickets/<project-id>/<ticket-id>` for board-card workspaces — plus
importing an existing directory as a project. `ensureManagedHome(...)` is called from
`PUT /api/project-types` to create a new type's folder.

---

## Session Paths and Watcher

**Files:** `src/session-paths.ts` (214 lines), `src/watcher.ts` (137 lines). **Skimmed.** Resolve
where each engine keeps its transcripts and watch them for change, feeding the `sessionFile`,
`sessionFileChanged`, and `watchReady` WebSocket messages.

---

## Harnesses Commands and Skills

**Files:** `src/harnesses.ts` (122), `src/commands.ts` (122), `src/skills.ts` (89). **Skimmed.**
Back `GET /api/harnesses`, `GET /api/models`, `GET /api/projects/:projectId/skills`, and
`GET /api/projects/:projectId/commands`.

---

## Update Recovery and Changelog

**Files:** `src/update-recovery.ts` (73), `src/changelog.ts` (52). **Skimmed.** Table
`update_recoveries`. Back `GET /api/changelog` and `POST /api/update/prepare`, and the
`updatePreparing` WebSocket message.

---

## Shared Types

**File:** `src/types.ts` (151 lines).

**Responsibility.** The only shared type module. No runtime behaviour beyond `PROJECT_COLORS`.

```ts
/** Project types are user-defined; the id doubles as the folder name under the managed home. */
export type ProjectType = string;

export interface ProjectTypeRecord {
  id: string;
  label: string;
  githubGroup: string | null;
}
```

`ProjectRecord` (line 35) carries `type?: ProjectType` — optional, defaulted to `"personal"` at
every write site (`store.ts` `projectValues` 94, `addProject` 495, `importProject` 521).

`SessionSummary` (line 57) carries `id`, `path`, `harnessId: "pi" | "claude"`, `agentId`,
`agentLabel`, `agentModel?`, `title`, `createdAt?`, `updatedAt?`, `firstMessage?`,
`parentSessionPath?` (Pi child-conversation nesting), `taskStatus?`, `taskId?`, `running?`,
`reviewState?: "running" | "needs_review" | "reviewed"`, and `color?: ProjectColor`.

---

## Web Client

**Files:** `public/app.js` (5,854 lines), `public/index.html` (944 lines), `public/styles.css`
(1,794), `public/board.js` (303), `public/markdown.js` (439), `public/composer-commands.js` (32),
`public/sw.js` (47), `public/boot.js` (6), `public/vendor/xterm/`.

**Responsibility.** The entire user interface. **Zero frameworks, no bundler, no build step** —
served verbatim by `express.static`. Plain DOM APIs, native `<dialog>` with `showModal()`/`close()`,
`data-testid` on every interactive element, PWA with a service worker whose `CACHE_NAME` must be
bumped when the shell or icons change.

**Settings tabs (`index.html:285-292`)** — seven in a `role="tablist"`: `account`, `notifications`,
**`github` (labelled "Secrets")**, `cluster`, `projects`, `engines`, `changelog`. Note the mismatch:
`data-settings-tab="github"` renders the *generic secret accounts* panel, while the GitHub *groups*
live under the `projects` tab.

**`settingsPanel-projects` (`index.html:352-390`)** has four fieldsets: managed workspace, **GitHub
groups**, **project types**, and an informational Syncthing block. A project-type row
(`renderProjectTypes`, `app.js:1404-1450`) contains, in DOM order: the label, `<code>/${type.id}</code>`,
the GitHub group `<select>` (`project-type-group-select`), a **Secrets** button
(`project-type-secrets-button`), and a **Delete** button. **This row is exactly where the two
credential systems sit side by side for the same scope.**

**Project row menu (`app.js:2066-2078`)** — two adjacent entries for the same reason:

```js
{ label: "GitHub access",   icon: "github", testid: "project-github-button",  onSelect: () => openProjectGithubSettings(project) },
{ label: "Secret accounts", icon: "key",    testid: "project-secrets-button", onSelect: () => openSecretScope("project", project.id, project.name) },
```

**Generic secrets UI (`app.js:5677-5850`, `index.html:727-747`).** Comment at 5677: *"Generic secret
accounts are deliberately node-local; only metadata is ever rendered."* Provider presets
(`secretProviderPresets`): `aws` → `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (both `value`);
`google` → `GOOGLE_APPLICATION_CREDENTIALS` (`file`); `github` → `GH_TOKEN` (`value`); `custom` → one
empty row. `applySecretProviderPreset` (5786) swaps rows **only if no value has been typed and no
account is being edited**. `openSecretScope(scopeType, scopeId, label)` (5808) renders a checkbox per
account and the scope form (5824) `PUT`s the whole replacement set. Account-form submit (5836)
requires unique non-empty names, requires a value for every variable on a **new** account, and for
`provider === "google"` runs `JSON.parse` on any file-kind value.

**Client data flow.** Three independent module-level caches — `githubGroups`, `projectTypes`,
`secretAccounts` — each refreshed by a full reload after every mutation. **There is no shared state
container.**

---

## Installer and Deployment Scripts

**Files:** `bin/joint-bob.mjs`, `scripts/*` (17 files), `deploy/joint-bob.service`,
`deploy/com.joint-bob.node.plist`. **Skimmed** except `scripts/versions.sh` (read in full),
`scripts/hooks/pre-push` (first 30 lines), and `bin/joint-bob.mjs` (first 30 lines).

**Responsibility.** Install/staging/backup/rename path, native service units
(`joint-bob.service` as a systemd **user** unit requiring `loginctl enable-linger`, and
`com.joint-bob.node` as a macOS launch agent), pinned runtime versions
(`JOINT_BOB_NODE_VERSION=22.23.2`, `JOINT_BOB_PI_VERSION=0.84.2`,
`JOINT_BOB_CLAUDE_VERSION=2.1.239`, `JOINT_BOB_SYNCTHING_VERSION=2.1.3` with four per-platform
SHA-256 checksums), the pre-push changelog gate, and the push-triggered deploy to installed nodes.

Production services run from `~/.local/share/joint-bob/app` — **never from a source checkout**.
Every deploy creates a mode-`0600` SQLite backup before replacing the installed copy and verifies
the reported release; logs go to `~/.joint-bob/logs/push-deploy.log`.

---

## EC2 Smoke Test Infrastructure

**Files:** `deploy/aws-ec2-test/main.tf` (129 lines), `variables.tf` (32), `outputs.tf` (19),
`versions.tf` (read in full), `tests/security.tftest.hcl` (30). **Skimmed** apart from `versions.tf`.

**Responsibility.** Provisions an isolated Ubuntu EC2 instance with a public IPv4, inbound SSH and
app access restricted to a single operator `/32`, encrypted storage, and IMDSv2 required, for the
smoke test described in `README.md`. Terraform `>= 1.9, < 2.0`; AWS provider `~> 6.0`.
