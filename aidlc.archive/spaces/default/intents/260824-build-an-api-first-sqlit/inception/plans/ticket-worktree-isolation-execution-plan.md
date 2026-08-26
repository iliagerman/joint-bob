# Ticket Worktree Isolation Execution Plan

## Detailed Analysis Summary
- **Transformation type**: Multi-component application enhancement within existing boundaries.
- **Primary changes**: Git worktree lifecycle service, task metadata, task execution `cwd`, merge endpoint, Kanban action.
- **User-facing changes**: Yes — merge state/action on every ticket.
- **Structural changes**: Minor — one focused Git service module.
- **Data model changes**: Compatible nullable fields on JSON task records.
- **API changes**: One merge command endpoint; task responses gain metadata.
- **Risk level**: Medium because Git mutates repositories and merge conflicts are possible.
- **Rollback complexity**: Easy for application code; created worktrees remain explicit Git state.

## Component Relationships
- `src/worktrees.ts`: owns safe Git command execution and worktree/merge rules.
- `src/tasks.ts`: persists worktree metadata and migrates legacy records.
- `src/server.ts`: coordinates ticket creation, task execution paths, and merge API.
- `src/types.ts`: defines task worktree contract.
- `public/board.js` and `public/app.js`: expose and invoke merge.
- `public/sw.js`: invalidates cached frontend shell.
- `test/`: validates Git and UI/API contracts.

## Workflow
- Workspace Detection: completed brownfield context.
- Reverse Engineering: reused existing artifacts.
- Requirements Analysis: execute at minimal/standard depth.
- User Stories: skip; one operator and explicit workflow.
- Application Design: skip; focused module and existing REST/task boundaries are sufficient.
- Units Generation: skip; one cohesive task-worktree unit.
- Functional/NFR/Infrastructure Design: skip; requirements capture Git safety and no infrastructure changes exist.
- Code Generation: execute.
- Build and Test: execute.

## Change Sequence
1. Add failing worktree and frontend contract tests.
2. Add task worktree types and Git service.
3. Persist metadata and create worktrees for new tickets.
4. route all task-specific agent/chat work through ticket `cwd`.
5. Add merge endpoint and Kanban merge action.
6. Bump PWA cache and run test/type/build validation.

## Success Criteria
- New ticket creation is isolated.
- All task phase execution uses the isolated checkout.
- Done tickets can merge committed work into `main` safely.
- Existing tickets and non-task conversations retain current behavior.
