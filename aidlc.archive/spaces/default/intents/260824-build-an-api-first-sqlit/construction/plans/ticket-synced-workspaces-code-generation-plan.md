# Ticket synchronized workspace code generation plan

## Unit context

One unit replaces Git-mandatory ticket creation with a deterministic filesystem workspace inside one cluster-wide Syncthing folder. Existing task ownership, replication, and legacy Git ticket support remain.

## Steps

- [x] Step 1: Add failing integration and contract tests for non-Git ticket creation, filtered project copying, deterministic workspace paths, cleanup, ticket Syncthing folder configuration, ownership handoff, archive behavior, and legacy merge visibility.
- [x] Step 2: Add `src/task-workspaces.ts` using Node.js filesystem APIs for path derivation, filtered copy, existence checks, and removal.
- [x] Step 3: Extend Syncthing startup and peer reconciliation to create and share `joint-bob-ticket-workspaces` at `~/joint-bob-tickets`.
- [x] Step 4: Create synchronized workspaces for new tickets without invoking Git and preserve legacy Git task fields.
- [x] Step 5: Make handoff eligibility wait for the ticket folder and destination-local workspace; skip Git bundles for synchronized tickets.
- [x] Step 6: Add archive and delete cleanup while rejecting active or pending tasks.
- [x] Step 7: Update task prompts and board actions for synchronized workspaces while keeping legacy Git merge support.
- [x] Step 8: Update README and PWA cache when frontend shell behavior changes.
- [x] Step 9: Run focused tests, `npm run typecheck`, `npm test`, and `npm run build`.

## Validation

- `node --import tsx --test test/ticket-workspaces.test.ts`
- `node --import tsx --test test/syncthing.test.ts`
- `node --import tsx --test test/task-handoff-worktree.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
