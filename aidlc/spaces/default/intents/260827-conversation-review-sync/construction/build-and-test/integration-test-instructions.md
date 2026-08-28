# Integration Test Instructions

## Minimal-strategy scope

The active Minimal strategy adds no separate integration suite. The targeted bug regressions already specified by `construction/code-generation/unit-test-instructions.md` exercise the required filesystem, SQLite, HTTP, WebSocket, peer-authentication, Syncthing, and two-process boundaries.

## Commands

Run each distinct command once:

```bash
node --import tsx --test test/session-paths.test.ts test/pi-session-cache.test.ts test/pi-session-discovery.test.ts test/claude-session-cache.test.ts test/claude-sync-conflict.test.ts
node --import tsx --test test/conversation-ownership.test.ts test/replication.test.ts test/conversation-ownership-mesh-api.test.ts
node --import tsx --test test/streaming-render-performance.test.ts test/claude-session-reattach.test.ts test/websocket-chat-streaming.test.ts
node --import tsx --test test/conversation-status-indicators.test.ts test/conversation-review-api.test.ts
node --import tsx --test test/syncthing.test.ts
node --import tsx --test test/preferences-api.test.ts test/recent-conversations-ui.test.ts
```

Expected result: 17, 4, 10, 3, 12, and 9 tests pass respectively, with zero failures.

## Test data and cleanup

Tests use temporary homes, independent SQLite databases, stubbed Pi/Claude engines, fake peer/Syncthing servers, and deterministic JSONL transcripts. They must close child processes, sockets, watchers, and temporary files in cleanup blocks. No test may use a production transcript path.
