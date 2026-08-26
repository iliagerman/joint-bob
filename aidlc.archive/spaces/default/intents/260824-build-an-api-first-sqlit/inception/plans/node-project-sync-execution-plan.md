# Node Project Sync Execution Plan

1. Add failing tests for SQLite migration, node-local path persistence, stable project identity, unresolved imports, and mapping UI contracts.
2. Replace the project JSON writer with a small Node built-in SQLite repository while retaining one-time JSON migration.
3. Add node-local runtime/configuration tables and discover verified Pi/Claude installations without relying on interactive shell aliases.
4. Add stable `syncFolderId` metadata and explicit-local-path import semantics.
5. Add Syncthing folder discovery so an existing folder ID resolves its local path automatically.
6. Define managed Pi/Claude sync profiles that preserve sessions and global rules while excluding credentials and machine state.
7. Change cluster import to return pending mappings instead of reversing remote paths.
8. Add mapping and scoped directory-browser APIs.
9. Add runtime selection and project-mapping workflows to the Nodes UI.
10. Preserve existing project/session/task behavior and compatibility fields.
11. Package the backend as a native user service; treat a container as an optional frontend/API deployment backed by a native host helper.
12. Run full validation and verify the real paired Mac/homeserver flow without changing Git metadata.
