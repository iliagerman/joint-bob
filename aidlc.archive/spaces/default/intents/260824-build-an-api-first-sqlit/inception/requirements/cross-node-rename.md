# Cross-Node Rename Requirements

## Intent
Let the user rename both projects and conversations, and have those names persist across every node (Mac and homeserver).

## Current Behaviour (investigated)
- Session rename: websocket message `{type:"rename"}` -> `session.setSessionName()`. Pi engine only; `renameSessionButton.hidden = isClaude`. Not persisted outside the live Pi session.
- Project rename: does not exist. `projects.json` lives in `PI_WEB_DATA_DIR` (machine-local) with per-machine nanoid ids.
- Session titles are derived, not stored: Pi via `titleFromSession()`, Claude from the first user message prefixed `[Claude] `.
- Cross-node persistence precedent: `src/github-auth.ts` writes to `<repoRoot>/.pi-mobile-web/`, a gitignored directory inside the Syncthing-synced checkout.

## Functional Requirements
1. A project can be renamed from the project list; the new name shows on every node.
2. A conversation can be renamed from the chat view for **both** engines (Pi and Claude).
3. Renames survive server restart and propagate to the other node through the existing Syncthing-synced directory.
4. Clearing a rename restores the original derived title.
5. Renaming a Pi conversation still updates the live Pi session name so the running agent reflects it.

## Key Design Constraint — identifiers differ per node
Absolute paths and project ids are machine-specific, so they cannot key the shared store:
- **Project key**: basename of the project folder (Syncthing mirrors the folder name on both nodes).
- **Session key**: basename of the session file (a UUID for both Pi and Claude), independent of directory.

## Non-Functional
- Same file-level last-write-wins model as `github-auth.json`; no new sync machinery.
- Store contains display names only — no secrets. Directory mode 0700, file 0600.
- No new dependencies.

## Out of Scope
- Renaming the underlying folders or session files on disk.
- Conflict resolution UI for simultaneous edits on both nodes.
