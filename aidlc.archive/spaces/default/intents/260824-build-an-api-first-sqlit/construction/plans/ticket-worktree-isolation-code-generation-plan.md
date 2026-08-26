# Ticket Worktree Isolation Code Generation Plan

## Unit Context
One cohesive unit spans task persistence, Git worktree operations, agent working-directory selection, REST coordination, and Kanban controls. It depends only on Node.js standard library, installed Git, and existing Express/browser modules.

## Steps
- [x] Step 1: Add failing integration/contract tests for worktree creation, merge safety, metadata, endpoint wiring, and merge UI.
- [x] Step 2: Add nullable worktree branch/path/merge timestamp fields to `TaskRecord` and legacy task normalization.
- [x] Step 3: Create `src/worktrees.ts` using `execFile` argument arrays for branch/worktree creation and clean merge into `main`.
- [x] Step 4: Create a worktree during ticket creation and persist its metadata.
- [x] Step 5: Resolve task sessions and every task phase to the ticket worktree `cwd`, including Pi, Claude, attachments, and engine switches.
- [x] Step 6: Add the done-only merge API and persist successful merge timestamps.
- [x] Step 7: Add the per-card Merge to main action, disabled/merged states, user confirmation, error toast, and stable test ID.
- [x] Step 8: Bump the PWA cache and run tests, syntax checks, typecheck, and build.

## Validation
- `npm test`
- `node --check public/app.js`
- `node --check public/board.js`
- `npm run typecheck`
- `npm run build`
