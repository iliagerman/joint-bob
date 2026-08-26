# System Architecture

## System Overview
A single Node.js process serves a framework-free browser client, REST endpoints, and WebSocket streams. It persists local JSON state and delegates conversations to Pi SDK or Claude CLI services.

## Components
- `public/`: HTML, CSS, JavaScript, PWA shell, markdown, and board rendering.
- `src/server.ts`: HTTP and WebSocket composition root.
- `src/store.ts`: Project persistence and Syncthing setup.
- `src/tasks.ts`: Task persistence.
- `src/pi-service.ts`: Pi session integration.
- `src/claude-service.ts`: Claude session integration.
- `src/watcher.ts`: Filesystem-driven session refresh.
- `src/push.ts`: Web Push integration.

## Data Flow
Project creation flows from `public/app.js` to `POST /api/projects`, through Zod validation into `addProject`, then back to client state through `loadProjects` and `selectProject`.

## Integration Points
- Local filesystem for projects and JSON stores.
- Syncthing REST API for optional folder registration.
- Pi coding-agent SDK.
- Claude CLI.
- Web Push endpoints.

## Deployment
TypeScript compiles to `dist/`; systemd runs `npm start` on the homeserver. No cloud infrastructure package exists.
