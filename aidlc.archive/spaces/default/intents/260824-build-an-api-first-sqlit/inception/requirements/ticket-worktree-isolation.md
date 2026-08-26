# Ticket Worktree Isolation Requirements

## Intent Analysis
- **User request**: Run every new ticket in an isolated Git worktree and provide a per-ticket action to merge completed work into `main`.
- **Request type**: Feature enhancement.
- **Scope**: Task persistence, Git process execution, task agent working directories, REST API, and Kanban UI.
- **Complexity**: Moderate.

## Functional Requirements
1. Creating a ticket creates a dedicated Git branch and worktree based on the project's local `main` branch.
2. Ticket creation fails with a useful error when the project is not a Git repository, has no local `main` branch, or Git cannot create the worktree.
3. Planning, implementation, review, resumed task chat, attachments, and engine switches for that ticket use its worktree as their working directory.
4. Every ticket card displays a **Merge to main** button.
5. Merge stays disabled until the ticket reaches `done` and remains disabled for legacy tickets without worktree metadata.
6. Merge requires both the main checkout and ticket worktree to be clean. Ticket work must already be committed.
7. Merge uses Git's normal merge operation into local `main`; conflicts or other Git failures are returned to the user without marking the ticket merged.
8. Successful merge records a merge timestamp and changes the card action to **Merged**.
9. Existing tickets remain readable and receive nullable worktree metadata during task data migration.

## Non-Functional Requirements
- Execute Git with argument arrays, never shell-interpolated commands.
- Keep worktrees outside the project checkout so they do not pollute project status or Syncthing scope.
- Do not auto-delete worktrees or branches after merge; preserve ticket history and avoid destructive cleanup.
- Preserve existing task status automation and WebSocket refresh behavior.
- Add stable `data-testid` coverage for the merge action.

## Acceptance Criteria
- Two newly created tickets have different branch names and worktree paths.
- Agent sessions for a ticket receive the ticket worktree as `cwd`.
- A non-`done` ticket cannot be merged through either UI or API.
- A dirty ticket worktree is rejected with an actionable message.
- A clean, committed ticket branch merges into local `main`, updates the task, and broadcasts `tasksChanged`.
