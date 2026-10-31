# Subscription pools design

Status: proposed, awaiting review.

## Intent

Let a user group their existing subscription profiles into a pool, select that pool where they would select one profile, and share one pool with a cluster. Pool turns try a usable profile from the current provider first, then a profile from another provider if needed. Cluster assignment overrides each member's personal profile choice for work shared through that cluster.

This extends subscription profiles already stored in `src/provider-profiles/store.ts`. It does not create subscriptions or copy refresh credentials to other machines.

## Goals

- Create, edit, delete, and order pools of existing profiles.
- Select a pool at the same user scopes as a profile: default, workspace, project, or conversation.
- Assign one pool to a cluster. For projects shared through that cluster, the assigned pool overrides personal selections. Personal settings continue to apply outside those projects.
- Try profiles matching the current model provider before trying another provider. Use the selected provider's configured default model, or its configured classifier mapping, after a provider change.
- Deliver credentials to the node running the turn through the existing authenticated peer path, including relay-routed peers.
- Follow the existing Settings styling and use searchable app dropdowns for every pool selector.

## Non-goals

- Create, renew, purchase, or manage provider subscriptions.
- Use a node's ambient API key or another account when a selected pool is empty, inaccessible, or exhausted.
- Share credentials with every user on a node just because a profile is in a pool.
- Fail over Kiro or providers without existing subscription-profile support.
- Restart a turn after assistant text or a tool execution has begun.
- Keep a durable quota cooldown across turns. Each turn may recheck a profile that failed on an earlier turn.

## Decisions from the conversation

- Prefer subscriptions from the same provider. Try another provider only when same-provider candidates cannot complete the turn.
- A cluster-assigned pool overrides members' personal profile choices for work in that cluster.
- The relay must let a node harness use a pool profile without storing the provider's refresh token on the relay or target node.
- After a provider change, use that provider's configured fallback model or the configured classifier's mapping.
- Retry only before assistant output or any tool execution. Once either starts, surface the failure and do not replay the prompt.
- All pool dropdowns are searchable and match the existing Settings controls.

## Proposed behavior

### Pools and personal selection

A pool belongs to its creating account and contains only profiles owned by that account. Membership order is explicit and stable. Pools may mix Claude and OpenAI Codex profiles. Existing profile selection scopes accept either a profile or a pool; the most-specific saved scope continues to win.

The starting provider comes from the conversation's current/default model or classifier result. Within a pool, try its profiles for that provider in pool order. A successful switch to another provider changes only the current turn's model choice, not the user's saved default or profile selection.

### Cluster assignment

A cluster has at most one assigned pool. The cluster manager is authoritative for that assignment; only the pool owner may request to assign or remove their pool, and the manager verifies the caller's node belongs to the cluster. Sharing the pool is explicit and grants use of its member profiles only for projects shared through that cluster. It does not make the profiles generally available for other users' conversations or for unrelated projects. Removing the assignment, revoking a profile's cluster grant, or removing the source node from the cluster makes that profile unavailable to the cluster.

If one project is shared through multiple clusters with different assigned pools, fail closed with a visible configuration conflict. Do not choose one arbitrarily or fall back to a personal profile. A project not shared through an assigned cluster uses the user's normal selection.

Private pools and personal pool selections follow the profile's existing twin synchronization boundary. A cluster-shared pool publishes only the pool manifest and profile metadata needed for selection to that cluster's nodes. Push changes when they occur; a joining or returning node pulls missed state. Do not add polling.

### Failover and model choice

Fail over only for a recognized subscription-specific quota, revoked/cancelled login, missing profile credential, or unreachable profile source. Do not treat user cancellation, model errors, generic provider errors, or arbitrary network errors as a reason to switch accounts. Try each eligible profile at most once per turn. If all candidates fail, show an error and do not use another account.

Pi is the cross-provider path. Extend its profile credential broker so both Claude/Anthropic and OpenAI Codex profiles can back a Pi model. On provider change, keep the current classifier level and use that provider's classifier mapping when one exists. Otherwise use the pool's searchable fallback-model setting for that provider. Never reuse a model ID from the previous provider. Claude Code can try other Claude profiles but cannot switch to OpenAI mid-conversation; Kiro is outside this feature because it has no subscription profiles today.

### Credentials over the relay

The node holding a profile's sign-in remains the only node that refreshes it; a trusted twin may serve as holder under the existing profile-borrowing rules. A requesting cluster node authenticates as a cluster peer and asks the holder for a short-lived access token over the existing signed, end-to-end encrypted peer transport. The holder checks current cluster membership, the active pool assignment, and the profile grant before responding. Return no refresh token. Keep borrowed access tokens in memory only, expire them before the provider's expiry, and never put credential data in logs, replicated manifests, or persistent storage on the requester or relay.

### UI

Keep pool management within Settings → Harnesses, alongside subscription profiles. Use the app's existing searchable-select component and restrained Settings palette. Show profile provider and sign-in state in pool membership, explain same-provider-first failover, and make cluster override explicit before saving. Configure a searchable fallback model for each provider in a mixed-provider pool. A pool selector appears anywhere an existing profile selector appears.

## Acceptance checks

- Pool CRUD validates names, rejects empty pools, preserves explicit order, and prevents deleting a pool still selected or assigned.
- Selection resolution covers every existing scope and preserves profile behavior when no pool is selected.
- A cluster assignment overrides personal choices only for cluster-shared projects; multiple conflicting assignments fail closed.
- Same-provider candidates precede cross-provider candidates; each is attempted once.
- Recognized subscription failures before output/tool execution advance to the next candidate. Generic errors do not. Any failure after output or tool execution is surfaced without replay.
- Cross-provider selection uses a compatible classifier mapping or configured provider default, never a model ID from the previous provider.
- Cluster token requests reject nonmembers, unshared profiles, stale assignments, and revoked access. Refresh tokens never leave the profile owner node.
- Relay payloads contain no credentials; recipient stores no borrowed credential on disk.
- Join/startup pull and change-triggered push converge pool manifests without a timer.
- All pool-related dropdowns are searchable and use the existing Settings control style.

## Implementation calls for review

- Pools contain only profiles owned by their creator. Supporting multiple users contributing profiles to one pool needs a separate, explicit profile-grant flow.
- A cluster-shared pool exposes its member profiles to cluster work only. It never broadens the existing node-wide automation-sharing flag.
- The cluster manager is the single assignment authority; the pool creator can assign or remove their pool, and a different creator cannot replace it until it is removed.
- Pi handles cross-provider failover after its credential broker supports both existing profile types. Claude Code can try other Claude profiles but cannot switch to OpenAI mid-conversation; Kiro is unsupported.
- Failure state is per turn. A quota failure does not permanently disable a pool member.
- Conflicting cluster pools stop the turn instead of selecting one by ordering.
