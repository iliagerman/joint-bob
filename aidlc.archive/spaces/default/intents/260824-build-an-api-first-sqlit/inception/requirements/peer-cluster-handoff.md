# Peer Cluster and Task Handoff Requirements

## Intent
Run a full Pi Mobile Web instance on each trusted Tailscale machine. When peers are online, every instance shows the same project, task, and conversation inventory with an explicit local/remote owner label. A task can move between machines without concurrent execution.

## Decisions
- Tailscale peers communicate directly; no coordinator or public relay.
- Git is installed on Mac and homeserver.
- Every machine owns a separate local Git repository and local task worktrees. `.git`, task worktrees, dependencies, caches, build output, and secrets never synchronize through Syncthing.
- A task is the exclusive execution unit. Multiple tasks may run in separate worktrees; one task may have only one active owner.
- Transfer is a logical checkpoint, never a running process migration. The source must reach a completed agent turn or the user explicitly aborts it.
- A checkpoint commit plus Git bundle and conversation handoff manifest transfer through an allowed Syncthing handoff directory. The destination verifies Syncthing completion and artifact hashes, recreates its local worktree, and only then resumes.
- When disconnected, remote data is stale and a task cannot transfer. Split-brain ownership is surfaced as a blocker, never auto-merged.

## Functional Requirements
1. A node has a durable ID, name, public Tailscale URL, and paired trusted peers.
2. Pairing records peers on both nodes using the existing protected API channel.
3. Each UI aggregates local and online-peer project/task/session inventory, labels item location and availability, and opens remote sessions through the direct peer.
4. Node inventory reports availability, last refresh, Git availability, Syncthing availability, and running task count.
5. A task has node ownership and a lease state. A node rejects task execution without its lease.
6. A transfer creates a checkpoint only after the active agent is idle, then writes an immutable handoff manifest and bundle.
7. Handoff waits until both nodes report the configured Syncthing folder complete and validates artifact SHA-256 values.
8. Destination imports the branch bundle, creates a local worktree, resumes the session, acknowledges, and becomes the owner.
9. Source stops its runtime only after destination acknowledgement. Failures leave the source as owner.
10. Shared-project Syncthing rules exclude `.git`, dependencies, local environments, build caches, secrets, and worktree paths while allowing handoff artifacts.

## Acceptance Criteria
- With Mac and homeserver online, both UIs show the same two-node inventory and indicate Local or Remote for all discoverable items.
- A task cannot be active on both nodes.
- Two tasks can run concurrently in separate local worktrees.
- A transferred task has identical checkpoint commit and conversation context before destination execution starts.
- No `.git`, dependency, secret, or build-cache file is transferred by Syncthing.
- Offline peers are visible as stale; transfer controls are disabled.
