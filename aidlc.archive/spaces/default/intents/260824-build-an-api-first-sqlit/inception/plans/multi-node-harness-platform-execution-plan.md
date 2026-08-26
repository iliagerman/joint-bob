# Test-first five-node harness platform execution plan

## Operating rule

No production slice starts until its API, integration, failure, and migration tests exist and fail for the intended reason. Each slice repeats:

1. Contract/test worker writes the smallest complete failing tests.
2. Sol reviews and freezes the observable contract.
3. Implementation workers code in isolated worktrees.
4. Reviewer monitors drift and project-rule violations.
5. Sol integrates, runs all tests, reviews security and architecture, and either accepts or rejects.
6. Rejected work returns to implementation until Sol accepts it.

## Phase 0 — Freeze contracts and build the test harness

- Preserve the existing working tree and deployed data.
- Define HTTP/OpenAPI and WebSocket contracts for auth, settings, nodes, projects, tasks, harnesses, sessions, and errors.
- Refactor startup behind `createApp(dependencies)` only after failing harness tests exist.
- Build isolated SQLite fixtures, deterministic clock/ID fixtures, fake Pi/Claude runners, fake Syncthing REST, fake peer transport, and real ephemeral HTTP listeners.
- Build a process-level cluster fixture that starts two through five independent nodes.
- Gate: existing behavior plus new test infrastructure accepted by Sol.

## Phase 1 — Unified node-local SQLite

- Write migration and restart-persistence tests first.
- Add schema migrations for users, preferences, settings, cluster, tasks, names, credentials, ownership, replication, and audit records.
- Migrate projects, tasks, cluster, names, GitHub credentials, service settings, and browser preferences non-destructively.
- Remove runtime writes to JSON and browser local/session storage.
- Keep external Pi/Claude/Syncthing/Git files at explicit filesystem boundaries.
- Gate: full storage suite and legacy migration evidence accepted by Sol.

## Phase 2 — Login and secret management

- Write black-box login, forced-password-change, cookie, CSRF, rate-limit, logout, revoke, restart, and redaction tests first.
- Implement node-local administrator bootstrap and `scrypt` password hashing.
- Replace browser bearer-token authentication with server-side SQLite sessions.
- Encrypt GitHub, Syncthing, and machine credentials in SQLite.
- Gate: Sol security review and API/browser authentication acceptance.

## Phase 3 — API-backed Settings workspace

- Write API and desktop/mobile browser tests for every Settings section first.
- Implement Account, Pi, Claude, Synchronization, Cluster, and GitHub sections.
- Add executable/version checks, test-connection actions, masked secret status, node-specific path pickers, and validation errors.
- Gate: Settings contract, accessibility, and browser evidence accepted by Sol.

## Phase 4 — Five-node mesh and replicated records

- Write two-to-five-node convergence tests and sixth-node rejection first.
- Implement membership, invites, machine authentication, heartbeat/last-seen, and node-neutral inventory.
- Add transactional outbox/inbox, receipts, retry, idempotency, restart recovery, and deterministic conflict handling.
- Replace `local`/`remote` domain language and direct one-off peer assumptions.
- Gate: simulated five-node partition/recovery suite accepted by Sol.

## Phase 5 — Task ownership and node handoff

- Write Pi and Claude handoff, lease, worktree transfer, routing, destination failure, source rollback, stale owner, and concurrent-start rejection tests first.
- Persist current node, harness, exclusive lease, and per-node task execution state.
- Add destination eligibility checks and the `Runs on` selector.
- Transfer portable Git/worktree state without synchronizing `.git` or worktree directories.
- Resume Pi with destination `cwdOverride`; relocate Claude transcripts to the destination-local encoded project directory.
- Route task HTTP/WebSocket traffic to the current node.
- Gate: Sol accepts all handoff failure and success evidence.

## Phase 6 — One-command installation and onboarding

- Write installer contract tests before changing installer behavior.
- Validate release checksum/signature, OS/architecture, Pi, Claude, Syncthing, Node, admin bootstrap, service activation, upgrade, and rollback behavior.
- Complete neutral launchd/systemd installation and first-run onboarding.
- Ensure missing prerequisites fail with actionable output and no partial unsafe service.
- Gate: clean macOS and Linux installation evidence accepted by Sol.

## Phase 7 — Physical Mac and homeserver validation

- Start isolated test nodes on alternate ports and temporary data roots.
- Exercise login, password change, settings, pairing, project mapping, Syncthing, Pi/Claude sessions, task creation, bidirectional task handoff, restart, offline recovery, and removal.
- Back up deployed databases before any migration rehearsal.
- Deploy only after isolated tests pass.
- Gate: retained API logs, screenshots, database checks, and Sol approval.

## Phase 8 — Two-EC2 real E2E

- Write Terraform/OpenTofu static, native mock/plan, security, and cleanup tests first.
- Provision two temporary Linux instances in a dedicated test environment with no public application ingress.
- Inject ephemeral Tailscale and harness test credentials through protected runtime inputs, never Terraform state or source.
- Run the public installer from clean hosts, create/login/change password, join both nodes, map a disposable Git project, verify Syncthing and Pi/Claude, transfer tasks both ways, restart services, test offline convergence, and collect evidence.
- Always destroy resources in success/failure cleanup. Require explicit user approval immediately before billable `apply`.
- Gate: Sol reviews the evidence and issues explicit final acceptance or rejects with required fixes.

## Completion rule

The application is complete only when every gate is accepted, every rejection has been fixed and re-reviewed, Mac/homeserver validation passes, two fresh EC2 nodes pass real E2E, resources are destroyed, and Sol records final acceptance.
