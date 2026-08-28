# Unit test instructions

## Runner and configuration

Use the repository's existing Node.js test runner through installed `tsx`. No new dependency, test configuration file, or `package.json` script is needed.

Run each command from the repository root. Commands list exact test files and are scoped to this zero-Unit bugfix iteration.

## Exact commands

### Canonical transcript discovery and recovery

```bash
node --import tsx --test test/session-paths.test.ts test/pi-session-cache.test.ts test/pi-session-discovery.test.ts test/claude-session-cache.test.ts test/claude-sync-conflict.test.ts
```

### Ownership persistence, replication, transfer, and two-node prevention

```bash
node --import tsx --test test/conversation-ownership.test.ts test/replication.test.ts test/conversation-ownership-mesh-api.test.ts
```

`test/conversation-ownership.test.ts` and `test/conversation-ownership-mesh-api.test.ts` are planned new files because database invariants and the mandatory two-node writer race do not fit an existing narrow test file.

### Stream visibility and queued steering

```bash
node --import tsx --test test/streaming-render-performance.test.ts test/claude-session-reattach.test.ts test/websocket-chat-streaming.test.ts
```

`test/websocket-chat-streaming.test.ts` is planned only for the real WebSocket ordering boundary. Keep pure adapter/render assertions in the two existing files.

### Review watermarks

```bash
node --import tsx --test test/conversation-status-indicators.test.ts test/conversation-review-api.test.ts
```

### Syncthing generated-cache reconciliation

```bash
node --import tsx --test test/syncthing.test.ts
```

## Test data

- Build Pi transcript fixtures as newline-delimited JSON with a supported `session` header, stable event IDs, ISO timestamps, and canonical/conflict filenames for one session ID.
- Include candidates that are complete, truncated, malformed, wrong-ID, invalid-timestamp, equal-timestamp, and Pi-unloadable. The complete fixture must include identifiable Wolt analysis, test, and production-deployment messages.
- Use temporary session roots from `mkdtemp`; verify canonical bytes after replacement and verify obsolete copies moved beneath the dedicated Joint Bob directory in `os.tmpdir()`.
- Generate 500-path and 1,000-path directory fixtures in one process. Measure repeated runs with `performance.now()` and compare medians. Keep transcript parsing limited to groups with conflicts.
- Use temporary `PI_WEB_DATA_DIR` or `JOINT_BOB_DATA_DIR` values per ownership/review test. Never share mutable SQLite state across tests.
- Ownership fixtures use deterministic engine/session IDs, node IDs, epochs, and statuses. Include one same-epoch conflicting-owner record and source/destination restart fixtures.
- The two-node regression starts child server processes with separate homes/data directories and a shared synchronized transcript directory. Stub the agent execution boundary so the test counts invocations and writes deterministic deltas without calling external models.
- Streaming fixtures emit `textDelta`, completion, queued prompt, queue status, abort, and unsupported-command events in controlled order for both Pi and Claude.
- Review fixtures carry both displayed click watermarks and later server-observed activity timestamps. Cover before, equal, and after relationships.
- Syncthing fixtures use the existing local fake HTTP server. Seed `__pycache__/`, protected ignores, arbitrary user rules, and duplicates; inspect the exact posted ignore list.

## Mocking and isolation

- Use Node built-ins only: `node:test`, `node:assert/strict`, temporary filesystem helpers, `node:http`, child processes, and `ws`, which is already installed.
- Stub only external boundaries: Pi/Claude execution, peer HTTP, clock where deterministic timestamps matter, and Syncthing REST. Exercise real SQLite transactions, filesystem rename/move behavior, Express routes, and WebSocket serialization.
- Do not mock transcript parsing, ownership conflict resolution, review SQL, or replication-event validation. Those are the behavior under test.
- Capture `console.warn` only around structured diagnostic assertions and restore it after each test. Assert required fields and absence of transcript text, tokens, and credentials.
- Give every child process its own port, home, and node database. Ensure all servers, sockets, file watchers, and child processes close in `finally` blocks.

## Expected coverage

Minimal bugfix strategy: at least one verifiable regression per direct FR/NFR requirement at the narrowest effective level and one happy-path unit test per new component. No numeric line-coverage threshold applies to bugfix scope. The mandatory floor is the two-node conflict-prevention regression plus a green existing suite, typecheck, and build in the later Build and Test stage.
