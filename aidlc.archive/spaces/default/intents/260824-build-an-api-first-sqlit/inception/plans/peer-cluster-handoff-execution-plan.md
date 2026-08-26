# Peer Cluster and Task Handoff Execution Plan

## Scope
Multi-node inventory, trusted peer pairing, local worktree isolation, and checkpoint handoff over Tailscale/Syncthing.

## Sequence
1. Add typed node, peer, lease, and handoff records plus protected local persistence.
2. Implement authenticated node identity, pairing, health, and inventory APIs.
3. Add peer aggregation with bounded timeouts and an explicit offline/stale result.
4. Extend task records with ownership/lease and reject starts from non-owning nodes.
5. Refactor task workspace creation to use a per-node local worktree root; preserve merge behavior.
6. Add Git checkpoint/bundle import/export helpers and a hashed handoff manifest.
7. Add Syncthing completion checks and managed ignore rules that preserve only handoff artifacts.
8. Implement two-phase handoff: source checkpoint and prepare; destination verifies/imports/resumes; source releases only after acknowledgement.
9. Add cluster UI: node inventory, local/remote labels, peer pairing, remote session opening, and disabled offline transfer state.
10. Add unit tests for persistence, ownership, manifest hashing, Git command construction, Syncthing validation, and peer inventory degradation.
11. Run the full test suite, typecheck, build, then verify a Mac↔homeserver handoff in Tailscale.

## Risks
- Existing task data and worktree paths are machine-local; migration must preserve existing tasks and only use cluster behavior for paired nodes.
- Syncthing API access is optional today; handoff must fail explicitly until configured rather than guessing synchronization state.
- A remote peer cannot be trusted based only on its URL. Pairing is authorized by the existing API token and stores a peer record with restricted file permissions.
