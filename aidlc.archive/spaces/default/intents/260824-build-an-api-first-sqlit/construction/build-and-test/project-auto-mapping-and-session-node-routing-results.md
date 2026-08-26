# Project auto-mapping and session node routing results

## Built

- Added server-side folder pickers for exact project folders and node-local automatic mapping roots.
- Added login-time peer project discovery and unresolved mapping prompts.
- Added safe root-relative automatic mappings.
- Reused Syncthing-aware mapping for imports and source-initiated destination mapping.
- Task handoff now offers online unmapped nodes, opens their remote folder picker, maps/syncs, then retries handoff.
- Node, Pi/Claude, and session selectors are always visible in chat.
- Added authenticated non-task session WebSocket routing to selected nodes with stable session-ID resolution.
- Fixed the empty-conversation refresh race that disconnected a ready Pi conversation before its first message.
- Replaced ambiguous toolbar values with Runs on, Agent, Conversation, and Model labels plus a first-message ready state.
- Added a visible Continue on… flow for idle Pi conversations, including forwarding-node routing and destination mapping before transfer.
- Pi and Claude execution remains on the selected node after browser/proxy disconnect; active Claude runs can reattach.
- Persisted selected node and stable session ID in SQLite-backed preferences.

## Validation

- 139/139 tests passed, including process-isolated root-relative mapping, remote WebSocket routing, empty-conversation usability, and rejected execution-node connection handling.
- TypeScript typecheck, build, JavaScript syntax, shell syntax, and diff checks passed.
- Headless Chrome confirmed that a new Pi conversation remains connected, enables message/model/agent controls, and displays its first sent message.
- Repaired stale encrypted machine credentials on the Mac and homeserver, then verified authenticated HTTP and Pi WebSocket traffic in both directions.
- Rejected or timed-out execution-node WebSockets now show the actual failure and retry instead of remaining on "Connecting…".
- Remote WebSocket proxying now preserves text frames in both directions so browsers receive JSON strings instead of binary `Blob` values.
- Desktop and 390×844 mobile checks confirmed visible execution-node, agent, conversation, and model controls.
- Deployed release `eee1df648f0dfa392393392e42dafc378031601b` to the Mac and homeserver after mode-0600 SQLite backups.
