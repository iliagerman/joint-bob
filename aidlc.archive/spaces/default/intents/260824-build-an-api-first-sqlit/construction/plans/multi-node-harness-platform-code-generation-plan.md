# Test-first five-node harness platform code-generation plan

## Test packages written before implementation

- `test/contracts/`: HTTP/OpenAPI and WebSocket payload/status/error contracts.
- `test/api/`: black-box tests against a real ephemeral HTTP server.
- `test/integration/sqlite/`: schema migrations, legacy import, restart persistence, encryption, and transaction behavior.
- `test/integration/cluster/`: two-to-five process membership, replication, retry, partition, and recovery.
- `test/integration/handoffs/`: Pi/Claude ownership, leases, worktree bundles, routing, rollback, and concurrency rejection.
- `test/browser/`: login, forced password change, Settings, node selection, task handoff, desktop, and mobile.
- `test/install/`: macOS/Linux installer, prerequisite, service, upgrade, checksum, and rollback contracts.
- `infra/tests/`: Terraform/OpenTofu validation, native tests/mocks, security scans, and destroy/cleanup assertions.
- `scripts/e2e/`: isolated Mac/homeserver runner and two-EC2 real E2E runner with evidence collection.

Every production change must be preceded by a focused failing test. Existing static source-string tests should be replaced by behavioral tests when the relevant application factory/API exists.

## Application seams required by tests

- Export `createApp(dependencies)` and a separate production bootstrap.
- Inject SQLite location/connection, clock, ID generator, secret cipher, harness registry/runners, Syncthing client, peer transport, filesystem boundary, process launcher, and logger.
- Keep dependency injection at real external boundaries; do not create speculative abstractions.
- Run API tests over HTTP, not direct route-handler calls.
- Run cluster tests with independent processes, data directories, ports, identities, and databases.

## Implementation slices

1. SQLite migration runner and repositories.
2. Legacy JSON/browser-state import and write removal.
3. Admin authentication, secure cookies, CSRF, rate limits, and encrypted secrets.
4. Settings APIs and responsive Settings UI.
5. Cluster membership, invites, machine credentials, online status, and five-node limit.
6. Transactional replication outbox/inbox and conflict rules.
7. Task owner/lease/per-node state schema and APIs.
8. Destination eligibility and node-neutral task UI.
9. Git/worktree handoff bundle, Pi resume, Claude relocation, and routed WebSockets.
10. Release installer/onboarding and prerequisite validation.
11. Mac/homeserver isolated E2E and safe deployed migration.
12. Terraform/OpenTofu EC2 test environment and final real E2E.

## Multi-agent workflow

- Sol assigns non-overlapping slices to isolated coding workers.
- A separate worker owns contract/failure tests before implementation workers start.
- The code-reviewer observer checks workers for contract drift, unrelated edits, missing tests, security issues, and project-rule violations.
- Workers may write and test code but cannot commit, push, deploy, or declare acceptance.
- Sol independently reads diffs, runs the full relevant suite, reviews test quality, and records accept/reject findings.
- Rejected findings become mandatory worker tasks. Review repeats until Sol accepts.
- The currently installed agent registry has `default` and `code-reviewer`; requested Terra coding agents must be installed/configured before they can be selected by name.

## Validation gates

For every slice:

```bash
npm test
npm run typecheck
npm run build
node --check public/app.js
bash -n scripts/*.sh
git diff --check
```

When applicable:

```bash
terraform fmt -check -recursive infra
terraform validate
terraform test
trivy config infra
checkov -d infra
```

Then run black-box API tests, process-level cluster tests, and browser tests. Final validation additionally runs isolated Mac/homeserver E2E and the explicitly approved two-EC2 E2E with guaranteed cleanup.

## Evidence and acceptance

Each phase records:

- failing-test evidence before implementation;
- worker assignments and reviewer findings;
- commands and complete results;
- migration/rollback evidence;
- API and browser evidence;
- Sol rejection findings and their fixes;
- Sol acceptance decision.

No unchecked failures, skipped critical scenarios, worker self-approval, or completion claim is permitted.
