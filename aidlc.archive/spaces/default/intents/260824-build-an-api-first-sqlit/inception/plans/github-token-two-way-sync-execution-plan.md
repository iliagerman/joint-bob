# GitHub Token Two-Way Sync Execution Plan

## Scope and Risk
- **Transformation**: Move only GitHub auth persistence from machine-local runtime data to a shared, gitignored file.
- **Affected components**: `src/github-auth.ts`, integration tests, README configuration.
- **Risk**: Medium because credentials are sensitive; implementation preserves masking and restrictive permissions.

## Phase Decisions
- Requirements Analysis: Execute at minimal depth.
- User Stories: Skip; one private operator and one clear flow.
- Application Design: Skip; existing auth module remains the boundary.
- Units Generation: Skip; single cohesive module change.
- Functional/NFR/Infrastructure Design: Skip; requirements fully define the small persistence change and existing Syncthing infrastructure is reused.
- Code Generation: Execute.
- Build and Test: Execute.

## Sequence
1. Add a failing cross-device GitHub auth persistence test.
2. Separate shared auth storage from machine-local askpass storage.
3. Add legacy local-store fallback and migration.
4. Document the shared path and override variable.
5. Run tests, typecheck, build, syntax, and diff checks.
6. Deploy through existing Syncthing, restart the homeserver service, and verify health and service environment.

## Success Criteria
- Account and project credentials propagate in both directions.
- Clearing credentials propagates.
- Existing API responses expose status booleans only.
- No token enters git-tracked files or command output.
