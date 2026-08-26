# Managed project home execution plan

## Inception

- Confirm one node-local home path with deterministic project and ticket subdirectories.
- Preserve existing project paths and secure credential replication.
- Fence unsafe home changes that would orphan ticket workspaces.

## Construction

1. Add failing settings, UI, project mapping, ticket path, Git-ignore, and Syncthing path-update tests.
2. Add managed-home path and root-ignore helpers.
3. Replace separate project root settings with one `homePath` setting.
4. Derive new project paths and peer mappings from the selected home.
5. Derive ticket workspace root from the selected home.
6. Update an existing Syncthing folder when its configured path changes.
7. Update UI, README, and PWA cache.
8. Run focused tests, typecheck, full tests, and build.

## Explicit exclusions

- No automatic movement of existing projects.
- No Git clone/attach workflow in this increment.
- No credential format or transport changes.
- No change to legacy Git-backed ticket handoff or merge.
- No commit, push, branch, worktree, merge, reset, or clean operation.
