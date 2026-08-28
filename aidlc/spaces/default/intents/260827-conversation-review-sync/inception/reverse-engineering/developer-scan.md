## Developer Code Scan Results

### Scan Coverage
- **Analyzed deeply**:
  - `src/` — all 29 TypeScript modules, including the complete HTTP/WebSocket composition root, persistence, replication, agent adapters, Syncthing integration, task ownership, and filesystem boundaries
  - `public/app.js` — application state, project/session/task flows, review actions, WebSocket event handling, and streamed-message rendering; unrelated presentation helpers were structurally reviewed
  - `public/board.js`
  - `public/markdown.js`
  - `public/index.html`
  - `public/sw.js`
  - `scripts/`
  - `bin/joint-bob.mjs`
  - `deploy/`
  - `.github/workflows/release.yml`
  - `package.json`
  - `package-lock.json` and `npm-shrinkwrap.json` — resolved package metadata and integrity model
  - `tsconfig.json`
  - `README.md`
  - `AGENTS.md`
  - `CLAUDE.md`
  - `CONTRIBUTING.md`
  - `SECURITY.md`
  - `Justfile`
  - `test/conversation-review-api.test.ts`
  - `test/conversation-status-indicators.test.ts`
  - `test/claude-session-reattach.test.ts`
  - `test/streaming-render-performance.test.ts`
  - `test/chat-session-ux.test.ts`
  - `test/syncthing.test.ts`
  - `test/syncthing-handoff-api.test.ts`
  - `test/startup-readiness.test.ts`
  - `test/node-project-sync.test.ts`
  - `test/public-distribution.test.ts`
  - Complete test inventory and full execution of every `test/*.test.ts` file
- **Skimmed only**:
  - Remaining `test/` files — test names, imports, sizes, ownership areas, and full-suite results were analyzed; source was sampled rather than read line by line
  - `public/styles.css` — component/state rules and active working-tree changes were reviewed; all declarations were not audited individually
  - `public/boot.js`, `public/manifest.webmanifest`, and image assets — shell references, cache inclusion, and existence were checked
  - `dist/` — generated JavaScript was not treated as source of truth
  - `node_modules/` — package metadata and Pi event type declarations were inspected; vendored implementation was not fully reviewed
  - `.claude/` — required Reverse Engineering persona, stage, template, shared guidance, configuration shape, and repository inventory were read; the full vendored AI-DLC framework was not audited as product code
  - `aidlc/` — active intent, active-space rules, existing code knowledge base, and intent inventory were reviewed; historical audit/runtime files were not analyzed as application code
  - `aidlc.archive/` — historical artifact inventory only
  - `.pi-mobile-web-attachments/` — attachment names and file types only
  - Root legacy/generated files and ignored runtime directories, including `app.js`, `server.ts`, `styles.css`, `sw.js`, `.pi-mobile-web/`, and local `dist/`, were classified but not used as canonical source

This was a repository-wide rescan. Product source, delivery code, configuration, and active-intent paths received deep coverage. Generated dependencies, historical workflow records, binary assets, and most test implementations received shallow coverage as listed above. Unrelated working-tree changes were left untouched.

### Packages Found
- `joint-bob` — publishable npm package and CLI — TypeScript/JavaScript — private multi-node web workspace for Pi and Claude coding agents
- `src/` server package — backend application — TypeScript ESM — Express APIs, WebSockets, agent processes, SQLite persistence, replication, Syncthing, authentication, and native-service startup
- `public/` PWA — browser client — dependency-free JavaScript/HTML/CSS — responsive project, conversation, board, settings, terminal, and agent-chat UI
- `deploy/aws-ec2-test/` — Terraform root module — HCL — temporary locked-down Ubuntu EC2 smoke environment
- `scripts/` and `deploy/*.service|*.plist` — delivery package — Bash/systemd/launchd — pinned runtime installation, release verification, rollback, deployment, and private HTTPS setup
- No workspace/monorepo package manager configuration and no second `package.json` were found.

### Build System
- **Type**: npm 10 with TypeScript compiler; Node.js native test runner through `tsx`; Terraform CLI for the EC2 smoke module
- **Config Files**: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `tsconfig.json`, `Justfile`, `.github/workflows/release.yml`, `scripts/versions.sh`, `deploy/aws-ec2-test/*.tf`, `deploy/aws-ec2-test/.terraform.lock.hcl`
- **Build Dependencies**:
  - `src/**/*.ts` → `tsc` → ignored/generated `dist/**/*.js`
  - `src/server.ts` → every backend domain module and the `public/` static directory
  - `src/app.ts` → re-export of `src/server.ts` for API tests
  - `public/app.js` → `public/board.js`, `public/markdown.js`, and the server's HTTP/WebSocket contracts
  - `npm start` → build → `dist/server.js`
  - `npm prepack` → build; package allowlist includes `bin`, `deploy`, `public`, `scripts`, `src`, and release/docs/config files
  - `scripts/install-service.sh` → pinned Node/Syncthing setup → `npm ci` → native user service
  - GitHub tag workflow → typecheck → tests → build → package smoke check → signed-provenance npm publish and GitHub release
- TypeScript settings are strict, ESM/NodeNext, ES2022, with `skipLibCheck: true`. Only `src/**/*.ts` is compiled; tests execute directly through `tsx`.

### APIs Discovered
- REST/JSON HTTP — `src/server.ts` — 86 `/api` route registrations across authentication, preferences, audit, settings, cluster membership, replication, GitHub credentials, projects, sessions, reviews, tasks, push, files, skills, and models
- WebSocket — `/ws` in `src/server.ts` — one endpoint with chat, watch, terminal, task-owner proxy, and execution-node modes
- Agent process adapters — `src/pi-service.ts`, `src/claude-service.ts` — Pi SDK event subscription and Claude CLI `stream-json` normalization into one browser event protocol
- Syncthing REST API — `src/syncthing.ts` — system/config/folder/status/ignore/device/scan operations against a loopback-only endpoint
- Cluster peer API — machine-authenticated subset in `src/server.ts` — membership, inventory, replication, credential replication, project mapping, session transfer, task two-phase handoff, and folder sharing
- SQLite internal contracts — module-local repositories over `~/.joint-bob/node.db` — users/sessions, projects/types/aliases, settings, preferences, review states, tasks/handoffs/tombstones, cluster, replication, credentials, push, locks, names, and audit tables
- CLI — `bin/joint-bob.mjs` — `install`, `doctor`, and help
- No OpenAPI/JSON Schema publication, GraphQL, gRPC, or database migration tool was found.

### Frameworks & Libraries
- Node.js — required `>=22.19.0`; pinned installer and observed runtime `22.23.2` — server/runtime and built-in `node:sqlite`
- TypeScript — declared `^5.7.2`, resolved `5.9.3` — strict backend compilation
- `tsx` — declared `^4.19.2`, resolved `4.23.12` — development watch and direct TypeScript tests
- Express — declared `^4.19.2`, resolved `4.22.2` — HTTP server and static PWA hosting
- `ws` — declared `^8.18.0`, resolved `8.21.3` — browser/peer WebSockets
- Zod — declared `^3.23.8`, resolved `3.25.76` — HTTP and socket boundary validation
- `@earendil-works/pi-coding-agent` — pinned/resolved `0.84.2` — interactive Pi sessions, models, tools, and streamed events
- `@anthropic-ai/claude-code` — pinned/resolved `2.1.239` — installed Claude CLI runtime
- `nanoid` — declared `^5.0.7`, resolved `5.1.16` — project, task, user, and session identifiers
- `web-push` — declared/resolved `3.6.7` — VAPID notifications
- Syncthing — repository pin `2.1.3`; live daemon observed during scan as `2.1.1` — filesystem synchronization
- Terraform — constraint `>=1.9, <2.0`, observed `1.14.1`; AWS provider `~>6.0` — temporary EC2 smoke test
- Browser UI has no React/Vue/Svelte/build bundler. It uses native DOM modules, CSS, Cache API, Service Worker, Notifications, and WebSocket APIs.

### Test Coverage
- **Test Directories**: `test/`, `deploy/aws-ec2-test/tests/`
- **Test Frameworks**: Node.js built-in `node:test` plus `node:assert/strict`; Terraform native test framework
- **Coverage Config**: absent; no line, branch, or function coverage threshold/report
- Full validation on 2026-08-27:
  - `npm run typecheck` passed
  - `npm test` passed: 246 tests, 0 failed, 0 skipped
  - `npm run build` passed
  - `terraform fmt -check -recursive` passed
  - `terraform validate` passed
  - `terraform test` passed: 1 test file/run, 0 failed
  - `npm audit --omit=dev --registry=https://registry.npmjs.org` reported 0 production vulnerabilities across 279 total dependency records
  - The environment's configured npm proxy audit endpoint returned HTTP 400; the explicit public npm registry audit succeeded. This is environment evidence, not an application failure.
- Test strengths: process-isolated multi-node mesh tests, SQLite migration/convergence tests, authentication/CSRF/WebSocket checks, installer rollback, Syncthing fake API tests, task handoff races, and filesystem boundary cases.
- Test gaps: no coverage instrumentation, no real browser/E2E runner, no behavioral test that proves partial assistant text reaches a connected browser before turn completion, no regression for review marking racing a newer transcript timestamp, and no regression for Syncthing ignored-content delete errors.
- Many UI tests assert source strings/regular expressions rather than execute DOM behavior. These are fast contract checks but can pass while runtime ordering or rendering is broken.

### Code Quality Indicators
- **Linting**: no ESLint, ShellCheck, Prettier, or repository formatter configuration/script. TypeScript strict mode is the only general static check. Terraform uses `terraform fmt` manually/project-guideline enforcement.
- **CI/CD**: `.github/workflows/release.yml` runs only for `v*` tags. It performs install, typecheck, tests, build, package smoke checks, checksum generation, GitHub release, and provenance-enabled npm publish. No pull-request or `main` push validation workflow exists. Local pre-push deployment automation lives in `scripts/hooks/pre-push` and `scripts/wait-for-main-and-deploy.sh`.
- **Documentation**: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, and inline comments are present. README coverage is good for install, pairing, private HTTPS, services, deployment, EC2 smoke testing, state boundaries, and security. Public API contracts and SQLite schema/migrations lack dedicated documentation.
- Naming is generally clear and boundary validation is strong. Error paths usually fail explicitly. Transactions protect most multi-table state changes.
- Security positives: scrypt password hashes, rate-limited login attempts, HttpOnly/Secure/SameSite cookies, CSRF checks, same-origin browser WebSockets, timing-safe machine-token checks, AES-256-GCM secret storage, loopback-only Syncthing API configuration, input schemas, path validation, CSP/security headers, package/checksum verification, encrypted EC2 storage, IMDSv2, and `/32` smoke-test ingress.

### Active Intent Findings

#### Delayed streamed agent replies
- Pi has a complete intended streaming chain: Pi SDK `message_update` → `eventPayload()` `textDelta` → `subscribeSharedSession()` broadcast → browser `handleSocketMessage()` → `renderBubbleContent()`.
- Claude uses `--output-format stream-json --include-partial-messages`, maps `content_block_delta` to `textDelta`, buffers events for reconnect replay, and reattaches by live session ID.
- The browser accepts Pi steering while `isStreaming` by sending `streamingBehavior: "followUp"`; the WebSocket listener does not deliberately wait for the previous message callback before receiving another message.
- The current repository does not contain runtime evidence proving where the reported delay occurs. Do not treat the following as confirmed root cause.
- Highest-risk regression area: commit `9ab9b04` introduced long-message batching in `public/app.js`. Existing tests verify source structure and final flush, not intermediate visible paints under real `requestAnimationFrame`/timer timing.
- Another boundary to instrument is SDK-to-WebSocket event timing. The adapter handles the resolved Pi 0.84.2 `assistantMessageEvent` shape, but no integration test timestamps SDK deltas, socket sends, and browser paints.
- Required bug regression should assert at least one assistant delta becomes visible before `assistantFinal`/`agent_end`, then assert a second user message can be queued during the same turn. Test Pi and Claude paths separately if both exhibit the symptom.

#### Mark all reviewed reverts to pending
- Review state is per user, project, and session path in SQLite.
- `markConversationsReviewed()` updates `reviewed_at` to the row's stored `last_activity_at`, not to a caller-supplied or freshly observed transcript activity time.
- The bulk HTTP route re-lists sessions for membership validation, then marks targets, but does not synchronize those current session timestamps into review tracking in the same operation. A transcript update between the prior list and the mark can therefore leave `reviewed_at` behind the next observed `updatedAt`, causing a later list to return `needs_review` again. This is a code-supported race hypothesis; the existing test avoids it by listing the updated session before bulk marking.
- The single-review route has the same persistence primitive and should be checked even though the reported symptom names bulk review.
- Required regression: create/update a transcript after the last review-state synchronization, call `reviewed-all` directly, then list sessions and require `reviewed`. Include concurrent/newer activity semantics so genuine post-click activity still returns `needs_review`.

#### Syncthing beecomm folder errors
- The reported token `beccomm` does not occur in product/runtime data inspected. The live folder is `joint-bob-beecomm-jCBVY7lvFo`, label `beecomm`, path `/Users/iliagerman/JointBob/work/beecomm`.
- Live Syncthing REST evidence during the scan: folder is unpaused and `idle`, but has 55 `pullErrors`, 55 needed deletes, and 95% completion.
- Error records consistently say a directory was deleted remotely but contains ignored files, for example `backend/alembic/__pycache__`: `syncing: delete dir: directory has been deleted on a remote device but contains ignored files (see ignore documentation for (?d) prefix)`.
- `src/syncthing.ts` manages `__pycache__/` as an ordinary ignore. It does not use Syncthing's delete-allowed `(?d)` prefix. This directly explains the observed blocked remote directory deletions.
- Repository pin is Syncthing 2.1.3, while the responding live daemon identified itself as 2.1.1. Version drift is real but the API error itself names ignored child content as the blocker.
- Required regression: seed an existing ignore list with the old managed Python-cache rule, reconcile it, and require the new delete-allowed managed rule without preserving the obsolete rule as a user rule. Validate exact scope so no source or credential pattern gains destructive-delete behavior.

### Architecture Decisions and Alternatives
- **Streaming fix direction**: preserve the event-driven SDK/CLI → normalized WebSocket → browser design and add timing-aware integration coverage. Alternative transcript polling would increase filesystem reads and still delay steering. Security implication: keep existing cookie/origin and machine-bearer checks; do not solve reconnect or delay by making `/ws` anonymous or exposing agent subprocess streams over a new unauthenticated port.
- **Review fix direction**: reconcile current session activity and advance review state atomically on the server. Alternative client retries or optimistic-state suppression would hide stale persistence and fail across tabs/nodes. Privacy implication: preserve per-user review rows and avoid replicating reading behavior to peers unless a future requirement explicitly asks for it.
- **Syncthing fix direction**: use delete-allowed ignore semantics only for proven generated caches such as Python `__pycache__`, with migration of the old managed rule. Alternative operational cleanup is to delete the ignored cache contents manually and rescan, but errors will recur. Security/data-loss implication: never apply `(?d)` broadly to `.env`, keys, credentials, logs, all ignored files, or arbitrary user rules. It authorizes Syncthing to remove ignored local content when a parent is deleted remotely.
- **Persistence architecture**: current single-file SQLite with module-owned schema setup keeps deployment simple. Alternative centralized migrations/repositories would reduce schema drift but add migration machinery. Security implication: any migration framework must preserve `0600` database/backup permissions and encrypted secret columns.

### Technical Debt Signals
- `src/server.ts` is 3,719 lines and `public/app.js` is about 3,978 lines. Both are composition roots plus substantial domain/UI logic, increasing change collision and regression risk.
- `src/store.ts`, `src/cluster.ts`, `src/tasks.ts`, and `src/github-auth.ts` are also over 500 lines. Several functions exceed the project's preferred 50-line limit.
- Schema creation and guarded `ALTER TABLE` migrations are spread across many modules sharing one SQLite database. There is no schema version table covering the whole application or ordered migration runner.
- Multiple modules independently cache `DatabaseSync` handles to the same file. WAL helps concurrency, but transaction ownership and migration ordering are hard to reason about.
- `src/server.ts` returns most thrown `Error.message` values in HTTP 500 responses. Unexpected filesystem, SQLite, peer, or process errors can disclose operational details to an authenticated client.
- `GET /api/projects/:projectId/file` lexically bounds the requested path, then uses `stat`/`createReadStream`; a project-contained symlink may point outside the project. This needs a realpath/lstat boundary test and decision.
- Claude runs with `--permission-mode bypassPermissions`; Pi safeguards can be disabled. This is powerful by design but raises the impact of stolen browser sessions or unsafe public exposure. Private-network deployment guidance is therefore an architectural control, not optional prose.
- Cluster peer URLs accept general valid URLs and peer calls carry machine credentials. Pairing documentation says private HTTPS, but code does not enforce HTTPS/private address policy. This preserves local-test flexibility at the cost of SSRF/credential exposure risk for an administrator who configures an unsafe peer.
- No general API rate limiting exists beyond login attempts. The product relies on authentication and private networking.
- The PWA and API share a large unversioned hand-written contract. There is no generated client or contract schema.
- UI stream-performance tests and many UI feature tests inspect source text instead of browser behavior.
- CI does not validate pull requests or ordinary `main` pushes. Release tags are the only hosted test gate found.
- No lint, formatter, shell lint, or coverage gate is configured despite project guidance to follow formatter/linter conventions.
- Runtime aliases and migration names retain `MASTER_BOB_*` and `.pi-mobile-web` compatibility paths. Necessary for upgrades, but they expand configuration and test burden.
- Syncthing error reporting collapses readiness failures to `Syncthing folder is not synchronized on this node`, losing actionable folder error details at handoff boundaries.
- Startup readiness remains `starting` after an initial Syncthing ignore-reconciliation failure and has no in-process retry for that startup gate; service restart is the apparent recovery path.
- The live Syncthing daemon version differs from the repository's pinned version, showing installer/runtime ownership can drift.
- No TODO/FIXME/HACK comments or TypeScript suppression directives were found in product source. Debt is structural and behavioral rather than marker-based.
