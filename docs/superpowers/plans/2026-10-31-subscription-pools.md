# Subscription pools implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-owned subscription pools, cluster enforcement, secure token brokering, and failover that never replays a turn after output or tool execution.

**Architecture:** Keep pool definitions and personal selections beside provider profiles. The cluster manager stores the active pool assignment and distributes non-secret manifests to cluster members. A node obtains short-lived profile access tokens from the profile holder over the existing signed peer transport. Harnesses choose candidates and isolate each attempt so only pre-output subscription failures can advance the pool.

**Tech Stack:** TypeScript, SQLite (`node:sqlite`), Zod, existing replication and signed peer APIs, Pi model runtime, Express routes, native Playwright UI tests.

**Spec:** `docs/superpowers/specs/2026-10-31-subscription-pools-design.md`

## Global Constraints

- Prefer subscriptions from the same provider. Try another provider only when same-provider candidates cannot complete the turn.
- A cluster-assigned pool overrides members' personal profile choices for work shared through that cluster.
- The relay must let a node harness use a pool profile without storing the provider's refresh token on the relay or target node.
- After a provider change, use that provider's configured fallback model or the configured classifier's mapping.
- Retry only before assistant output or any tool execution. Once either starts, surface the failure and do not replay the prompt.
- All pool dropdowns are searchable and match the existing Settings controls.
- Pools contain only profiles owned by their creator; a shared pool grants those profiles only to work shared through the assigned cluster.
- Push replication changes and pull on startup/join. Do not add polling.
- Pi supports cross-provider failover. Claude Code stays Claude-only; Kiro is unsupported.
- Quota failure is per turn; do not permanently disable a pool member.

## Review Focus

- Cross-account profile or pool IDs must be rejected; test in Task 1's ownership and selection tests.
- A stale assignment, removed cluster member, or revoked profile share must not obtain a token; test in Task 2's signed two-node route tests.
- Missing, expired, or unreachable credentials must advance to the next eligible profile without using ambient credentials; test in Task 3's broker cases.
- A quota/auth failure after assistant text or a tool begins must never replay; test in Task 3's harness attempt tests.
- Conflicting cluster pools, unsupported providers, and out-of-date cluster peers must fail closed; test in Tasks 2 and 3.

---

### Task 1: Pool storage and user selections

**Files:**
- Create: `src/provider-profiles/pools.ts`
- Modify: `src/provider-profiles/store.ts`
- Modify: `src/provider-profiles/service.ts`
- Modify: `src/replication.ts`
- Modify: `src/server/replication-v2.ts`
- Test: `test/subscription-pools.test.ts`
- Extend: `test/provider-profiles.test.ts`

**Interfaces:**
- Consumes: existing `ProviderProfile`, `ProfileScope`, `ProfileUsage`, SQLite replication stamps.
- Produces:
  - `SubscriptionPool = { id, owner, name, members: Array<{ profileId, position }>, fallbackModels, createdAt, updatedAt }`.
  - `createSubscriptionPool(owner: string, input: unknown): SubscriptionPool`.
  - `getSubscriptionPool(owner: string, id: string): SubscriptionPool` and `listSubscriptionPools(owner: string): SubscriptionPool[]`.
  - `updateSubscriptionPool(owner: string, id: string, input: unknown): SubscriptionPool`.
  - `deleteSubscriptionPool(owner: string, id: string): void`.
  - `resolveSubscriptionChoice(owner: string, provider: ProfileProvider, scope: ProfileScope, usage: ProfileUsage): { kind: "profile"; profile: ProviderProfile; source: ProfileSelection["scope"] } | { kind: "pool"; pool: SubscriptionPool; source: ProfileSelection["scope"] } | undefined`.
  - `setSubscriptionPoolSelection(owner: string, input: unknown): void`.
  - `poolCandidates(pool: SubscriptionPool, preferredProvider: ProfileProvider): ProviderProfile[]`, preserving pool order within same-provider candidates, then appending other providers in pool order.
  - `applySubscriptionPoolEvent(db: DatabaseSync, event: ReplicationEvent): boolean` and a pool-selection event applier, scoped to the owner's twins only.

- [x] **Step 1: Write failing store tests** for pool creation/edit/deletion, empty pool rejection, stable member order, owner isolation, provider validation, fallback-model validation, and profile-or-pool choices across conversation → project → workspace → default scopes.
- [x] **Step 2: Run `npm run test:file -- test/subscription-pools.test.ts test/provider-profiles.test.ts`** and confirm the new pool tests fail because the pool store and selection kind do not exist.
- [x] **Step 3: Implement pool tables and migration** in `src/provider-profiles/pools.ts`; extend selection persistence so one scope contains either a profile or a pool, and deleting an in-use profile/pool remains refused. Add event appliers and twin-only/version-gated event scopes in `src/replication.ts` and `src/server/replication-v2.ts`.
- [x] **Step 4: Implement the resolution interfaces** in `src/provider-profiles/pools.ts` and keep legacy profile-only selection reads compatible in `src/provider-profiles/store.ts`.
- [x] **Step 5: Re-run the focused tests** and confirm pool CRUD, ownership, ordering, selection precedence, and provider ordering pass.

### Task 2: Cluster assignment, manifest sync, and access control

**Files:**
- Create: `src/provider-profiles/pool-sharing.ts`
- Modify: `src/cluster-membership.ts`
- Modify: `src/replication.ts`
- Modify: `src/server/cluster-hubs.ts`
- Modify: `src/server/cluster-v2.ts`
- Modify: `src/server/replication-v2.ts`
- Modify: `src/server/routes/cluster-v2.ts`
- Modify: `src/server/routes/provider-profiles.ts`
- Test: `test/subscription-pools-cluster.test.ts`
- Test: `test/subscription-pools-cluster-api.test.ts`
- Extend: `test/cluster-membership-wire.test.ts`

**Interfaces:**
- Consumes: Task 1 pool records, `clusterV2Database`, `accountInCluster`, signed `signedPeerPost`, `replicationPeers`.
- Produces:
  - Manager-owned, revisioned cluster assignment records and `resolveClusterSubscriptionPools(db, projectId)`; callers reject conflicting pool IDs.
  - Cluster-scoped manifest events delivered by existing hub relays, with one pull after startup/join and no credential fields.
  - A membership feature handshake: assignment checks every current member; an invitation for an active-pool cluster requires the joining node's pool protocol.
  - Pool-owner-only assign, refresh, and clear routes; profile edits publish updated manifests through the manager.
  - Signed token brokering that revalidates the current assignment and requester membership at the manager, then returns a short-lived access token without a refresh token.

- [x] **Step 1: Write failing store/route tests** for manager-only assignment, pool-owner consent, cluster-scoped manifest visibility, shared-project resolution, conflicting assignments, member removal, stale assignment, and signed token authorization/revocation.
- [x] **Step 2: Run focused tests** and confirm the initial assignment tests fail before implementation.
- [x] **Step 3: Implement revisioned assignment/tombstone storage** in `src/provider-profiles/pool-sharing.ts`; manager routes accept only a current member who owns the active pool, one assignment per cluster, and only after every current member answers the capability check. Publish manifest refreshes and clear operations through that same manager.
- [x] **Step 4: Add signed cluster-scope routing** in `src/replication.ts`, `src/server/replication-v2.ts`, and `src/server/cluster-hubs.ts`; keep events out of unrelated twins/clusters, use push on change, and pull one signed current assignment after join.
- [x] **Step 5: Gate new members with invitation `requiredFeatures`**, preserving old invitation shape when no pool is assigned; reject an old join request when an active pool requires pool protocol support.
- [x] **Step 6: Add signed token brokering** in `src/server/routes/provider-profiles.ts`: require current membership, current manager authorization, active pool membership, profile-owner account membership, and local profile ownership; return only short-lived access credentials.
- [x] **Step 7: Re-run focused suites** and verify owner consent, member-removal revocation, stale assignment denial, credential-free manifests, feature-gated invites, signed token denial/refresh, and join-time assignment catch-up.

### Task 3: Pool execution and safe failover

**Files:**
- Create: `src/provider-profiles/pool-execution.ts`
- Modify: `src/provider-profiles/service.ts`
- Modify: `src/provider-profiles/execution.ts`
- Modify: `src/provider-profiles/pi.ts`
- Modify: `src/provider-profiles/twin-login.ts`
- Modify: `src/pi-service.ts`
- Modify: `src/harnesses/pi/runtime.ts`
- Modify: `src/harnesses/claude/runtime.ts`
- Modify: `src/server/harness-chat.ts`
- Test: `test/subscription-pools-execution.test.ts`
- Extend: `test/harness-chat.test.ts`

**Interfaces:**
- Consumes: Task 1 `SubscriptionPool`, Task 2 cluster resolution and token broker.
- Produces:
  - `PoolAttemptFailure extends Error` with `reason: "quota" | "auth" | "unavailable" | "other"` and `started: boolean`.
  - `runSubscriptionPool<T>(pool: SubscriptionPool, preferredProvider: ProfileProvider, attempt: (profile: ProviderProfile, modelSettings: HarnessModelSettings) => Promise<T>): Promise<T>`, where the attempt callback reports `PoolAttemptFailure`; only recognized subscription failures with `started === false` advance to another candidate.
  - A provider-to-model resolver that uses the classifier mapping for the current difficulty when available, otherwise the pool's fallback model for that provider.
  - Pi credentials for both Claude/Anthropic and OpenAI Codex profiles. Claude Code remains same-provider only.

- [x] **Step 1: Write execution tests** for same-provider-first ordering, cross-provider model selection, each candidate attempted once, token expiry/source failure, and no ambient-key fallback.
- [x] **Step 2: Add retry-safety tests** where a pre-output quota error advances and restores the exact pre-turn transcript, while any assistant output event, tool start, or user cancellation prevents retry. Verify a quota failure does not disable that profile on the next turn.
- [x] **Step 3: Run `npm run test:file -- test/subscription-pools-execution.test.ts test/harness-chat.test.ts`**; all focused execution and harness-chat tests passed (10/10).
- [x] **Step 4: Implement provider-specific error classification and the ordered retry loop** in `src/provider-profiles/pool-execution.ts`; leave generic failures and all post-output/tool failures untouched.
- [x] **Step 5: Extend Pi credential routing** in `src/provider-profiles/pi.ts` and `src/pi-service.ts` so the selected Claude/Anthropic or Codex profile is used only for that provider. Borrow cross-node access tokens through Task 2's signed route.
- [x] **Step 6: Add attempt checkpoint/restore at the harness boundary** in `src/harnesses/pi/runtime.ts` and `src/harnesses/claude/runtime.ts`; commit only the successful attempt's transcript and model attribution.
- [x] **Step 7: Apply the effective cluster pool before personal selection** in `src/server/harness-chat.ts`; reject conflicting pools and preserve the user's saved model choice when providers match.
- [x] **Step 8: Re-run the focused execution suites** and inspect transcript history to confirm one user message and no failed-attempt artifacts.

### Task 4: Settings UI and end-to-end verification

**Files:**
- Modify: `public/app/provider-profiles.js`
- Modify: `public/styles.css` only if the existing searchable-select styles do not cover pool cards.
- Modify: `public/sw.js` to bump `CACHE_NAME` with frontend shell changes.
- Modify: `docs/provider-profiles.md`
- Test: `test/ui/ui-subscription-pools.test.ts`
- Extend: `test/ui/ui-provider-profiles.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 pool/assignment APIs.
- Produces: pool management, personal selection, cluster assignment, and fallback-model controls using `createSearchableSelect` from `public/app/searchable-select.js`.

- [x] **Step 1: Write the browser journey** for creating/editing/deleting a pool, searching all pool selectors, choosing a pool in personal settings, assigning it to a cluster, and seeing the cluster override.
- [x] **Step 2: Run `npm run test:file -- test/ui/ui-subscription-pools.test.ts test/ui/ui-provider-profiles.test.ts`**; the journey initially failed because pool controls were absent.
- [x] **Step 3: Implement the pool and cluster controls** in `public/app/provider-profiles.js` using the existing searchable-select component and Settings card styling. Keep pagination consistent with existing profile lists.
- [x] **Step 4: Update the service worker cache version and provider-profile help text**; document pool ownership, cluster-only access, failover limits, and relay token handling.
- [x] **Step 5: Re-run the focused browser journey** and verify searches, validation, cluster override, and error messages in the rendered UI (2/2 tests passed).

### Task 5: Full verification

**Files:** no additional production files; test and documentation fixes only.

- [x] Run `npm run typecheck`.
- [ ] Run `npm test` — attempted; the harness timed out after 600 seconds before a final summary.
- [x] Run `npm run build`.
- [ ] Run `npm run test:ui` using the repository's isolated Chrome harness from `TESTING.md` — attempted; the harness timed out after 600 seconds before a final summary. The focused pool/provider UI tests passed (2/2).
- [ ] Run `git diff --check` and review the final diff against this spec. `git diff --check` passed; final review is pending. Keep all pre-existing unrelated checkout changes untouched.
