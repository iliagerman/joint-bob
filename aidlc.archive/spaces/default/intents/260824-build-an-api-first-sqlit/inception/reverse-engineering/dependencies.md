# Dependencies

## Internal Dependencies
- Browser client depends on Express REST and WebSocket contracts.
- `server.ts` depends on store, tasks, watcher, push, Pi, and Claude modules.
- `store.ts` depends on `ProjectRecord` and optional Syncthing REST configuration.
- Agent services and task storage depend on shared types.

## External Dependencies
- `express` 4.19.2 - HTTP routing and static serving.
- `ws` 8.18.0 - WebSocket protocol.
- `zod` 3.23.8 - Request validation.
- `nanoid` 5.0.7 - Project and task IDs.
- `web-push` 3.6.7 - Browser push notifications.
- `@earendil-works/pi-coding-agent` 0.80.6 - Pi SDK.

Licenses are defined by each installed package; no project-level dependency license audit was found.
