# Peer Cluster and Task Handoff Code Generation Plan

1. Add `src/cluster.ts` for node/peer persistence, peer HTTP requests, and inventory types.
2. Add `src/handoffs.ts` for immutable manifest validation, SHA-256 digests, Git checkpoint/bundle operations, and Syncthing completion polling.
3. Extend `src/types.ts`, `src/tasks.ts`, and `src/worktrees.ts` with owner/lease metadata and node-local worktree paths.
4. Add `/api/cluster/*` endpoints in `src/server.ts` for identity, pairing, inventory, and transfer operations.
5. Extend task lifecycle so only the lease owner can start a task and task state broadcasts after ownership changes.
6. Add node/remote inventory and transfer controls to `public/index.html`, `public/app.js`, and `public/styles.css`; bump `public/sw.js` cache.
7. Add tests for cluster persistence, task lease enforcement, handoff manifests, and peer inventory behavior.
8. Run `npm test`, `npm run typecheck`, and `npm run build`; exercise the homeserver deployment workflow.
