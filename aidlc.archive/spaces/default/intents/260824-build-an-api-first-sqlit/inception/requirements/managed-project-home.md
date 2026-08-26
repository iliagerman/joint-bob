# Managed project home requirements

## Goal

Give every node one selectable Joint Bob home directory. New projects and board-card workspaces use deterministic subdirectories beneath it, while `.git` metadata and secrets never synchronize.

## Functional requirements

1. Settings exposes one **Joint Bob home folder** picker. Default: `~/JointBob`.
2. New projects default to `<home>/projects/<personal|work>/<project-name>` and synchronize through the existing per-project Syncthing folder flow.
3. Imported peer projects auto-map beneath the destination node's selected home by project type. Legacy explicit mappings remain supported.
4. Every new board card gets exactly one workspace at `<home>/tickets/<project-id>/<task-id>`.
5. Ticket archive/delete removes that card workspace through the existing synchronized deletion flow.
6. The managed home contains Git ignore rules for `projects/` and `tickets/`, preventing an ancestor repository from tracking managed workspaces.
7. Ticket snapshots exclude root and nested `.git` files/directories. Syncthing ignores root and nested `.git` metadata and contents for every managed folder.
8. Changing the home updates the managed ticket Syncthing folder path when safe. A home change must fail before persistence when existing ticket workspace contents would be orphaned.
9. Existing projects remain at their current paths until explicitly imported or moved. This change must not silently move user files.
10. Existing project-scoped GitHub credential replication remains encrypted and separate from Syncthing.

## UI requirements

- Replace separate personal, work, and automatic mapping root controls with one home-folder input and Browse button.
- Explain the derived `projects/` and `tickets/` locations.
- New-project UI previews the derived path, defaults synchronization on, and does not require manual path selection.
- Keep keyboard access, labels, and `data-testid` attributes.
- Bump the service-worker cache after shell changes.

## Compatibility

- Keep explicit project paths accepted by the API for legacy clients and imported external folders.
- Preserve legacy Git-backed ticket bundle/merge behavior.
- Keep `JOINT_BOB_TICKET_ROOT` as a test/operator override.
- Do not synchronize credentials, `.git`, dependencies, build output, logs, or environment files.
