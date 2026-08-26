# Code Structure

## Build System
- npm scripts with TypeScript compiler.
- `npm run typecheck`, `npm run build`, and `npm start` are primary commands.

## Existing Files Inventory
- `public/index.html` - Application markup and dialogs.
- `public/app.js` - Client state, rendering, API calls, and interactions.
- `public/styles.css` - Responsive visual design.
- `public/board.js` - Kanban rendering.
- `public/markdown.js` - Markdown rendering.
- `public/sw.js` - PWA cache and service worker.
- `src/server.ts` - Express routes and WebSockets.
- `src/store.ts` - Project storage and Syncthing registration.
- `src/types.ts` - Shared server-side types.
- `src/tasks.ts` - Task storage.
- `src/pi-service.ts` - Pi integration.
- `src/claude-service.ts` - Claude integration.
- `src/watcher.ts` - Session file watching.
- `src/push.ts` - Notifications.
- `scripts/` - HTTPS and service installation scripts.
- `deploy/` - systemd units.

## Design Patterns
- Module-level service functions rather than classes.
- JSON-file repositories for small local datasets.
- Browser singleton state with explicit render functions.
- REST for commands and WebSockets for streaming/live refresh.
