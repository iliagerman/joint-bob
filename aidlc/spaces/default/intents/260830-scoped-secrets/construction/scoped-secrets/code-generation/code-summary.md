# Code Summary — Scoped Secrets

**Intent**: `260830-scoped-secrets` · **Unit**: `scoped-secrets` · **Scope**: express · **Depth**: Minimal
**Testing contract**: `sha256:d04120c3c4a1e751020f82be7855855776bc494591d88beb206ed64156683fe5` (test-after)

Two overlapping credential systems became one. GitHub credential groups are gone — module,
nine tables, four-tier resolution chain, HTTP routes, UI and dedicated replication pipeline —
and the push token is now an ordinary `GH_TOKEN` variable inside an ordinary secret account.
"Project types" are "workspaces" through the UI, the API, the code and the database. A secret
account attaches at three scopes (workspace, project, conversation) and resolution is
most-specific-wins per variable name.

## Files created

| Path | What it does |
|---|---|
| `src/secrets-migration.ts` | `ensureWorkspaceSecretsMigration(db)` — marker-gated conversion of GitHub credential groups into secret accounts, plus `rekeySecretAssignments` for alias merges. |
| `src/secret-replication.ts` | The per-account replication pipeline: `secret_credential_events` / `_deliveries` / `_inbox`, reusing the old GitHub pipeline's enqueue / deliver / receive / retry mechanics verbatim. |
| `test/workspace-schema.test.ts` | The rename preserves rows, moves no directory, and the three scope types round-trip. |
| `test/secrets-migration.test.ts` | Every project resolves the same token before and after; the migration is idempotent; the legacy schema is dropped. |
| `test/secret-replication.test.ts` | Node-local accounts never enqueue; re-encryption on arrival; local overwrite wins; malformed peer input is rejected whole. |
| `test/secrets-api.test.ts` | Every secrets endpoint returns metadata only; the three scopes round-trip over HTTP. |

## Files deleted

| Path | Why |
|---|---|
| `src/github-auth.ts` | FR2.1 — the GitHub credential group model is removed in full, after `ensureWorkspaceSecretsMigration` has read its tables. |
| `test/github-account-groups.test.ts`, `test/github-auth-mesh-api.test.ts`, `test/github-auth-sync.test.ts`, `test/github-sync-api.test.ts` | They test the removed model. See *Test suite* below. |

Renamed: `test/project-types.test.ts` → `test/workspaces.test.ts`,
`test/project-type-api.test.ts` → `test/workspace-api.test.ts`,
`test/settings-github-groups-placement.test.ts` → `test/settings-workspace-placement.test.ts`.

## Files modified

| Path | Change |
|---|---|
| `src/types.ts` | `ProjectType` → `WorkspaceId`; `ProjectTypeRecord` → `WorkspaceRecord`, minus `githubGroup`. |
| `src/store.ts` | `migrateWorkspaceSchema`, `dropWorkspaceCheckConstraint`, `dropLegacyGitHubSchema`, `seedWorkspaces`; `listWorkspaces` / `saveWorkspace` / `deleteWorkspace` / `workspaceIdFromLabel` / `updateProjectWorkspaceAndPath`; `WorkspaceError`; attachment cleanup in `removeProject` and `deleteWorkspace`; `rekeyProjectGitHubAuth` replaced by `rekeySecretAssignments`. |
| `src/secrets.ts` | Three scope tiers; `replicate` and `origin_node_id` columns; the `secret_assignments_account_id` index; three-tier `resolved()`; the GitHub environment contract and the askpass helper moved in from `github-auth.ts`; `persistConversationSecretAccounts`; `ensureSecretSchema` and the crypto helpers exported. |
| `src/server.ts` | Every `/api/github-auth*` route deleted; `/api/project-types` → `/api/workspaces`; `POST /api/secrets/sync`; `POST /api/cluster/secrets/events`; `POST /api/cluster/github/events` reduced to a 410 stub; `secretAccountIds` on the chat socket. |
| `src/pi-service.ts` | `PiSessionOptions.conversation`, forwarded to `agentEnvironment` and `agentCredentialContext`. |
| `src/managed-home.ts` | `managedTypeFolderName` / `managedTypeRoot` → `managedWorkspace*`. The derivation is unchanged, so no directory moves. |
| `public/index.html`, `public/app.js` | GitHub group and sync dialogs, the project-type group picker and the per-project GitHub override removed; Workspaces section; replicate toggle; secret sync dialog; conversation account picker in the new-conversation dialog. |
| `public/sw.js` | `CACHE_NAME` bumped to `joint-bob-v67` (the shell changed). |
| `README.md`, `AGENTS.md` | Managed-path layout, credential sync wording, and a new **Credentials** section describing the one model. |

## Key implementation decisions

**Migration ordering is explicit and load-bearing.** `initializeProjectDatabase` runs
`migrateWorkspaceSchema` *before* the `CREATE TABLE IF NOT EXISTS` block — otherwise an empty
`workspaces` table would already exist and the legacy `project_types` could not be renamed onto
it — then `ensureWorkspaceSecretsMigration`, then `dropLegacyGitHubSchema`. The migration reads
`github_accounts`, `github_project_auth` and `workspaces.github_group`; the drop removes them.
Reversing those two steps would delete the credentials before converting them.

**The rename uses SQLite's own `ALTER TABLE`.** `RENAME COLUMN` rewrites the legacy two-value
`CHECK` constraint along with the column, so `dropWorkspaceCheckConstraint` then matches on
`workspace_id` and rebuilds the table to remove it. `ALTER TABLE workspaces DROP COLUMN
github_group` needs SQLite ≥ 3.35; Node 22 ships 3.51.

**GitHub became a provider, not a code path.** `applyGitHubEnvironment` runs *after* the
three-tier merge and reads the resolved variable map. If a `GH_TOKEN` (or `GITHUB_TOKEN`)
resolved, it fans that one value out to `GH_TOKEN`, `GITHUB_TOKEN` and `PI_GITHUB_TOKEN`,
writes the askpass helper and sets `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT`. If none resolved,
no helper is written and none of the variables exist. Resolution itself has no provider branch.

**FR6.6's "resolves no token of its own" is checked by variable, not by origin.**
`workspaceResolvesToken` looks for an attached account declaring `GH_TOKEN`, so the default
group's account never lands on top of a workspace that already has one — which also keeps
`assertNoCollision`'s invariant true for rows the migration writes directly.

**OQ1 is closed by prevention (D8).** `assertNoCollision` rejects two accounts in the same scope
declaring the same variable name, now at all three tiers. The ambiguity cannot be created, so no
tie-break rule is needed.

**OQ3 is closed by removal plus a rejecting stub (D9).** All nine `github_*` tables are dropped,
and `POST /api/cluster/github/events` returns 410 so an older peer gets a clean refusal instead
of a half-applied write.

**Conversation attachments before a session id exists (D6).** The environment is composed once,
at spawn (C1), and a new conversation has no id then. The picks travel as `secretAccountIds` on
the chat socket, `SecretConversation` carries them as `accountIds` through resolution, and the
server calls `persistConversationSecretAccounts` once the engine reports the id — from
`getSharedSession` for Pi and from `onSessionId` for Claude.

## Deviations from the plan

1. **`ProjectRecord.type` keeps its field name.** The plan's Step 2 enumerates the renames and
   does not list this field; it is the wire field peers exchange in `node-project-sync`, so
   renaming it would break a peer on an older build (NFR7, C6). The database column, the store
   functions, the routes and the UI are all renamed; only this cross-node payload key is left
   alone. `POST /api/projects` therefore still takes `{ type }` rather than `{ workspaceId }`.

2. **Replication lives in `src/secret-replication.ts`, not inside `secrets.ts`.** Step 9 does not
   name a file. Keeping it separate holds both modules well inside the repository's file-size
   convention and keeps `secrets.ts` free of the cluster dependency.

3. **No delete/tombstone events in the replication pipeline.** The old GitHub pipeline carried
   them because groups were a synced entity. FR7 does not require delete propagation, and FR7.4
   gives the receiving node authority over its local copy, so the pipeline carries upserts only.
   An account switched back to node-local has its queued events removed (`refreshOutbox`), which
   is what FR7.2 actually needs.

4. **Two new test files set `JOINT_BOB_SECRET_KEY`.** `src/secrets.js` is reached through bare
   imports from `secrets-migration.js` and `secret-replication.js`, so every test in one file
   shares a single instance of it, pinned to the first test's data dir. A configured key keeps
   the fixture and that instance in agreement. This is an ESM module-identity artifact of the
   test harness, not a production concern: a running node has exactly one data dir.

## Test coverage

| File | Tests | Covers |
|---|---|---|
| `test/workspace-schema.test.ts` | 3 | FR1.2, FR1.3, FR3.1 |
| `test/secrets-migration.test.ts` | 3 | FR6.1–FR6.8, NFR5 |
| `test/secrets.test.ts` | 7 | FR3.3, FR4.1–FR4.4, FR5.1–FR5.5, FR8.1–FR8.5, FR9.4, NFR4 |
| `test/secret-replication.test.ts` | 4 | FR7.1–FR7.5, NFR3, NFR7 |
| `test/secrets-api.test.ts` | 1 | FR3.1, FR9.7, NFR2 |
| `test/secrets-ui.test.ts` | 8 (3 new) | FR2.2, FR9.1–FR9.4, FR9.6, FR7.1 |
| `test/workspaces.test.ts`, `test/workspace-api.test.ts` | 2 | FR1.1, FR1.4, FR1.5 |

## Test suite

- **Baseline** (`npm test`, before any change): **450 tests, 450 pass, 0 fail**.
- **After** (`npm test`): **446 tests, 446 pass, 0 fail**.
- `npx tsc --noEmit`: clean. `npm run build`: clean. The repository configures no linter.

The count falls because the four test files listed under *Files deleted* covered the GitHub
credential group model, which no longer exists — roughly 19 tests removed against 15 added.
NFR6 is read as "zero new failures": every test describing behaviour that survives the change
still passes, and the deleted ones describe a feature FR2.1 required be removed in full. Six
further tests were updated in place because they assert on renamed symbols, ids or routes
(`audit`, `project-store`, `ticket-workspaces`, `settings-tabs-ui`, `project-grouping-ui`,
`project-row-menu`, `project-auto-mapping-ui`), and one test in `startup-readiness` covering the
legacy `github-auth.json` file migration was removed with the code path it exercised.
