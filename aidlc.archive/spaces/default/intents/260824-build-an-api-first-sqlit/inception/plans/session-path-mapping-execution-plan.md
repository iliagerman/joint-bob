# Session Path Mapping Execution Plan

## Scope and Risk
- **Transformation**: Replace global one-way path translation with explicit per-project paired paths.
- **Affected components**: project store/types, session discovery, watcher, REST API, project UI, deployment data.
- **Risk**: Medium; session visibility depends on persisted path accuracy.

## Sequence
1. Add failing path-pair behavior tests.
2. Add a pure direction-neutral project-path resolver.
3. Persist `macPath` on new projects and add an update operation for existing projects.
4. Pass complete project path pairs into Pi/Claude discovery and session watchers.
5. Add authenticated API and project-list UI for editing a mapping.
6. Bump PWA cache.
7. Run automated tests, typecheck, build, and JavaScript syntax validation.
8. Deploy source/static files, populate all existing homeserver mappings, restart, and verify Internal Assistant sessions.

## Success Criteria
- No project-specific hardcoded mapping remains.
- Both paths produce the same pair.
- Existing and future synced projects expose sessions from both machines.
- Mapping changes are live.
- Production Internal Assistant session list includes current sessions.
