# Code Structure — Joint Bob

## Repository shape

Single npm package. **No monorepo, no workspaces, no sub-packages.** 677 tracked files in total,
233 of them outside `.claude/` and `aidlc/`. Product source is roughly **22,300 lines** across
`src/` and `public/`, excluding vendored xterm.js.

```
joint-bob/
  src/            36 TypeScript modules  — the server
  public/         PWA client, served verbatim, no build step
  test/           140 flat *.test.ts files, no subdirectories
  scripts/        17 shell/mjs files — install, service, deploy, gates
  bin/            joint-bob.mjs — the npm-installed CLI entry point
  deploy/         systemd unit, launch agent plist, aws-ec2-test Terraform
  .github/        one workflow: release.yml
  .claude/        AI-DLC framework harness — tooling, not product code
  aidlc/          AI-DLC workspace records — tooling, not product code
  aidlc.archive/  a superseded AI-DLC workspace, still git-tracked
```

`package.json` `files` — what actually ships in the tarball: `bin`, `deploy`, `public`, `scripts`,
`src`, `CHANGELOG.md`, `LICENSE`, `README.md`, `SECURITY.md`, `.joint-bob-release`,
`npm-shrinkwrap.json`, `tsconfig.json`.

## `src/` — full inventory with line counts

```
    1  src/app.ts
    9  src/websocket.ts
   52  src/changelog.ts
   63  src/managed-home.ts
   66  src/terminal-session.ts
   73  src/update-recovery.ts
   74  src/claude-runtime.ts
   82  src/task-workspaces.ts
   89  src/skills.ts
   91  src/audit.ts
   92  src/project-locks.ts
  122  src/commands.ts
  122  src/harnesses.ts
  137  src/watcher.ts
  149  src/project-directory-import.ts
  151  src/types.ts
  183  src/replication.ts
  196  src/names.ts
  206  src/conversation-reviews.ts
  214  src/session-paths.ts
  224  src/preferences.ts
  224  src/settings.ts
  226  src/worktrees.ts
  258  src/secrets.ts
  272  src/conversation-ownership.ts
  277  src/auth.ts
  283  src/push.ts
  343  src/syncthing.ts
  457  src/pi-service.ts
  464  src/claude-service.ts
  555  src/github-auth.ts
  575  src/tasks.ts
  592  src/cluster.ts
  700  src/store.ts
 4972  src/server.ts
```

`src/app.ts` is **1 line** and `src/websocket.ts` is **9 lines** — vestigial modules that suggest an
abandoned decomposition attempt.

## Functional groupings

These are plain directories-worth of files, not package boundaries. Nothing enforces them.

| Group | Files | Lines | Purpose |
|---|---|---|---|
| HTTP/WS surface | `src/server.ts` | 4,972 | Every Express route, the WebSocket server, agent process orchestration, peer fan-out |
| Persistence | `store.ts`, `secrets.ts`, `github-auth.ts`, `names.ts`, `settings.ts`, `preferences.ts`, `auth.ts`, `audit.ts`, `push.ts`, `tasks.ts`, `project-locks.ts`, `conversation-reviews.ts`, `update-recovery.ts`, `claude-runtime.ts` | ~2,900 | Each opens its own handle to the shared `~/.joint-bob/node.db` |
| Cluster | `cluster.ts`, `replication.ts`, `conversation-ownership.ts`, `syncthing.ts` | 1,390 | Node identity, peer pairing, event outbox/inbox, ownership fencing, Syncthing control |
| Agent adapters | `pi-service.ts`, `claude-service.ts`, `harnesses.ts`, `commands.ts`, `skills.ts`, `session-paths.ts`, `watcher.ts`, `terminal-session.ts` | 1,631 | Spawning, listing, and reading agent sessions |
| Git / workspace | `worktrees.ts`, `task-workspaces.ts`, `project-directory-import.ts`, `managed-home.ts` | 520 | Worktrees, ticket workspaces, managed-home layout, directory import and relocation |
| Client | `public/app.js`, `index.html`, `styles.css`, `board.js`, `markdown.js`, `composer-commands.js`, `sw.js`, `boot.js` | 9,415 | No build step, no framework, no bundler |
| Install / deploy | `bin/joint-bob.mjs`, `scripts/*` (17), `deploy/joint-bob.service`, `deploy/com.joint-bob.node.plist`, `deploy/aws-ec2-test/*.tf` | ~1,000 | Installer, native service units, EC2 smoke-test Terraform |

## `public/` — the client

| File | Lines | Role |
|---|---|---|
| `public/app.js` | 5,854 (260,694 bytes) | The entire application: element handles, loaders, renderers, dialog handlers, WebSocket client |
| `public/index.html` | 944 (65,393 bytes) | The full DOM including every `<dialog>` |
| `public/styles.css` | 1,794 | All styling |
| `public/board.js` | 303 | Kanban board |
| `public/markdown.js` | 439 | Markdown rendering |
| `public/composer-commands.js` | 32 | Slash-command composer |
| `public/sw.js` | 47 | Service worker — `CACHE_NAME` must be bumped when the shell or icons change, per `AGENTS.md` |
| `public/boot.js` | 6 | Boot shim |
| `public/vendor/xterm/` | — | Vendored third-party, minified: `xterm.js`, `addon-fit.js` (one line each), `xterm.css` (285 lines) |

**`public/` is not typechecked.** `tsconfig.json` has `include: ["src/**/*.ts"]`.

## File classification

| Class | Where | Count / note |
|---|---|---|
| Route + orchestration | `src/server.ts` | 1 file, 109 route registrations, 8 middleware registrations |
| Domain module with its own DB handle | 17 files | `audit.ts`, `auth.ts`, `claude-runtime.ts`, `cluster.ts`, `conversation-ownership.ts`, `conversation-reviews.ts`, `github-auth.ts`, `names.ts`, `preferences.ts`, `project-locks.ts`, `push.ts`, `replication.ts`, `secrets.ts`, `settings.ts`, `store.ts`, `tasks.ts`, `update-recovery.ts` |
| Pure type declarations | `src/types.ts` | 151 lines — `ProjectType`, `ProjectTypeRecord`, `ProjectRecord`, `SessionSummary`, `PROJECT_COLORS`, `TaskRecord` |
| Subprocess adapters | `pi-service.ts`, `claude-service.ts`, `terminal-session.ts`, `worktrees.ts` | spawn agents, PTYs, and `git` |
| Filesystem helpers | `managed-home.ts`, `session-paths.ts`, `task-workspaces.ts`, `project-directory-import.ts`, `watcher.ts` | |
| Client modules | `public/*.js` | plain ES modules, no bundler |
| Tests | `test/*.test.ts` | 140 files, flat, no fixtures or shared setup |
| Shell tooling | `scripts/*.sh`, `scripts/*.mjs` | 17 files |
| Infrastructure | `deploy/aws-ec2-test/*.tf` | 4 files, 194 lines, plus `tests/security.tftest.hcl` (30 lines) |

## Code patterns and conventions

There is **no linter and no formatter** anywhere in the repo — no `.eslintrc*`, `eslint.config.*`,
`.prettierrc*`, `biome.json`, `.editorconfig`, or `husky` directory. Despite that, style is
strikingly consistent and clearly enforced by convention:

- 2-space indent, double quotes, semicolons
- **Named exports only** — no default exports anywhere
- ESM throughout (`"type": "module"`), with `.js` extensions on relative imports
- `async function` declarations rather than arrow assignments
- `interface` for object shapes
- Explicit return types on exported functions
- `data-testid` on every interactive client element
- `/** … */` JSDoc used sparingly and only where the *why* is non-obvious

### Persistence idiom

Every DB-owning module follows the same shape:

1. Resolve `dataDir` from `JOINT_BOB_DATA_DIR ?? PI_WEB_DATA_DIR ?? ~/.joint-bob`.
2. Keep a module-level `database: DatabaseSync | null` and, in `store.ts`, a shared
   `databaseInitialization: Promise<DatabaseSync> | null` so concurrent first callers cannot build
   rival handles (`store.ts:46-47`, `:337`).
3. On first use, `fs.mkdir(dataDir, { recursive: true, mode: 0o700 })`, open the file, set
   `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`, then `CREATE TABLE IF NOT EXISTS ...`.
4. Add missing columns lazily via `tableHasColumn(...)` then `ALTER TABLE ... ADD COLUMN`.
5. Wrap every multi-statement mutation in `BEGIN IMMEDIATE`.

Because creation order depends on which module is imported first, cross-module joins must guard:
`secrets.ts:115` uses `hasTable("project_types")` / `hasTable("projects")` before joining.

### Transaction idiom

Credential and ownership mutations follow: `BEGIN IMMEDIATE` → mutate → enqueue a replication or
credential event → append an audit event → `COMMIT`. `conversation-ownership.ts:110`
(`ownershipTransaction`) formalises this: `BEGIN IMMEDIATE` → compute → `saveOwnership` →
`publishOwnership` → `COMMIT` → structured diagnostic.

### Encryption idiom

The same ~30-line block — `key()`, `encrypt()`, `decrypt()` over AES-256-GCM with a 12-byte random
IV serialised as `` `${iv}.${authTag}.${body}` `` in base64 — appears **verbatim** at
`secrets.ts:31-63` and `github-auth.ts:40-72`, with further near-copies in `cluster.ts` and
`push.ts`. All four read the same `<dataDir>/secret.key`.

### Conflict-resolution idiom

One rule, three syntaxes:

- `store.ts:146` — `compareVersion(left, right)`: compare `updated_at`, tie-break
  `origin_node_id.localeCompare`
- `github-auth.ts:228` — an identical `compareVersion`
- `replication.ts:100`, `:118`, `:141`, `:145` — an inline string comparison of
  `` `${updatedAt}\n${originNodeId}` ``

### Alias-resolution idiom

Three implementations of the same helper: `store.ts:120` (`resolveProjectId`),
`github-auth.ts:237` (`resolveProjectAlias`), `replication.ts:83` (`resolveProjectAlias`).

### Client idiom

- Plain DOM: `document.querySelector`, `document.createElement`, `element.replaceChildren()`
- Native `<dialog>` with `showModal()` / `close()` for every modal
- Module-level caches — `githubGroups`, `projectTypes`, `secretAccounts` — each refreshed by a full
  reload after every mutation. **There is no shared state container.**
- Data flow: `loadX()` → module-level array → `renderX()` plus any picker that consumes it

### Test idioms

Three distinct kinds, with very different value:

1. **Backend integration tests** — the pattern to follow. `test/secrets.test.ts:8-16` creates a
   temp dir, points `PI_WEB_DATA_DIR` at it, **hand-builds the schema the module under test
   expects** (because there is no central schema owner), then **dynamically re-imports the module
   with a cache-busting query string** so it builds a fresh `DatabaseSync` handle. Cleanup restores
   the env var and removes the dir in a `finally`.
2. **`*-ui.test.ts` string assertions** — roughly 40 of the 140 files read `public/index.html`,
   `public/app.js`, `public/styles.css`, and `public/sw.js` as **strings** and assert with
   `assert.match` / `assert.ok(app.includes(testid))`. Nothing is rendered and no DOM exists.
3. **Migration tests** — the model for a schema change.
   `test/project-type-migration.test.ts` reconstructs the **exact `CREATE TABLE` the previous build
   shipped**, including the dropped `CHECK (project_type IN ('personal', 'work'))` constraint and
   the foreign keys on `project_locations` and `project_aliases`, inserts a legacy row, then asserts
   the upgrade path preserves it.

## Naming conventions observed

- Modules: kebab-case filenames, one domain concept each (`github-auth.ts`, `conversation-ownership.ts`)
- SQL: snake_case tables and columns; tombstone tables are `<entity>_tombstones`; delivery tracking
  is `<pipeline>_deliveries`; marker tables are `<domain>_migrations`
- TypeScript: `camelCase` functions and variables, `PascalCase` types and interfaces
- Client `data-testid`: kebab-case, `<context>-<element>-<role>` — e.g. `secret-account-add-button`,
  `project-type-secrets-button`, `github-group-delete-button`
- Env vars: `JOINT_BOB_*` current, `PI_WEB_*` / `PI_MOBILE_WEB_*` legacy fallbacks still honoured

## Legacy naming still in the tree

The product was renamed; several traces remain and matter when grepping:

- `PI_WEB_DATA_DIR`, `PI_MOBILE_WEB_GITHUB_AUTH_PATH`, `PI_MOBILE_WEB_NAMES_PATH`, `MASTER_BOB_SECRET_KEY`
  are still accepted as fallbacks
- `.pi-mobile-web/` and `.pi-mobile-web-attachments/` directories
- Gitignored root-level stale duplicates `app.js` (129 KB), `index.html` (39 KB), `server.ts`
  (141 KB), `styles.css` (49 KB), `sw.js` — pre-rename copies, ignored at `.gitignore:18-22`.
  **Grep and IDE search hit these first**, which is a real hazard when navigating this repo.
- In `github-auth.ts`, the *group* concept is stored in a table called `github_accounts` whose
  primary key column is `account`, and `github_project_auth.account` holds a **group id** (or `''`),
  not a GitHub username.
