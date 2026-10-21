# Relay resources by cluster

Draft for review. No implementation authorized. [Implementation plan](../plans/2026-10-21-relay-cluster-resources.md).

## Agreed behavior

- Each relay can impose skills, MCP servers and plugins on **all clusters** or a **selected set of clusters**.
- Each conversation uses one relay + cluster route. Never combine policies from other routes, even on the same machine.
- Apply the relay's all-cluster rules plus rules matching that conversation's cluster. Different items combine; all-cluster rules win every conflict, including attempts to disable an imposed item.
- Automatically install and enable imposed items. Reconcile when policy, membership or conversation route changes.
- Remove relay-installed items once no applicable rule requires them. Never modify or remove independently installed resources.

Example: relay R imposes `security` everywhere and `frontend` on cluster A. An A conversation gets both; a B conversation gets only `security`. A's attempt to disable `security` has no effect.

## Proposed design

These implementation choices are proposals, not additional user requirements.

**Policy.** Store versioned, signed entries with resource kind, name, harness, action, content/configuration digest and target `all` or `clusterIds`. Relay admins select resources explicitly, rather than copying the relay machine's entire enabled inventory. Resolve each kind/name/harness against the all-cluster layer first, then the matching cluster layer. Reject contradictory entries within the same layer for an overlapping target.

**Conversation context.** Persist `{ relayNodeId, clusterId }` with the conversation and pass it through session creation, resume, remote execution and scheduled turns. Validate server-side against authorized membership and project access. Select automatically only when one valid route exists; otherwise require route selection before starting. Existing conversations without a uniquely established route need selection, not a union of machine memberships. A transport reconnect or direct connection must not change policy identity. A genuinely local, unrouted conversation receives no relay policy.

**Delivery and isolation.** Install verified skills, MCP configurations and plugin packages into relay-owned, route-scoped storage, not native/global resource folders. Build each session's resource configuration from its route. Same-name resources in different routes may coexist. An imposed resource can shadow an independent copy in that conversation without altering its files or saved preferences. MCP credentials remain separately authorized references, never copied from the relay's environment. Unsupported harness/resource combinations or missing required dependencies block the affected run with an actionable error.

**Authorization.** Relay admission alone must not authorize selected-cluster downloads. Register and verify signed cluster membership evidence before distributing that cluster's policy or packages; revalidate on membership updates. Never expose another cluster's configurations through policy listings or inventory APIs.

**Lifecycle.** Stage and verify updates atomically. Refresh idle sessions immediately and busy sessions before their next turn; retain files while an active turn uses them. Track relay ownership and references across applicable routes so cleanup cannot remove another conversation's required copy. Missing or invalid required resources block new turns. A disconnected node may use its last verified policy and installed files until a known revocation; reconnect reconciles changes before the next turn.

**Compatibility and controls.** Keep legacy policy behavior unchanged until an explicit migration. Preview affected conversations and convert existing enforcement to the all-cluster layer; preserve legacy restrictions rather than dropping them. Require upgraded nodes before activating scoped policies. Relay settings show scope and resource selection; conversation resources show effective items and which layer imposed them.

## Current code constraints

`src/relay/resource-policy.ts` merges policies from admitted relays machine-wide. `src/relay/skill-bundle.ts` delivers only skills; MCP/plugin delivery is new work. `HarnessOpenOptions` currently has no relay + cluster context. This needs end-to-end session isolation, not only a settings filter.

Implementation must first resolve the diverged `main` checkout with the user. No pull, reset, stash or merge is part of this document change.
