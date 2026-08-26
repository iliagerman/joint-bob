# API Documentation

## Project APIs
- `GET /api/projects` - Returns `{ projects: ProjectRecord[] }`.
- `POST /api/projects` - Creates/registers a project from `name`, `path`, optional `synced`, and optional `macPath`; returns `{ project }`.
- `DELETE /api/projects/:projectId` - Removes registration and project tasks.
- `GET /api/projects/:projectId/sessions` - Lists project sessions and related task state.
- `DELETE /api/projects/:projectId/sessions` - Deletes a session.
- `GET /api/projects/:projectId/tasks` - Lists tasks.
- `POST /api/projects/:projectId/tasks` - Creates a task.
- `PATCH /api/projects/:projectId/tasks/:taskId` - Updates a task.
- `DELETE /api/projects/:projectId/tasks/:taskId` - Deletes a task.

## Other APIs
The server also exposes health, model, file, push, session rename, and WebSocket chat/watch interfaces.

## Internal Project APIs
- `listProjects(): Promise<ProjectRecord[]>`
- `getProject(projectId): Promise<ProjectRecord | undefined>`
- `addProject(name, folderPath, options): Promise<ProjectRecord>`
- `removeProject(projectId): Promise<void>`
- `touchProject(projectId): Promise<void>`

## Data Model
`ProjectRecord` contains `id`, `name`, `path`, `createdAt`, and `updatedAt`. Project creation input is validated by Zod. Current schema requires callers to calculate and submit the complete homeserver path.
