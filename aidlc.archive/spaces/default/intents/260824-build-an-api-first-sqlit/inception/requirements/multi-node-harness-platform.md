# Test-first five-node harness platform requirements

## Goal

Build Master Bob as an authenticated, API-first application that installs on macOS or Linux, supports a mesh of up to five nodes, stores all Master Bob-owned persistent state in node-local SQLite, and moves Pi or Claude tasks safely between eligible online nodes.

## Storage boundary

1. Every node has one unsynchronized SQLite database as the authoritative store for Master Bob-owned persistent state.
2. Projects, tasks, node and cluster records, settings, users, login sessions, preferences, names, credentials, ownership leases, replication state, and audit events are stored in SQLite.
3. Legacy JSON stores are imported once, non-destructively, and are never written after migration.
4. The frontend does not persist application state or bearer tokens in `localStorage` or `sessionStorage`. An opaque secure login cookie and the static PWA cache are permitted.
5. External tool data remains on the filesystem: project/Git checkouts, Pi and Claude transcripts/configuration, Syncthing folders/configuration, logs, temporary attachments, and worktrees.
6. SQLite files are never synchronized. Shared logical records replicate through authenticated node APIs.

## Authentication and settings

7. Installation creates no administrator credentials. On first browser open, the owner chooses the node-local administrator username and password.
8. The installer must never generate, accept, store, or print an initial administrator password.
9. Successful first-run setup authenticates the new administrator immediately without requiring a password change.
10. Passwords use Node built-in `crypto.scrypt`; authenticated browser sessions are server-side SQLite records referenced by `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
11. Mutating browser requests require CSRF protection. Login attempts are rate limited. The user can log out and revoke sessions.
12. A clear Settings workspace configures Account, Pi, Claude, Syncthing, cluster pairing, GitHub credentials, sync roots, and node-specific paths.
13. Secrets are encrypted before SQLite persistence and are never returned by inventory/status APIs.

## Cluster and synchronization

14. A cluster supports one through five nodes. A sixth active member is rejected.
15. No schema, API, label, or task type assumes a distinguished Mac, homeserver, local task, or remote task.
16. Pairing through one member distributes complete cluster membership so reachable members form a mesh.
17. Each member has a stable node ID, independent machine credential, online status, and last-seen timestamp.
18. Shared record mutations use idempotent event IDs, transactional outbox persistence, receipts, retries, and deterministic conflict rules.
19. Each project has a stable project ID and Syncthing folder ID. Every node stores its own absolute path in SQLite.
20. Syncthing auto-discovers environment overrides and standard macOS/Linux configuration, remains localhost-only, and adds each mapped node device to existing folders.
21. Credentials, `.git`, caches, worktrees, logs, binaries, and machine state remain excluded from managed synchronization.

## Harnesses, sessions, and task ownership

22. Harness and Session remain independent selectors backed by the adapter registry.
23. Pi and Claude are prerequisites. Installation validates that both are executable and working but does not install or authenticate them.
24. Every task has a current node, harness, exclusive ownership lease, and per-node execution state.
25. Every task exposes a node selector containing eligible online cluster nodes.
26. A node is eligible only when its project mapping, Git checkout, selected harness, runtime, and synchronization state pass validation.
27. A handoff stops the source harness, flushes state, transfers portable Git/worktree changes, prepares the destination worktree, resumes the transcript with destination-local paths, and changes ownership only after destination acknowledgement.
28. A failed handoff preserves source ownership and provides an actionable error. Concurrent execution is prohibited.
29. The browser may connect through any node. Task HTTP and WebSocket traffic routes to the task's current node without creating a separate remote-task concept.

## Installation

30. One command installs or updates a release under the current user on supported macOS/Linux architectures.
31. The installer verifies pinned release checksums, installs a native launchd/systemd user service, initializes SQLite, creates the administrator, validates Pi/Claude, adopts or configures Syncthing, and prints the login/onboarding URL.
32. Public assets contain no personal paths, aliases, proxy URLs, models, tokens, device IDs, or credentials.
33. EC2 is a normal Linux node and requires no public inbound application port; Tailscale HTTPS is the recommended transport.

## API-first testability requirements

34. Tests are written and observed failing before production implementation for every behavior slice.
35. All business functionality used by the UI is available through documented HTTP or WebSocket APIs. The UI contains no exclusive business logic.
36. The server exposes a testable application factory. Database path, clock, IDs, harness runners, Syncthing client, peer transport, filesystem boundary, and process launcher are injectable at explicit external boundaries.
37. Black-box API tests run against real HTTP listeners on ephemeral ports and isolated SQLite databases.
38. A local cluster harness starts two through five independent node processes with separate data directories, ports, identities, and fake or real external services.
39. Contract tests cover authentication, settings, nodes, projects, tasks, harnesses, sessions, ownership, replication, and errors. WebSocket messages are contract-tested too.
40. Tests must prove retries, idempotency, restart persistence, offline-node convergence, stale lease recovery, sixth-node rejection, transfer rollback, and secret redaction.
41. Mac and homeserver validation uses isolated data directories, alternate ports, and disposable project fixtures before touching deployed state.
42. Final real E2E provisions two temporary EC2 instances through tested Terraform/OpenTofu, installs fresh nodes, joins them to a cluster, verifies the complete workflow, collects evidence, and destroys resources.
43. EC2 creation is a billable action and requires explicit user approval immediately before apply. Infrastructure must have automatic cleanup and no broad public ingress.

## Multi-agent quality gates

44. Implementation is divided among multiple isolated coding workers. Test-contract work is separate from production implementation work where possible.
45. The parent `openai-codex/gpt-5.6-sol` agent owns architecture, integration, security review, execution of all validation, commits, deployment, and final approval.
46. A reviewer observes parallel workers for drift and rule violations.
47. Sol reviews every completed slice. A rejected slice returns to implementation, is fixed, and is reviewed again until accepted.
48. No phase, deployment, or final completion claim is allowed without Sol approval and retained test evidence.

## Acceptance criteria

- Every Master Bob-owned persistent record survives restart from SQLite; no runtime JSON or browser-storage writes remain.
- First browser open creates and authenticates an owner-selected administrator, and authentication/security API tests pass.
- All Settings sections are accessible and API-backed.
- Five nodes converge; a sixth node is rejected.
- Pi and Claude tasks transfer between eligible nodes with exclusive ownership and destination-local paths.
- Offline and failed destinations roll back safely.
- Full HTTP/WebSocket contract suites pass against isolated real servers.
- Mac plus homeserver functional validation passes.
- Two fresh EC2 nodes pass real installation, pairing, synchronization, task handoff, restart, and cleanup tests.
- Typecheck, build, frontend syntax, shell checks, Terraform checks/security scans, desktop/mobile browser tests, and `git diff --check` pass.
- Sol gives explicit final acceptance after all prior rejections are fixed.
