# Project auto-mapping and session node routing plan

1. Add failing API/process/UI tests for root-relative import, automatic discovery, destination mapping before handoff, visible harness/session/node controls, and generic remote session WebSocket routing.
2. Extend node-local settings with a project root path.
3. Include the project root in authenticated peer inventory and derive safe relative destination paths.
4. Reuse one project-mapping operation for manual import, login discovery, and source-initiated destination mapping.
5. Add authenticated proxy APIs for browsing and mapping folders on a destination node.
6. Add a server-side folder picker to project creation and project-root settings.
7. Discover peer projects after login and queue unresolved mappings.
8. Add an always-visible node/harness/session control strip and persist the selected session node in SQLite-backed preferences.
9. Proxy non-task session WebSockets to the selected node; resolve synchronized sessions by stable session ID on the destination.
10. Run focused tests, full tests, typecheck, build, browser verification, then deploy only after validation.
