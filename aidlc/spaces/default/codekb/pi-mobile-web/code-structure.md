# Code Structure

## Repository Layout

Single-package repository. No workspaces, no monorepo tooling, no `packages/` directory.

```
pi-mobile-web/
├── src/                          32 TypeScript modules, 11,976 lines — the server
├── public/                       PWA client, served verbatim by express.static
├── test/                         115 flat *.test.ts files, 12,565 lines
├── bin/joint-bob.mjs             installer CLI, the package `bin` entry
├── scripts/                      14 shell scripts + install-claude-hooks.mjs + hooks/pre-push
├── deploy/                       Terraform EC2 smoke test, systemd unit, launchd plist
├── .github/workflows/release.yml the only CI workflow
├── package.json  package-lock.json  npm-shrinkwrap.json  tsconfig.json  Justfile
├── README.md  AGENTS.md  CLAUDE.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  LICENSE
└── app.js  index.html  server.ts  styles.css  sw.js    ← gitignored stale duplicates, see below
```

`tsconfig.json` sets `include: ["src/**/*.ts"]` only — `test/` and `public/` are outside the compiled program. Tests run through `tsx` at execution time rather than being compiled; `public/` is never processed at all.

## Module Organization — `src/`

The 32 modules stratify into five bands. There is no enforced layering (no lint rule, no import boundary tool); the bands below are the shape the imports actually take.

### Composition root

| File | Role |
|---|---|
| `src/server.ts` | 4,712 lines / 235 KB. Express app, `WebSocketServer({ server, path: "/ws" })`, 105 explicit `app.<verb>()` handlers plus 2 registered in a loop, 5 `app.use` mounts, ~160 top-level functions, six background reconcilers. Imports ~25 of the 32 sibling modules. |
| `src/app.ts` | One-line re-export of `{ app, createApp }`. Exists so tests can import the app without starting the listener. |

### Engine layer

| File | Role |
|---|---|
| `src/harnesses.ts` | Adapter registry unifying Pi and Claude session listing/loading. Imports `pi-service`, `claude-service`, `names`. |
| `src/claude-service.ts` | Drives the `claude` CLI; `listClaudeSessions` (line 177), `loadClaudeMessages`, `claudeProjectsRoot()` honouring `settings.claude.sessionPath` / `configPath`. Imports `session-paths.ts`. |
| `src/claude-runtime.ts` | Ingests Claude hook events and records running/stopped state in SQLite. |
| `src/pi-service.ts` | Pi agent SDK session lifecycle, model handling, message simplification. |
| `src/session-paths.ts` | Path derivation for both engines plus Syncthing conflict recovery for Pi. `resolveLocalSessionPath` (line 17), `claudeProjectDir`, `claudeProjectDirs` (line 49), `recoveryDiagnostic`. |
| `src/watcher.ts` | Watches transcript directories; `sessionWatchDirs` (line 33) calls `claudeProjectDirs(project)` with no root argument. |
| `src/update-recovery.ts` | Persists in-flight runs so a service restart can resume them. |

### Cluster layer

| File | Role |
|---|---|
| `src/cluster.ts` | Node identity, peer pairing, machine tokens, membership snapshots and tombstones. |
| `src/replication.ts` | Event outbox/inbox for cluster-wide state replication. |
| `src/conversation-ownership.ts` | The `(engine, sessionId)` single-writer state machine. Mutually imports `replication.ts`. |

### Domain layer

| File | Role |
|---|---|
| `src/store.ts` | Projects, project types, aliases, imports. |
| `src/tasks.ts` | 575 lines. Kanban tasks, leases, cross-node handoff. Imports `cluster`, `replication`, `worktrees`, `task-workspaces`, `audit`, `session-paths`. |
| `src/worktrees.ts` | Git worktree tasks — documented in `README.md` as the legacy handoff path. |
| `src/task-workspaces.ts` | Syncthing ticket workspaces — the current handoff path. |
| `src/conversation-reviews.ts` | Per-user review watermarks and the review inbox. |
| `src/project-locks.ts` | Project locking. |
| `src/project-directory-import.ts` | Importing directories discovered on peer nodes. |

### Platform layer

`src/auth.ts`, `src/audit.ts`, `src/secrets.ts`, `src/github-auth.ts`, `src/push.ts`, `src/settings.ts`, `src/preferences.ts`, `src/names.ts`, `src/syncthing.ts`, `src/managed-home.ts`, `src/terminal-session.ts`, `src/websocket.ts`, `src/types.ts`.

`src/types.ts` holds the shared type surface, including `ConversationEngine = "pi" | "claude"` referenced across the ownership and harness layers.

## Client Organization — `public/`

Four ES modules plus static assets, all served verbatim. No bundler, no transpiler, no framework, no `package.json` of their own.

| File | Size / shape | Role |
|---|---|---|
| `public/app.js` | 4,776 lines, 226 functions | The whole application shell: chat, projects, sessions, settings. One mutable `state` object with ~60 keys; elements cached by direct `document.querySelector`. |
| `public/board.js` | module | Kanban board UI. |
| `public/markdown.js` | module | Dependency-free, XSS-safe Markdown renderer. |
| `public/boot.js` | module | Startup bootstrap. |
| `public/sw.js` | service worker | Manually pinned `CACHE_NAME`, currently `joint-bob-v52`. |
| `public/index.html` | 39 KB | Element and `<dialog>` id map that `app.js` binds against. |
| `public/styles.css` | 1,585 lines | All styling. |
| `public/manifest.webmanifest` | | PWA manifest. |

### Client code patterns

- **Single global state object.** `state` in `app.js` carries `state.engine`, `state.activeTaskId` and ~58 other keys; render functions read it directly rather than receiving props.
- **Direct element caching.** An `elements` map populated by `document.querySelector`, e.g. `elements.sessionTakeOwnershipButton`.
- **Native `<dialog>`.** Transfer and ownership flows are `<dialog>` elements opened from `openSessionTransferDialog` and the ownership-dialog wiring at `public/app.js:4438`-`4445`.
- **Feature gating by engine, inline at each call site.** Three separate places gate on `state.engine === "pi"`; see the table under *Intent-area code map* below.

## Server Code Patterns

- **Route handler → module function.** Handlers in `server.ts` validate with zod, then call an exported function from a sibling module. There is no service/controller split and no dependency injection.
- **Every module opens its own database.** Each persistence module independently calls `new DatabaseSync("~/.joint-bob/node.db")` and runs its own `CREATE TABLE IF NOT EXISTS` at load. No shared handle, no schema owner, no version table.
- **Untyped SQLite rows bridged by assertion.** 99 `as unknown as` casts sit at the `node:sqlite` boundary — `tasks.ts` (35), `cluster.ts` (14), `store.ts` (12), `github-auth.ts` (9).
- **Peer calls are plain `fetch` with an explicit timeout.** `AbortSignal.timeout` with per-operation budgets: 3s ownership probe, 30s receive, 35s routed transfer/takeover, 10s inventory. Header `Authorization: Bearer <machine token>`.
- **One terminal error handler.** A single `app.use((error, ...))` at the end of the middleware chain; domain errors are thrown as typed errors such as `TaskWorktreeError` and translated there.
- **Path-escape guards at every filesystem boundary.** `resolveClaudeSessionPath`, `requirePathInsideHome`, `mappedPathInsideHome`, `managedFolderName`.
- **Engine dispatch by path prefix.** `pi:` / `claude:` prefixes on session path strings; `transferLocalSession` (`src/server.ts:2445`) derives the engine from the prefix rather than from a parameter.
- **Test hooks compiled into production.** `src/server.ts:2691` (`JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE`), `:3886` (`JOINT_BOB_TEST_ENGINE_HOLD_DIR`), `:3901` (`JOINT_BOB_TEST_ENGINE_LOG`), each guarded by `NODE_ENV === "test"`.

## File Classification

| Class | Location | Count / size |
|---|---|---|
| Production server source | `src/*.ts` | 32 files, 11,976 lines |
| Production client source | `public/*.js`, `public/index.html`, `public/styles.css` | 5 JS modules + shell |
| Tests | `test/*.test.ts` | 115 files, 12,565 lines |
| Build/config | `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `tsconfig.json`, `Justfile` | 5 |
| CI | `.github/workflows/release.yml` | 1, tag-triggered only |
| Install / ops | `bin/joint-bob.mjs`, `scripts/*.sh`, `scripts/install-claude-hooks.mjs`, `scripts/hooks/pre-push` | 17 |
| Infrastructure | `deploy/aws-ec2-test/*.tf`, `deploy/joint-bob.service`, `deploy/com.joint-bob.node.plist` | 6+ |
| Documentation | `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE` | 7 |
| **Stale duplicates — do not edit** | `app.js`, `index.html`, `server.ts`, `styles.css`, `sw.js` at repo root | 5, gitignored, untracked |

The root-level duplicates are excluded by `.gitignore` lines 18-22 and are stale copies from an older layout — root `server.ts` is 141 KB against `src/server.ts`'s 235 KB, root `app.js` 129 KB, root `index.html` 39 KB, root `styles.css` 49 KB. They will match a naive grep or file-open and are the single most likely way to edit the wrong file in this repository.

## Intent-Area Code Map

Everything the `260830-claude-session-transfer` intent touches, with exact locations:

| Concern | Location | Current behaviour |
|---|---|---|
| Session row menu gate | `public/app.js:2172-2174` | "Continue on another node" entry, `disabled: isClaude`, title `"Claude transfer is not available yet"` |
| Toolbar transfer gate | `public/app.js:2844-2846`, `:2863-2864`, `:4104` | `transferable` requires `state.engine === "pi"`; tooltip and `openSessionTransferDialog` both emit `"Claude conversation transfer is not available yet"` and return early |
| Take-ownership button gate | `public/app.js:4438` | `elements.sessionTakeOwnershipButton.hidden = Boolean(state.activeTaskId \|\| state.engine !== "pi")` |
| Server takeover guard | `src/server.ts:2469` `takeLocalSessionOwnership` | throws `TaskWorktreeError("Only Pi conversations can be taken over")`; also hardcodes `"pi"` in the subsequent `conversationIsActive(project.id, "pi", …)` and `takeConversationOwnership("pi", …)` calls |
| Transfer path | `src/server.ts:2445` `transferLocalSession` | already engine-agnostic — derives engine from the path prefix |
| Receive endpoint | `src/server.ts:2668` `POST /api/cluster/sessions/receive` | already branches on `payload.engine`: `createPiSession` for Pi, `loadClaudeMessages` for Claude |
| Ownership state machine | `src/conversation-ownership.ts` | already engine-agnostic; `CHECK(engine IN ('pi', 'claude'))` |
| Path re-rooting gap | `src/session-paths.ts:17` `resolveLocalSessionPath` | re-roots the whole suffix including the sender-encoded project directory name |
| Correct-directory helper | `src/session-paths.ts:49` `claudeProjectDirs` | already computes the locally-correct directory set; returns **multiple** candidates |
| Pinning test | `test/session-paths.test.ts` | asserts `claude:/Users/a/.claude/projects/project/session.jsonl` maps to `claude:/home/b/.claude/projects/project/session.jsonl` — pins the current path-trusting behaviour and must be updated by any fix |
| Separate, unrelated limitation | `src/server.ts:2700` `POST /api/projects/:projectId/sessions/recover` | throws `"Only Pi transcripts support conflict recovery"` — not one of the three transfer gates |

## Naming and Style Conventions

There is no linter and no formatter configured — no ESLint, Prettier, Biome or `.editorconfig`. The only enforced gate is `tsc` in `strict` mode, and the codebase carries zero `@ts-ignore`, `@ts-expect-error` or `eslint-disable` directives in `src/` or `public/`.

Observed conventions, held by convention rather than tooling:

- `camelCase` for functions and variables, `PascalCase` for types and classes, `SCREAMING_SNAKE_CASE` for module constants (`CLAUDE_ENGINE_SYNC_FOLDER_ID`, `CACHE_NAME`, `CLAUDE_LIST_CONCURRENCY`).
- Environment variables prefixed `JOINT_BOB_*`, with legacy `PI_WEB_DATA_DIR` and `PI_MOBILE_WEB_NAMES_PATH` fallbacks still live in 18 modules.
- One module per domain concept, named for the concept (`conversation-ownership.ts`, `session-paths.ts`), kebab-case filenames.
- Comments are sparse but load-bearing where present: the `newestEventTime` note about Syncthing rewriting mtime, the `CLAUDE_LIST_CONCURRENCY` note about a 1 GB memory peak on a 340-file project, and the `adoptSessionId` note about orphaned runs.
