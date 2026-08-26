# Ticket synchronized workspace requirements

## Intent analysis

- **User request**: Remove Git as a ticket prerequisite. Give every ticket a filesystem workspace under one predefined Syncthing folder shared automatically by all cluster nodes. Remove that workspace everywhere when the ticket is archived or deleted.
- **Request type**: Replacement of the ticket worktree implementation.
- **Scope**: Ticket workspace lifecycle, Syncthing configuration, task execution paths, node handoff, archive/delete behavior, board actions, tests, and operator documentation.
- **Complexity**: Moderate. Filesystem state and replicated task ownership must remain consistent during node handoff and cleanup.

## Functional requirements

1. Joint Bob creates one node-local ticket root at `~/joint-bob-tickets` and configures it as the Syncthing folder `joint-bob-ticket-workspaces`.
2. Pairing nodes automatically shares this Syncthing folder with every cluster member. No manual project mapping is required for ticket workspaces.
3. Creating a ticket does not execute Git or require a Git repository.
4. A new ticket receives the deterministic workspace `<ticket-root>/<project-id>/<ticket-id>`.
5. Ticket creation copies the current project files into the ticket workspace while excluding Git metadata, dependencies, build output, environment files, credentials, logs, and Joint Bob state.
6. Planning, implementation, review, resumed task chat, attachments, and engine switches use the ticket workspace as their working directory.
7. Task records continue to replicate through the existing authenticated SQLite outbox. Workspace files replicate through Syncthing.
8. Handoff of a synchronized-workspace ticket transfers ownership only. It does not create or transfer a Git bundle.
9. Destination eligibility requires the ticket Syncthing folder to be idle and the deterministic ticket workspace to exist locally.
10. Existing Git-backed tickets remain readable and retain their current Git-bundle handoff and merge behavior. New tickets use synchronized workspaces with no branch.
11. Archiving an idle ticket moves it to `done`, clears its active workspace metadata, and removes its synchronized workspace.
12. Deleting an idle ticket removes its synchronized workspace and then deletes the task record.
13. Syncthing propagates workspace removal to all cluster nodes.
14. The board does not offer **Merge to main** for synchronized-workspace tickets. Legacy Git-backed tickets retain the action.
15. Archive and delete reject active runs, live leases, and pending handoffs.

## Non-functional requirements

- Ticket creation and normal handoff must work when `git` is absent from `PATH`.
- Use Node.js filesystem APIs and the existing Syncthing integration. Add no dependencies.
- Keep ticket paths inside the running user's home directory.
- Never synchronize `.git`, secrets, dependency directories, or build output.
- Preserve exclusive task ownership and current two-phase handoff fencing.
- Fail visibly when Syncthing is not configured or the ticket folder is not synchronized.
- Preserve legacy Git ticket compatibility without making Git part of the new-ticket path.

## Acceptance criteria

- A ticket can be created from a non-Git project on a node without Git.
- Project files appear under the deterministic ticket workspace and excluded files do not.
- Syncthing receives one stable ticket folder configuration and adds paired device IDs.
- A synchronized ticket handoff sends no Git bundle and resolves the destination-local workspace path.
- Archive removes the workspace and retains a `done` task without workspace metadata.
- Delete removes both workspace and task.
- Legacy Git ticket tests still pass.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
