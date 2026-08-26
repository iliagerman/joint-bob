# Node Project Sync Requirements

## Intent
Make project synchronization between paired Master Bob nodes seamless while preserving an explicit, machine-local folder choice on every node.

## Functional requirements

1. Every project has one stable project ID and one stable Syncthing folder ID shared by all nodes.
2. Each node stores its own absolute local project path in a machine-local SQLite database.
3. Importing a project must never derive a local path by reversing another node's saved path.
4. When the local Syncthing instance already has the project's folder ID, import uses that configured local path automatically.
5. When no local mapping exists, import returns the project as pending and the UI asks where that node should store it.
6. The mapping UI provides a server-side folder browser for the selected node. It must not rely on the browser File System Access API for remote filesystems.
7. Confirming a mapping persists it locally, preserves the shared project ID, and makes the project available to the node.
8. Re-importing the same project preserves the node's existing local path and project identity.
9. A newly created synced project receives a stable Syncthing folder ID and is configured in the source node's Syncthing instance.
10. Existing JSON project records migrate to SQLite without deleting or rewriting the JSON source file.
11. Existing API consumers and session discovery continue to receive a local `path` and optional paired remote path during migration.
12. Missing, unreadable, or non-directory mapping targets return actionable errors.
13. Every node auto-discovers Pi and Claude runtimes from `PATH` and known user installation locations, verifies their versions, and stores explicit selections in local SQLite.
14. The Nodes UI lets the user override detected executable, configuration, and session paths with a node-filesystem picker.
15. The default deployment is a native per-user node service, not a container, so it can launch host runtimes and access user-owned projects and session stores.
16. A container deployment requires a native host helper; mounting host executables into a Linux container is not a supported runtime-discovery strategy.
17. Pi/Claude synchronization uses managed profiles: sessions, portable rules, skills, prompts, agents, and approved settings synchronize; credentials, caches, locks, logs, worktrees, binaries, and machine-specific state remain local.
18. Active session ownership is exclusive to one node at a time so Syncthing never receives concurrent writes to the same transcript.
19. Runtime version differences are visible and actionable; they are never silently ignored.
20. Users can add arbitrary configuration sync roots. Every root has a stable sync ID, a local path selected independently on each node, and a managed or custom ignore profile.
21. Cross-platform nodes are not required to share identical absolute paths and the installer must not create privileged root-level `/Users` or `/home` aliases.
22. Pi resume opens the selected session file with the destination project's local working-directory override.
23. Claude resume tracks one canonical session ID and the current owner file; handoff materializes the active transcript under the destination node's locally encoded Claude project directory before resume.
24. Node-local symlinks are optional only when an external tool requires a fixed path and no configurable root exists. Symlinks are recorded locally and never synchronized as identity.
25. Public releases provide one bootstrap command that detects macOS/Linux and installs the native node service through launchd/systemd.
26. The bootstrap installs or adopts Syncthing, generates a strong app token, discovers runtimes, starts the service, and prints the local onboarding URL.
27. Public service templates contain no personal proxy URLs, model aliases, device IDs, API keys, or machine paths; those values live in node-local SQLite or protected service state.
28. Bootstrap downloads are pinned to a release and verified by checksum before execution.

## UX requirements

- The Nodes dialog reports imported, skipped, and mapping-required projects separately.
- Pending projects open a mapping dialog one at a time.
- The folder browser shows the current node path, parent navigation, readable subdirectories, and an explicit “Use this folder” action.
- The suggested path remains editable.
- Nodes exposes “Add sync folder” with label, local path, ignore profile, and remote mapping status.
- Mapping errors render inside the open dialog above its backdrop.

## Security and operational constraints

- SQLite remains local to each node and is never synchronized.
- Syncthing API credentials remain backend-only.
- Directory browsing is limited to approved roots: the running user's home plus detected executable directories.
- Pi and Claude credentials remain machine-local and require per-node authentication when necessary.
- `.git` remains excluded from Syncthing; Git readiness is verified independently per execution node.
- Existing unrelated working-tree changes must remain untouched.

## Acceptance criteria

- JSON migration, SQLite persistence, stable import identity, and local-path preservation have automated tests.
- An import without a local mapping returns pending instead of creating the wrong directory.
- Mapping through the UI makes the project appear with the chosen local path.
- Typecheck, build, full tests, browser syntax checks, and desktop/mobile browser verification pass.
