# Node Project Sync Code Generation Plan

## Persistence
- Use `node:sqlite` `DatabaseSync` in `src/store.ts`.
- Store projects in `node.db`; migrate existing `projects.json` once when the table is empty.
- Keep local `path`, compatibility `macPath`, and shared `syncFolderId` fields.

## Synchronization
- Add a focused Syncthing client module for folder lookup and stable folder IDs.
- Make import accept an explicit local path; never infer by swapping path fields.
- Detect an already configured Syncthing path by folder ID before requesting user input.

## API
- Return `pending` entries from cluster import.
- Add a project mapping endpoint using `peerId`, `projectId`, and `localPath`.
- Add a home-scoped directory listing endpoint.

## Frontend
- Add a mapping dialog with editable path, Browse action, directory navigation, and confirmation.
- Continue mapping pending projects until none remain, then reload projects and inventory.

## Validation
- Focused tests first, then full suite, typecheck, build, JavaScript syntax, diff check, and browser verification.
