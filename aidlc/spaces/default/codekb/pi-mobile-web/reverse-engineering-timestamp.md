# Reverse-engineering timestamp

## Scan record

- Scan date: `2026-08-25T21:47:10Z`
- Repository: `pi-mobile-web`
- Active intent: `260825-project-node-fixes`
- Commit: `0c64fbecb6954e8b9fa6c1b7311b2a3654681c88`
- Coverage kind: partial
- Fingerprint mint result: `unknown`

The commit hash identifies `HEAD` at scan time. The working tree already contained substantial AI-DLC migration changes and deleted legacy rule files before the scan. Application source and tests were not modified during inspection.

## Verification notes

All 27 TypeScript modules under `src/` and the listed canonical application, operations, configuration, documentation, and selected test files received deep analysis. Remaining tests and large generated, dependency, style, runtime-state, and workflow areas received inventory-level or targeted inspection only. Tests were not executed.

The npm registry returned HTTP 400 during the attempted dependency audit. Vulnerability status is unverified.

## Scope of Analysis

```yaml
scope_version: 1
kind: partial
intent: 260825-project-node-fixes
fingerprint: unknown
analyzed:
  paths:
    - src/
    - public/app.js
    - public/board.js
    - public/markdown.js
    - public/index.html
    - public/boot.js
    - public/sw.js
    - public/manifest.webmanifest
    - public/icon.svg
    - scripts/
    - deploy/
    - .github/workflows/release.yml
    - package.json
    - tsconfig.json
    - Justfile
    - README.md
    - AGENTS.md
    - CONTRIBUTING.md
    - SECURITY.md
    - CODE_OF_CONDUCT.md
    - .gitignore
    - .stignore
    - test/auth-api.test.ts
    - test/chat-session-ux.test.ts
    - test/desktop-conversation-workspace.test.ts
    - test/harness-registry.test.ts
    - test/runtime-settings.test.ts
    - test/session-paths.test.ts
    - test/syncthing.test.ts
    - test/task-routing-api.test.ts
    - test/websocket-auth.test.ts
    - test/websocket-proxy-errors.test.ts
  components:
    - Application composition and transport
    - Account and node state
    - Project domain and persistence
    - Task domain and workspaces
    - Git worktree operations
    - Cluster and replication
    - GitHub credential management
    - Agent adapters
    - Conversation discovery
    - Syncthing adapter
    - Push notifications
    - Filesystem management
    - Skill discovery
    - Browser PWA
    - Kanban board UI
    - Markdown renderer
    - CLI and packaging
    - Deployment and smoke infrastructure
shallow:
  paths:
    - test/
    - public/styles.css
    - public/icon-192.png
    - public/icon-512.png
    - package-lock.json
    - npm-shrinkwrap.json
    - dist/
    - app.js
    - server.ts
    - styles.css
    - sw.js
    - index.html
    - node_modules/
    - .pi-mobile-web/
    - .pi-mobile-web-attachments/
    - .claude/
    - aidlc/
    - aidlc.archive/
    - .aidlc-rule-details/
```
