# Reverse Engineering Timestamp

## Scan Record

- **Scan date:** `2026-08-27T18:52:31Z`
- **Repository:** `pi-mobile-web`
- **Active intent:** `260827-conversation-review-sync`
- **Commit:** `9ab9b04d0d3e23d2bdcfb1bcb8b84b7183b36ce1`
- **Coverage kind:** `partial`

The commit identifies `HEAD` at scan time. The working tree contained unrelated changes before synthesis; they were preserved. Product source, delivery code, configuration, and the active bug areas received deep coverage. Generated dependencies, binary assets, historical workflow records, most test implementations, and selected frontend shell files received shallow coverage.

## Verification Evidence

On `2026-08-27`, the developer scan recorded successful `npm run typecheck`, `npm test` (246 passed, 0 failed, 0 skipped), `npm run build`, `terraform fmt -check -recursive`, `terraform validate`, and `terraform test` (1 run, 0 failed). An explicit public-registry `npm audit --omit=dev` found zero production vulnerabilities; the configured proxy audit endpoint returned HTTP 400.

## Scope of Analysis

```yaml
scope_version: 1
kind: partial
intent: 260827-conversation-review-sync
fingerprint: 16d7b51d9ecb68a4565be3fafa6993b57100c245
analyzed:
  paths:
    - src/
    - public/app.js
    - public/board.js
    - public/markdown.js
    - public/index.html
    - public/sw.js
    - scripts/
    - bin/joint-bob.mjs
    - deploy/
    - .github/workflows/release.yml
    - package.json
    - package-lock.json
    - npm-shrinkwrap.json
    - tsconfig.json
    - README.md
    - AGENTS.md
    - CLAUDE.md
    - CONTRIBUTING.md
    - SECURITY.md
    - Justfile
    - test/conversation-review-api.test.ts
    - test/conversation-status-indicators.test.ts
    - test/claude-session-reattach.test.ts
    - test/streaming-render-performance.test.ts
    - test/chat-session-ux.test.ts
    - test/syncthing.test.ts
    - test/syncthing-handoff-api.test.ts
    - test/startup-readiness.test.ts
    - test/node-project-sync.test.ts
    - test/public-distribution.test.ts
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
    - public/boot.js
    - public/manifest.webmanifest
    - public/icon-192.png
    - public/icon-512.png
    - public/icon.svg
    - dist/
    - node_modules/
    - .claude/
    - aidlc/
    - aidlc.archive/
    - .pi-mobile-web-attachments/
    - app.js
    - server.ts
    - styles.css
    - sw.js
    - .pi-mobile-web/
```