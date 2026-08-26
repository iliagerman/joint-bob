# Code quality assessment

## Assessment scope and limitations

The scan analyzed all backend TypeScript modules, canonical browser JavaScript and HTML, operations code, configuration, selected high-value tests, and package metadata. All 75 TypeScript test files and 213 test names were inventoried. Tests were not executed during this inspection-only scan.

No coverage report exists. A dependency audit was attempted, but the configured npm registry returned HTTP 400. Vulnerability status is unverified.

## Positive indicators

- TypeScript strict mode is enabled for backend source.
- Zod validates HTTP and WebSocket input at real trust boundaries.
- Authentication uses scrypt-derived password hashes, secure SQLite-backed sessions, forced initial password changes, CSRF checks, and strict WebSocket origin matching.
- Machine-token comparison is timing-safe.
- Secrets use AES-256-GCM and a node-local mode-`0600` 32-byte key.
- Security headers set CSP, HSTS, frame denial, MIME sniff prevention, and referrer policy.
- SQLite writes commonly use explicit transactions and rollback.
- Handoff logic verifies task ownership, leases, synchronization readiness, and Git bundle checksums.
- Project relocation includes rollback behavior.
- Service worker cache `joint-bob-v25` lists only assets that existed during the scan.
- README and operational documents cover installation, pairing, synchronization, private HTTPS, services, deployment, EC2 smoke tests, security, and persistence.

## Test posture

### Inventory

- 75 TypeScript test files.
- 213 discovered test cases.
- About 8,992 lines of test code.
- Approximately 24 direct module unit or integration files.
- Approximately 12 in-process API or network integration files.
- Approximately 18 spawned-process integration files.
- Approximately 21 static source-contract files.
- Terraform native tests under `deploy/aws-ec2-test/tests/`.

### Strong areas

- Authentication, CSRF, WebSocket origin enforcement, and session deletion boundaries.
- SQLite persistence and legacy migrations.
- Cluster membership, tombstones, aliases, retries, replication, and task ownership.
- Handoff settlement, Syncthing readiness, workspace rules, and Git bundle integrity.
- Installer rollback, release metadata, service ports, and runtime pins.
- Project and conversation UI contracts and accessibility hooks.
- Runtime settings, harness registry, session path mapping, task routing, and WebSocket proxy errors.

### Gaps

- No measured line, branch, or function coverage.
- No real-browser end-to-end tests.
- Many UI tests use regular expressions against HTML, CSS, and JavaScript source instead of executing DOM behavior.
- No load, soak, fault-injection, or performance suite.
- No automated security scanner result.
- Terraform tests are absent from the tag release workflow.
- The scan did not establish a passing runtime baseline because tests were not run.

## Tooling and delivery quality

### Linting and formatting

No ESLint, Prettier, Biome, ShellCheck, Markdown lint, Terraform lint, lint script, or formatter configuration was found. Style consistency depends on review and existing conventions. `skipLibCheck` also leaves dependency declaration files outside full compiler checking.

### CI and release automation

`.github/workflows/release.yml` runs only on `v*` tags. It performs `npm ci`, typecheck, tests, build, package smoke checks, GitHub release creation, and npm publication with provenance. There is no pull-request or ordinary `main` push validation workflow.

The local pre-push hook waits for the exact remote `main` commit and deploys installed nodes. It is deployment automation tied to one checkout, not centralized CI. Production services correctly run from installed copies rather than mutable source checkouts.

The EC2 smoke infrastructure uses encrypted storage, IMDSv2, and operator-only `/32` ingress. Terraform tests exist but do not run in the release workflow.

## Documentation quality

Present and useful:

- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`.
- Inline comments around synchronization, migration, security, handoff, and mobile reconnection.
- Installation and service templates for Linux and macOS.

Missing:

- REST and WebSocket reference.
- Machine-readable API specifications and generated client.
- Database schema document, schema version, and migration ledger.
- Repository architecture diagrams.
- Measured coverage and performance baselines.

## Maintainability findings

### Size and responsibility

- `src/server.ts`: 3,521 lines. Owns routes, sockets, task orchestration, peer proxying, reconciliation, and startup.
- `public/app.js`: 3,568 lines. Owns browser state, APIs, rendering, dialogs, navigation, and socket handling.
- `src/store.ts`: 695 lines.
- `src/cluster.ts`: 592 lines.
- `src/tasks.ts`: 561 lines.
- `src/github-auth.ts`: 541 lines.
- At least 19 functions exceed 50 lines. Large examples include `runClaudePrompt`, `mergeClusterMembership`, `handleSocketMessage`, `renderSessions`, and `taskCard`.
- Dense single-line functions and SQL in `tasks.ts` and `replication.ts` impede review and debugging.

### Persistence and duplication

- Schema ownership is spread across modules: 43 tables and 23 guarded alterations without a central migration order.
- Multiple modules open independent connections to the same database with varying lifecycle and timeout behavior.
- AES-GCM key loading and encryption helpers are duplicated in `cluster.ts`, `github-auth.ts`, `settings.ts`, and `push.ts`.
- `package-lock.json` and `npm-shrinkwrap.json` are identical files that must remain manually synchronized.
- REST and WebSocket contracts are duplicated by hand between TypeScript and untyped browser JavaScript.

### Compatibility burden

The runtime still accepts `PI_WEB_*`, `PI_MOBILE_WEB_*`, and `MASTER_BOB_*` aliases; old JSON stores; old service names; `.pi-mobile-web` paths; and legacy project and task identities. Broad compatibility supports upgrades but keeps migration branches in core paths.

Ignored root copies of canonical application files remain in the workspace. An ignored `dist/pi-service.sync-conflict-20260604-204139-5CHB2CY.js` records prior synchronization-conflict residue in generated output.

## Security findings

1. `GET /api/projects/:projectId/file` checks lexical containment, then follows symlinks through `stat` and `createReadStream`. An authenticated user can access a target outside the project through an in-project symlink.
2. Claude runs with `--permission-mode bypassPermissions`. Pi safeguards can be disabled per session. Account authentication, private-network deployment, and correct project path boundaries therefore carry most of the security load.
3. Generic error middleware returns internal exception messages in HTTP 500 responses.
4. Credential encryption is sound in concept, but duplicated implementations increase maintenance and migration risk.
5. No automated dependency, static application security, or infrastructure security scan result was available. npm vulnerability status remains unverified because the registry returned HTTP 400.

## Conversation, model, and mobile findings

- Claude session listing reads and parses complete JSONL transcripts before the merged harness list applies its 50-session cap. Large histories can make listing expensive.
- Session title overrides key on `path.basename(sessionPath)`. Equal filenames in different directories can collide.
- Conversation discovery spans project paths, `macPath`, learned node locations, ticket workspaces, and multiple encoded Claude directories. This supports migration and synchronization but makes project isolation sensitive to path normalization and aliasing.
- Active Claude connections include `projectId` and session ID; shared Pi sessions key on working directory and session path.
- Non-task chat sends the UI-selected `nodeId` through the WebSocket URL. Task chat uses `TaskRecord.currentNodeId` instead.
- Claude model and effort are configurable in the current browser. Pi models are configurable, and the server supports Pi thinking-level commands, but the browser does not expose a direct Pi thinking selector.
- Task phase records support `effort`, while current task editor choices encode only `default` and expose no separate effort selector.
- Mobile top bars truncate title and status rather than wrapping. The main bottom navigation uses a fixed four-column grid and does not slide. The separate chat control toolbar uses hidden-scrollbar horizontal overflow, so access to execution and session actions on narrow screens depends on horizontal sliding.
- Static source-contract tests cover parts of these controls but do not prove touch behavior, viewport fit, focus movement, or browser history behavior in a real mobile browser.

## Overall assessment

Core security boundaries, transactional persistence, multi-node handoff, and installer rollback receive serious implementation and test attention. Structural quality is weaker. Two oversized composition files, scattered schema changes, duplicated crypto helpers, untyped frontend contracts, regex-heavy UI tests, and missing PR CI make safe change harder than the test count alone suggests.
