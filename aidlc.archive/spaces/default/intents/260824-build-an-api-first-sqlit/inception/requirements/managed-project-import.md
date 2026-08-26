# Managed project import requirements

## Goal

Import an existing local project into the selected Joint Bob home while preserving its full node-local contents and offering explicit copy/move behavior.

## Functional requirements

1. The Add project dialog accepts an optional existing source folder and provides a node-local folder picker.
2. When a source folder is selected, the user must choose one operation:
   - **Move and leave a link**: move the complete project into `<home>/projects/<type>/<name>` and create a directory symlink at the original path.
   - **Move**: move the complete project into the managed path and remove the original path.
   - **Copy**: copy the complete project into the managed path and leave the original folder unchanged.
3. Local import preserves all source contents, including `.git`, `node_modules`, hidden files, permissions, timestamps, and symlinks.
4. Syncthing continues excluding root and nested `.git` and `node_modules` content. Those files remain available in the managed folder on the importing node.
5. Empty managed project creation remains supported when no source folder is selected.
6. Import refuses missing, non-directory, symlink source paths, already registered projects, identical/nested source and destination paths, and occupied managed destinations without modifying the source.
7. A move crossing filesystem boundaries falls back to copy followed by source removal.
8. The resulting project remains synchronized through the existing per-project Syncthing registration.
9. The source path remains a local session-discovery alias so existing conversations are still found after import.

## Safety and compatibility

- Never merge imported data into an existing managed folder.
- The original source is removed only after a complete destination copy exists.
- `.git` and `node_modules` must never synchronize to another node.
- Existing project creation and peer mapping APIs remain compatible.
