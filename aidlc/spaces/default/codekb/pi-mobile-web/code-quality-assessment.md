# Code Quality Assessment

## Summary

| Dimension | Verdict |
|---|---|
| Type safety | **Strong at the source level, weak at the SQLite boundary.** `strict: true`, zero suppression directives anywhere in `src/` or `public/`, offset by 99 `as unknown as` casts where `node:sqlite` returns untyped rows |
| Linting | **Absent.** No ESLint, Prettier, Biome or `.editorconfig` |
| Tests | **Substantial and genuinely integrative.** 115 files, 12,565 lines — larger than `src/`. API tests boot real servers; the ownership mesh test runs two real nodes |
| Coverage measurement | **Absent.** No `c8`, `nyc`, `--experimental-test-coverage`, and no threshold in `package.json` or CI |
| CI | **Release-only.** One workflow, triggered on `v*` tags. Nothing runs on push or on a pull request |
| Documentation | **Good at the repository level, thin at the symbol level.** Seven top-level docs; sparse but high-value inline comments; no JSDoc on most exports |
| Security posture | **Deliberate and layered.** Three auth classes, `timingSafeEqual`, scrypt, AES at rest, path-escape guards at every filesystem boundary, an audit log, and Terraform security tests |
| Structural health | **The weakest dimension.** Two files carry most of the system: `src/server.ts` at 4,712 lines and `public/app.js` at 4,776 |

## Type Safety

`tsconfig.json` sets `strict: true` with `target: ES2022` and `NodeNext` module resolution. The codebase contains **zero** `@ts-ignore`, `@ts-expect-error` or `eslint-disable` comments in `src/` or `public/` — the type gate is not being worked around.

It is, however, being bypassed at exactly one boundary. `node:sqlite` returns untyped rows, and the codebase bridges that with **99 `as unknown as` casts**, concentrated in:

| Module | Casts |
|---|---|
| `src/tasks.ts` | 35 |
| `src/cluster.ts` | 14 |
| `src/store.ts` | 12 |
| `src/github-auth.ts` | 9 |
| remainder | 29 |

`strict` offers no protection there: a schema change that renames a column type-checks cleanly and fails at runtime.

## Linting and Formatting

None configured. `tsc --noEmit` is the only automated code check that exists. Style consistency across the repository is therefore held by convention alone — and it does hold well, which is worth recording: naming, module layout and error handling are uniform across all 32 server modules.

## Test Suite

- **Location:** `test/`, flat, 115 `*.test.ts` files, 12,565 lines.
- **Runner:** Node's built-in `node:test` with `node:assert/strict`, executed as `node --import tsx --test test/*.test.ts`.
- **No Jest, Vitest, Mocha or Playwright.** UI tests are DOM-level assertions against `public/*.js` and `public/index.html`; API tests boot real servers.
- **`test/conversation-ownership-mesh-api.test.ts` spins up two real nodes** and exercises transfer across a dropped acknowledgement and across a restart — the strongest test in the repository and the one that most directly protects the active intent's blast radius.

Tests covering the intent area: `session-paths.test.ts`, `conversation-ownership.test.ts`, `conversation-ownership-mesh-api.test.ts`, `conversation-lock-mesh-api.test.ts`, `conversation-lock-ui.test.ts`, `claude-sync-conflict.test.ts`, `claude-session-reattach.test.ts`, `claude-session-cache.test.ts`, `claude-transcript-recency.test.ts`, `claude-runtime.test.ts`, `claude-hook-installer.test.ts`, `claude-default-model.test.ts`, `session-watcher.test.ts`, `session-deletion-security.test.ts`, `session-safeguards.test.ts`, `replication.test.ts`, `replication-mesh-api.test.ts`, `update-session-recovery.test.ts`.

**One test will need to change.** `test/session-paths.test.ts` pins the current path-trusting behaviour of `resolveLocalSessionPath` for Claude: it asserts that `claude:/Users/a/.claude/projects/project/session.jsonl` maps to `claude:/home/b/.claude/projects/project/session.jsonl`, preserving the sender's encoded project directory name verbatim. Any fix that re-derives the directory locally must update this assertion.

## CI/CD

One workflow: `.github/workflows/release.yml`, triggered **only** on `v*` tags. Its stages:

`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npm pack` + tarball smoke test (verifies `bin/joint-bob.mjs` is present in the tarball and that the embedded `.joint-bob-release` commit matches `GITHUB_SHA`) → SHA-256 → GitHub release → `npm publish --provenance`.

**There is no PR or push CI.** Nothing runs the test suite on `main` or on a branch. The de-facto gate is the local `pre-push` hook at `scripts/hooks/pre-push`, which **does not run tests** — it waits for the remote to confirm the commit, then deploys to installed nodes. A change can therefore reach `main` and, through that hook, reach production nodes without any automated test run.

## Documentation

| File | Content |
|---|---|
| `README.md` | ~7 KB — install, pairing, managed projects, private HTTPS, service management, deployment, EC2 smoke test, security |
| `AGENTS.md` | Agent workflow rules, including mandatory `typecheck` / `test` / `build` before delivery and the PWA `CACHE_NAME` bump rule |
| `CLAUDE.md` | Defers to `AGENTS.md` and `README.md` |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE` | Standard OSS set; MIT licence |

Inline comments are sparse but the ones that exist are load-bearing and worth preserving:

- the `newestEventTime` note recording that Syncthing rewrites mtime — the same fact the project rule from 2026-08-28 encodes;
- the `CLAUDE_LIST_CONCURRENCY` note about a 1 GB memory peak on a 340-file project;
- the `adoptSessionId` note about orphaned runs.

No JSDoc on most exports and no generated API documentation.

## Security Posture

Actively maintained, and stronger than the absence of a linter would suggest:

- `securityHeaders` middleware and CSRF middleware.
- Machine tokens compared with `timingSafeEqual`; passwords hashed with scrypt; secrets, GitHub tokens and push keys AES-encrypted at rest.
- State directory `0o700`, files `0o600`.
- Path-escape guards at every filesystem boundary: `resolveClaudeSessionPath`, `requirePathInsideHome`, `mappedPathInsideHome`, `managedFolderName`.
- Symlink and regular-file checks before session deletion; `test/session-deletion-security.test.ts` covers it.
- Append-only audit log (`src/audit.ts`).
- `deploy/aws-ec2-test/tests/security.tftest.hcl` asserts the smoke-test instance's security properties under `terraform test`.

**Security implication for the active intent.** The receive path's `access(localPath, R_OK)` is a readability check, not an authorisation check; it passes for Claude only because Syncthing mirrors `~/.claude` wholesale. The invariant that actually constrains what can be read is `loadClaudeMessages`'s check that the resolved path sits inside `claudeProjectsRoot()`. Any change to Claude path resolution must preserve that check rather than replace it — otherwise `POST /api/cluster/sessions/receive` becomes an arbitrary-file-read primitive reachable with a machine token.

## Technical Debt Register

Thirteen signals, carried verbatim from the code scan with locations.

### 1. `src/server.ts` is a 4,712-line / 235 KB composition root

~160 top-level functions and 105 routes in one file, spanning routing, ownership coordination, Claude subprocess orchestration, Pi session sharing, task handoff, file proxying, WebSocket proxying, update recovery and six background reconcilers. **The largest structural risk in the repository**; every intent-area change touches it.

*Suggested first cut:* extract the ownership/transfer region (lines 2370-2760) — it is cohesive, it is the intent-area surface, and it would give the transfer state machine a testable home outside the route table.

### 2. Gitignored root-level stale duplicates

`app.js` (129 KB), `index.html` (39 KB), `server.ts` (141 KB), `styles.css` (49 KB) and `sw.js` sit at the repository root, excluded by `.gitignore` lines 18-22 and untracked. They are stale copies from an older layout — root `server.ts` is 141 KB against `src/server.ts`'s 235 KB. **An active trap for greps, editors and agents**, and the most likely way to edit the wrong file in this repository.

### 3. No linter and no PR/push CI

Tests run only on `v*` tag release. A change can reach `main` — and via the `pre-push` hook reach installed production nodes — with no automated test run.

### 4. No coverage measurement

115 test files and no coverage floor. No `c8`, `nyc`, or `--experimental-test-coverage`; no threshold in `package.json` or CI.

### 5. Test-only branches compiled into production code

Three, all guarded by `NODE_ENV === "test"` but shipped:

| Location | Variable | Effect |
|---|---|---|
| `src/server.ts:2691` | `JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE` | destroys the socket mid-receive |
| `src/server.ts:3886` | `JOINT_BOB_TEST_ENGINE_HOLD_DIR` | holds the engine |
| `src/server.ts:3901` | `JOINT_BOB_TEST_ENGINE_LOG` | engine logging |

The first sits **inside the transfer-receive handler** — the exact code path the active intent extends.

### 6. Incomplete rebrand

`PI_WEB_DATA_DIR` fallbacks in 18 modules; `PI_MOBILE_WEB_NAMES_PATH` in `src/names.ts`; `.pi-mobile-web/` ignore rules in `src/syncthing.ts` and `src/task-workspaces.ts`; the repository directory is still `pi-mobile-web` while the package is `joint-bob`. `test/rebrand-audit.test.ts` fences it partially.

### 7. Schema management by hand

No migration framework. `CREATE TABLE IF NOT EXISTS` plus bespoke `RENAME TO …_old` / re-insert / `DROP` sequences — `ensureConversationOwnershipSchema` is the worked example. Every module independently opens the same database and ensures its own schema. **No schema owner and no version table**, so there is no way to ask a node which schema generation it is on.

### 8. 99 `as unknown as` casts at the SQLite boundary

`tasks.ts` (35), `cluster.ts` (14), `store.ts` (12), `github-auth.ts` (9), remainder 29. `node:sqlite` returns untyped rows and `strict` mode gives no protection there.

### 9. Duplicated Claude project-directory derivation

`claudeProjectDir` in `src/session-paths.ts` defaults its root to `~/.claude/projects`, while `src/claude-service.ts` has its own `claudeProjectsRoot()` honouring `settings.claude.sessionPath` / `configPath`. `src/watcher.ts` calls `claudeProjectDirs(project)` **without** a root, so a node with a non-default `claude.configPath` watches the wrong directories while `listClaudeSessions` reads the right ones. **Latent today and directly adjacent to the active intent's fix** — any path change should unify the three call sites rather than add a fourth resolution rule.

### 10. Two overlapping task handoff mechanisms

`src/tasks.ts` (575 lines) holds both the Git-bundle/worktree path (`src/worktrees.ts`) and the Syncthing ticket-workspace path (`src/task-workspaces.ts`). `README.md` documents the worktree path as legacy-only, so both must be maintained indefinitely.

### 11. Ownership diagnostics hardcode `localNodeId: "local"`

`recoveryDiagnostic` in `src/session-paths.ts` always emits `localNodeId: "local"`, so the structured log line claims the node is `"local"` regardless of which node produced it — degrading cross-node diagnosis of Pi transcript recovery precisely when a multi-node problem is being investigated.

### 12. `public/app.js` is 4,776 lines / 226 functions in one file

A single mutable `state` object of ~60 keys and direct `document.querySelector` element caching. No build step, no module boundaries beyond `board.js` and `markdown.js`, no framework. The three Claude transfer gates the active intent removes are scattered across it at `:2172-2174`, `:2844-2846` / `:2863-2864` / `:4104`, and `:4438`.

### 13. Service-worker cache name is manually versioned

`AGENTS.md` mandates bumping `CACHE_NAME` in `public/sw.js` on any shell change; nothing enforces it. Worse, **two UI tests pin the current value** (`joint-bob-v52`), so a correct bump breaks unrelated tests — the process rule and the test suite are in direct conflict.

## Risk Ranking for the Active Intent

| Rank | Debt item | Why it matters here |
|---|---|---|
| 1 | #9 duplicated Claude project-directory derivation | The intent's fix lands exactly on top of this; fixing the transfer without unifying the resolver adds a fourth rule |
| 2 | #1 `src/server.ts` size | The takeover guard and the receive handler both live in the 4,712-line file |
| 3 | #12 `public/app.js` size | All three client gates are in it, at three unrelated locations |
| 4 | #5 test branches in production | One of them is inside the receive handler being changed |
| 5 | #13 `CACHE_NAME` conflict | Removing the client gates changes the shell, so the bump rule fires — and breaks two tests |
| 6 | #3 no push CI | The change ships to production nodes via `pre-push` with no automated test run |
| 7 | #2 root-level duplicates | A stale root `server.ts` and `app.js` are the wrong files to edit for this exact intent |
