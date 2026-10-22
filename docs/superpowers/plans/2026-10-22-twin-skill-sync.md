# Twin skill synchronization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Initialize Homeserver from the Mac, then synchronize managed skill additions, edits and deletions bidirectionally with offline recovery and protected relay resources.

**Architecture:** Implement a versioned, opt-in direct-twin synchronization channel beside existing selective sharing. A pure causal merge engine feeds a journaled filesystem application layer; signed, bounded manifests and digest-addressed bundles connect endpoints. Keep legacy Syncthing skill folders paused.

**Tech stack:** Existing TypeScript, SQLite, Express, validated skill bundles, signed node transport, Node test runner and isolated Playwright harness.

**Spec:** `docs/superpowers/specs/2026-10-22-twin-skill-sync-design.md`

## Global constraints

- Mac is the initial source and Homeserver is the destination; do not automatically merge the initial inventories.
- Relay-controlled skills are never exported, overwritten or deleted by this channel.
- First release allows one initialized skill-sync partner per node. Reject a second partner before scanning or changing files; ordinary twin relationships remain unrestricted.
- Destination-owned skills adopted into the baseline become non-publishing replicas. Explicitly preview/confirm withdrawal of their old destination grants, including unchanged-content collisions; preserve source grants.
- Do not mirror credentials, arbitrary native directories, project-local resources or third-party/scoped received skills outside their grants.
- Tests use disposable HOME/data directories and loopback fixture nodes, never live Mac/Homeserver skill directories.
- No network await holds `withSkillMutation`; recheck trust at application time.
- Preserve unrelated workspace/relay edits already present in this checkout. Do not create Git branches/worktrees or commit without the user's request.
- Implementation completion is not production initialization. Live initialization follows deployment and verified endpoint identities.

## Review focus

- A missing/unreadable root must not become mass deletion; test scan failure separately from an intentionally emptied valid root.
- A disconnected old twin must not resurrect tombstoned names; test reconnect after restart and explicit later reimport.
- Concurrent edit/delete preserves the edited copy without silently reviving active content; test deterministic convergence.
- Relay takeover during bundle download must prevent application of the stale twin write; test authorization and provenance rechecks.
- A third node must not obtain an unrelated received skill through a twin; test direct trust, revoked relationships and non-transitive provenance.

---

## Task 1: Persistent causal records and merge rules

**Files:**
- Create `src/twin-skill-sync.ts` for types, schema and merge decisions.
- Create `test/twin-skill-sync.test.ts`.

**Interfaces:**
- `SkillClock = Record<string, number>` with strictly positive safe-integer counters keyed by authenticated author node IDs.
- `TwinSkillVersion = { name: string; digest: string | null; clock: SkillClock; authorNodeId: string }`; null digest is a tombstone.
- `ensureTwinSkillSyncSchema(db: DatabaseSync): void` creates relationship state, versions, receipts, conflicts and pending-apply journal tables.
- `mergeTwinSkillVersions(local: TwinSkillVersion, remote: TwinSkillVersion): { active: TwinSkillVersion; conflicts: TwinSkillVersion[] }` performs deterministic causal merge and returns retained conflict versions.

- [ ] Write failing tests for newer edit, newer tombstone, identical replay, concurrent edit/edit, concurrent edit/delete, malformed clocks and clock overflow.
- [ ] Run `npm run test:file -- test/twin-skill-sync.test.ts` and confirm failure.
- [ ] Implement schema and pure merge logic. Concurrent deletion wins active state; content conflicts choose a stable digest/author ordering and retain alternatives. Merge causal knowledge so replaying a conflict does not create a new conflict repeatedly.
- [ ] Extend tests to persist/reopen records and show offline replay cannot resurrect a deleted skill; explicit reimport advances the editing node's causal counter.
- [ ] Run the unit file and `npm run typecheck`.

## Task 2: Safe scanning, initial reconciliation and journaled application

**Files:**
- Create `src/server/twin-skill-files.ts`.
- Modify `src/server/skill-sharing.ts` only at shared ownership/removal integration points.
- Modify `src/skill-sharing-files.ts` for explicit twin provenance markers.
- Create `test/twin-skill-files.test.ts`.

**Interfaces:**
- `scanTwinSkills(context): Promise<TwinSkillScan>` returns a complete validated managed inventory plus protected/excluded names. A failed or partial scan throws and emits no deletions.
- `previewTwinInitialization(source: TwinSkillScan, destination: TwinSkillScan): TwinSkillInitializationPlan` produces deterministic add/replace/remove/protected/grant-withdrawal lists and both inventory digests.
- `applyTwinSkillVersion(context, version, bundle?): Promise<TwinSkillApplyResult>` journals, backs up, validates, atomically installs/removes and acknowledges a version under the existing mutation lock.
- Context includes explicit database, local node ID, active relationship ID, root, backup/staging paths and a fresh authorization callback; tests pass disposable paths.

- [ ] Write failing tests for exact initial replacement/removal, protected relay names, independent native resources, third-party received resources, invalid bundles, modified scripts/executable bits and missing/unreadable roots.
- [ ] Run `npm run test:file -- test/twin-skill-files.test.ts` and confirm failure.
- [ ] Implement complete scans with existing bundle validation and explicit eligibility/provenance. Preserve protected differences instead of treating them as missing skills.
- [ ] Implement durable prepare/apply/ack journal recovery. After restart, complete or safely roll back incomplete work before scanning; never turn partial installation into a user edit.
- [ ] Add crash-point tests before replacement, after replacement and before receipt persistence; assert backups stay outside harness discovery and old aliases are removed on deletion.
- [ ] Teach selective refresh/native reconciliation to recognize twin provenance without adopting or independently deleting a twin replica. Route user removal of a twin-owned managed replica through a tombstone while retaining existing server-side relay ownership rejection.
- [ ] Test that owned selective grants are revoked on source deletion but receiver deletion never writes someone else's policy; verify existing local suppression semantics outside twin sync remain intact.
- [ ] Run the new file plus `test/skill-resources-api.test.ts`, `test/skill-sharing.test.ts` and the existing relay/skill-delivery tests discovered in the repository.

## Task 3: Signed transport, authorization and offline convergence

**Files:**
- Create `src/server/twin-skill-sync.ts` for protocol validation, coordinator and route registration.
- Modify `src/server/skill-sharing.ts` to register this isolated route module and call reconciliation from existing maintenance refresh/mutation paths. Avoid changing unrelated workspace code in `src/server.ts`.
- Create `test/twin-skill-sync-api.test.ts`.

**Interfaces:**
- `registerTwinSkillSyncRoutes(): void` registers admin-only preview/confirm/status/pause operations and machine-only manifest/bundle/ack operations.
- `reconcileTwinSkills(): Promise<void>` is single-flight, recovers journals, scans local changes and exchanges initialized direct-twin state.
- `POST /api/resources/skills/twin-sync/preview` accepts destination node ID; returns a bounded initialization plan token and readable changes.
- `POST /api/resources/skills/twin-sync/initialize` accepts the exact preview token and starts an idempotent, resumable initialization for that relationship.
- `GET /api/resources/skills/twin-sync` returns state, progress, conflicts and protected differences for the chosen authorized relationship.
- Machine routes under `/api/cluster/v2/skills/twin-sync/` use the existing signed request verifier and additionally require a live direct trusted-twin relationship on both endpoints. The selected source and relationship are explicit, never inferred from a label.

- [ ] Write failing two-node fixture tests for Mac-authoritative initialization and add/edit/delete in both directions, including bulk deletion and direct filesystem edits.
- [ ] Run `npm run test:file -- test/twin-skill-sync-api.test.ts` and confirm failure.
- [ ] Implement paginated/bounded manifests and digest-addressed bundles using existing skill file/count/byte limits. Validate every page and expected generation; incomplete snapshots cannot imply deletion. No unbounded whole-inventory bundle response.
- [ ] Make initialization reject stale previews, a second configured partner and source/destination changes; block destination publishing until the baseline handshake is complete. Pin destination-owned same-name collisions with existing grants: preview the affected recipients, convert provenance and withdraw only the destination-owned grants after confirmation.
- [ ] Persist state before acknowledging; retry only idempotent replication operations. Never blindly replay an interrupted administrator initialization with a different plan.
- [ ] Wire existing periodic refresh to reconciliation and app import/edit/remove notifications to prompt reconciliation. Use debounce/single-flight behavior, not overlapping timer jobs.
- [ ] Add stop/restart and offline tests, duplicate/reordered delivery, causal conflict cases, remote relay takeover during download and empty-root failure tests.
- [ ] Add an active ordinary-cluster peer and a revoked twin to prove all reads/writes are rejected while ordinary grant-filtered sharing continues. Add a three-node test for non-transitive provenance.
- [ ] Run the API file and all existing skill sharing, resource inventory and twin authorization regressions.

## Task 4: Resources UI, confirmation and end-to-end verification

**Files:**
- Modify `public/app/resources.js` to add direct-twin sync status and preview/confirm actions.
- Add scoped styles only if needed in `public/styles.css`; do not disturb existing uncommitted workspace styles.
- Create `test/ui/ui-twin-skill-sync.test.ts` using the documented isolated browser harness.

**Interfaces:**
- UI consumes the Task 3 status/preview/initialize APIs; no browser request supplies arbitrary paths or peer URLs.
- Display the selected source and destination names and IDs, add/replace/remove counts, affected destination grant withdrawals, protected differences and ongoing sync state.

- [ ] Write a failing browser journey selecting the source Mac fixture and destination Homeserver fixture, inspecting the preview, cancelling once, then confirming and observing equality.
- [ ] Run `npm run test:file -- test/ui/ui-twin-skill-sync.test.ts` and confirm failure.
- [ ] Implement node-bound previews and destructive confirmation; invalidate on node/scope changes or stale server generation. Disabled/failed loads never expose another node's state as editable.
- [ ] Test stale response after node switching, protected differences, visible conflicts and pending/offline status. Verify bulk deletion on either initialized twin disappears on the other.
- [ ] Run all new unit/API/UI tests, existing resource UI tests, `npm run typecheck`, `npm run build` and `git diff --check`.
- [ ] Run `npm test`. Report every failure or timeout explicitly; do not claim a clean suite from focused tests.
- [ ] Request independent security/concurrency review of the diff and resolve blocking findings. Leave changes uncommitted unless requested.

## Production handoff

After implementation review and deployment to both endpoints, verify that the current node is the user's Mac and the selected direct twin is Homeserver by actual node identities. Generate a fresh live preview and confirm it matches the user's authorized source direction before executing. Verify resulting manifests and ongoing sync status; report protected differences and do not claim complete equality if any remain. Do not run this destructive initialization against production from a disposable repository test.
