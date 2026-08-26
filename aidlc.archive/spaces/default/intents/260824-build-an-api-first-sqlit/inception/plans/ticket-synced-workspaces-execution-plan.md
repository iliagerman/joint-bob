# Ticket synchronized workspace execution plan

## Analysis summary

- **Transformation type**: Multi-component replacement inside existing task and Syncthing boundaries.
- **Primary change**: New tickets use synchronized filesystem copies instead of Git worktrees.
- **User-facing impact**: Tickets work on nodes without Git. Archive and delete remove ticket files cluster-wide.
- **Data compatibility**: Existing nullable worktree fields remain for legacy Git tickets. New tickets store a workspace path and no branch.
- **Risk level**: Medium. Cleanup and handoff must not expose a missing or partially synchronized workspace.
- **Rollback**: Application rollback preserves existing task rows and filesystem data. Legacy Git behavior remains available.

## Component relationships

- `src/task-workspaces.ts`: deterministic paths, filtered project copy, and workspace removal.
- `src/syncthing.ts`: stable ticket folder setup and readiness checks.
- `src/tasks.ts`: new-ticket workspace creation and destination-local path assignment.
- `src/server.ts`: startup sharing, handoff eligibility, archive/delete cleanup, and ticket prompts.
- `public/board.js` and `public/app.js`: archive endpoint and legacy-only merge action.
- `test/`: non-Git creation, filtering, cleanup, Syncthing folder configuration, handoff, and UI/API contracts.
- `README.md`: ticket workspace and node-sync behavior.

## Stages

- Workspace Detection: reused completed brownfield analysis.
- Reverse Engineering: reused current architecture artifacts and direct source inspection.
- Requirements Analysis: completed at standard depth in `ticket-synced-workspaces.md`.
- User Stories: skipped. One operator workflow and explicit acceptance criteria are sufficient.
- Application Design: skipped. One filesystem module extends existing task and Syncthing services.
- Units Generation: skipped. One cohesive ticket workspace unit.
- Functional/NFR/Infrastructure Design: skipped. Existing filesystem, Syncthing, ownership, and native-service boundaries remain.
- Code Generation: execute test-first.
- Build and Test: execute full project validation.

## Change sequence

1. Add failing integration and API-contract tests for Git-free workspace creation, filtered copy, cleanup, stable Syncthing folder setup, handoff readiness, and archive behavior.
2. Add the ticket workspace filesystem module.
3. Configure and share the ticket Syncthing folder during startup and peer reconciliation.
4. Create synchronized workspaces for new tickets and derive destination-local paths during handoff.
5. Add archive/delete workspace cleanup and update task prompts and board actions.
6. Document the new behavior and run all required validation.

## Success criteria

- Git is absent from the new-ticket execution path.
- Every cluster node receives the same ticket workspace folder through Syncthing.
- Ownership handoff waits for a complete local workspace.
- Archive and delete remove synchronized files.
- Legacy Git tickets continue working.
