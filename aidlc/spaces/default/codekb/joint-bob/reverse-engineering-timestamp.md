# Reverse Engineering Run Record — Joint Bob

## Run metadata

| Field | Value |
|---|---|
| Date | 2026-08-30 |
| Repository | `/Users/iliagerman/Work/personal_projects/joint-bob` |
| Repo name in the store | `joint-bob` |
| Branch | `main` |
| Commit (`git rev-parse HEAD`) | `c3e9b0508fba185dbc4ab8bb7ad5fa6debadd5fa` |
| Commit subject | `fix(hooks): find node when the push comes from a bare environment` |
| Commit date | Sun Aug 30 23:15:23 2026 +0300 |
| Product version | `joint-bob` 0.2.0 |
| Stage | `reverse-engineering` (AI-DLC, inception phase) |
| Intent | `260830-scoped-secrets` |
| Scope / depth | `express` — Depth Minimal, Test Strategy Minimal |
| Rerun guard verdict | `NO_STORE` — **this is the first scan for this repo.** Nothing was replaced and no prior coverage was discarded. |
| Pipeline | Link 1 developer code scan, then link 2 architect synthesis |

## What was verified during the run

- `npx tsc --noEmit` → **exit 0, no diagnostics**
- Complete SQLite table inventory taken by grepping every `CREATE TABLE IF NOT EXISTS` across
  `src/*.ts` — **49 tables**
- Every module that opens `~/.joint-bob/node.db` enumerated — **17 modules**
- Every consumer of `agentEnvironment`, `gitHubEnvironment`, `genericSecretEnvironment`,
  `agentCredentialContext`, `GH_TOKEN`, `PI_GITHUB_TOKEN`, and `GIT_ASKPASS` traced across `src/`,
  `public/`, and `test/`
- Every `git` subprocess invocation across `src/` enumerated — **`push` appears nowhere**
- Every WebSocket message type enumerated in both directions
- Lint/format config search (`eslint`, `prettier`, `biome`, `editorconfig`, `husky`) — **none found**
- Migration-machinery search (`schema_version`, `user_version`, `*_migrations`) — no schema version
  exists

## Repository size at scan time

- 677 tracked files in total; 233 outside `.claude/` and `aidlc/`
- ~22,300 lines of product source across `src/` and `public/`, excluding vendored xterm.js
- 36 TypeScript modules in `src/`; 140 `*.test.ts` files in `test/`

## Artifacts written by this run

All nine live in `aidlc/spaces/default/codekb/joint-bob/`:

1. `business-overview.md`
2. `architecture.md`
3. `code-structure.md`
4. `api-documentation.md`
5. `component-inventory.md`
6. `technology-stack.md`
7. `dependencies.md`
8. `code-quality-assessment.md`
9. `reverse-engineering-timestamp.md` (this file)

## Honest limits of this run

The intent this scan feeds is a credential-model rework, so the scan was deliberately deep on the
credential, project-identity, conversation-identity, migration, and replication paths, and shallow
elsewhere.

**Read in full:** `src/types.ts`, `src/store.ts`, `src/secrets.ts`, `src/github-auth.ts`,
`src/conversation-ownership.ts`, `src/replication.ts`, `src/terminal-session.ts`.

**Read in named ranges only:** `src/server.ts` (the complete route table plus roughly 400 lines of
handler bodies out of 4,972), `src/cluster.ts`, `src/names.ts`, `src/claude-service.ts`,
`src/pi-service.ts`, `public/app.js` (roughly 550 lines out of 5,854), `public/index.html` (roughly
250 lines out of 944).

**Skimmed at export/signature granularity only:** the other 23 modules in `src/`, the remaining
~4,300 lines of `src/server.ts` (task orchestration and leases, session transfer/recovery, file
resolution and file editor, board endpoints, Syncthing reconciliation, push wiring, update
recovery), the remaining ~5,300 lines of `public/app.js`, `public/board.js`, `public/markdown.js`,
`public/styles.css`, 137 of the 140 test files (by filename only), 14 of 17 `scripts/` files, and
the `deploy/aws-ec2-test/` Terraform apart from `versions.tf`.

**Excluded as tooling or workspace, not product code:** `.claude/`, `aidlc/`, `aidlc.archive/`,
`node_modules/`, `.git/`, `dist/`, `.pi-mobile-web/`, `.pi-mobile-web-attachments/`,
`public/vendor/xterm/` (bundled minified third-party), and the gitignored root-level stale
duplicates `app.js`, `index.html`, `server.ts`, `styles.css`, `sw.js`.

Where an artifact describes a skimmed area, it says so rather than inventing detail.

## Scope of Analysis

```yaml
scope_version: 1
kind: partial
intent: 260830-scoped-secrets
fingerprint: 30b1dd168f5fd5b0e73924e3db7e1f220ab075f8
analyzed:
  paths:
    - src/types.ts
    - src/store.ts
    - src/secrets.ts
    - src/github-auth.ts
    - src/conversation-ownership.ts
    - src/replication.ts
    - src/terminal-session.ts
    - src/server.ts
    - src/cluster.ts
    - src/names.ts
    - src/claude-service.ts
    - src/pi-service.ts
    - public/app.js
    - public/index.html
    - package.json
    - tsconfig.json
    - Justfile
    - README.md
    - AGENTS.md
    - CLAUDE.md
    - CHANGELOG.md
    - .github/workflows/release.yml
    - scripts/versions.sh
    - deploy/aws-ec2-test/versions.tf
    - test/secrets.test.ts
    - test/secrets-ui.test.ts
    - test/project-type-migration.test.ts
  components:
    - HTTP and WebSocket Surface
    - Project Store
    - Generic Secrets
    - GitHub Credential Groups
    - Cluster Identity and Pairing
    - Generic Replication
    - Conversation Ownership
    - Names and Colours
    - Claude Agent Adapter
    - Pi Agent Adapter
    - Terminal Session
    - Shared Types
    - Web Client
shallow:
  paths:
    - src/tasks.ts
    - src/worktrees.ts
    - src/syncthing.ts
    - src/auth.ts
    - src/settings.ts
    - src/preferences.ts
    - src/push.ts
    - src/watcher.ts
    - src/session-paths.ts
    - src/harnesses.ts
    - src/commands.ts
    - src/skills.ts
    - src/audit.ts
    - src/conversation-reviews.ts
    - src/project-locks.ts
    - src/project-directory-import.ts
    - src/managed-home.ts
    - src/task-workspaces.ts
    - src/update-recovery.ts
    - src/changelog.ts
    - src/claude-runtime.ts
    - src/websocket.ts
    - src/app.ts
    - public/board.js
    - public/markdown.js
    - public/composer-commands.js
    - public/boot.js
    - public/sw.js
    - public/styles.css
    - test/
    - scripts/
    - deploy/
    - bin/
```
