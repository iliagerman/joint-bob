# Multiple clusters, selective sharing, and twin nodes

## Status

Planning completed in [CLUSTER-SHARING-DESIGN.md](CLUSTER-SHARING-DESIGN.md). That document is authoritative for protocol, file strategy, migration, UI contracts, and delivery sequencing. Implementation remains incomplete. Do not merge, release, or push the current partial implementation as the requested feature.

Worktree: `/Users/iliagerman/JointBob/.worktrees/cluster-sharing`, detached from `b0a881c4d5118ad13c50f4646079309143a9f868`. No branch was created. The original checkout contains unrelated concurrent work and must remain untouched.

Implementation now includes isolated policy, identity, signed-request, and twin lifecycle modules:
- `src/cluster-sharing-policy.ts`
- `src/cluster-identity.ts`
- `src/cluster-protocol.ts`
- `src/cluster-twins.ts`
- `test/cluster-sharing-policy.test.ts`
- `test/cluster-sharing-membership.test.ts`
- `test/cluster-protocol.test.ts`
- `test/cluster-twins.test.ts`
- `src/cluster-membership.ts`
- `src/cluster-v2-store.ts`
- `test/cluster-membership-wire.test.ts`
- `test/cluster-v2-http-auth.test.ts`

Production-source middleware now includes signed v2 authentication, fresh-node selective-mode gating, membership-only HTTP operations, and durable membership maintenance. Manager-transfer HTTP integration is under acceptance review. Legacy mutation/bearer paths are disabled after selective activation; SQLite triggers prevent legacy peer insertion/update after activation. Legacy-paired nodes must migrate before activation. Resource HTTP/store integration, scoped synchronization, secrets, migration, and UI remain incomplete. The Mac and Homeserver have NOT been converted to twins.

The policy now rejects twin sharing administration, derives all ticket access from an immutable parent project, and implements admission seniority and a local single-manager prepare/accept/commit transaction. Identity keys are encrypted locally; signed requests bind sender, recipient, method, exact target, raw body, timestamp, and a durable consumed nonce. Twin certificates require explicit local acceptance and both participant signatures. These are foundations, not completed distributed integration. Signed same-manager membership snapshots and membership-only redemption now exist internally. The local re-admission consent bypass found in review is fixed and independently verified. Signed manager transfer and context-bound owner policy generations/outbox are now implemented internally; HTTP manager acceptance and resource security review are still in progress. Scoped replication, migration and UI remain unimplemented.

The user authorized implementation, validation, commit, and push of the complete feature, with AI-DLC skipped for this request. The previously active Homeserver browser-login workflow was parked through the AI-DLC tool before feature work.

## Active goal continuation: complete, commit and push to main

User now explicitly set an autonomous Joint Bob goal to finish the mission and commit/push to main. No partial-feature push. Parent PI_MODEL verified gpt-6-astra; guarded Sol implementation uses gpt-5.6-sol, low reasoning.

Completed receiver update authorization and signed local preparation:
- New `src/twin-updates.ts` checks the exact active direct relationship and authenticated peer.
- Signed `/api/cluster/v2/update/install` checks authorization before eligibility/feed and rechecks after awaited feed lookup. Legacy bearer install and preparation are forbidden.
- Signed `/api/cluster/v2/update/prepare` permits only self identity. New `src/update-preparation-client.ts` and native installer use it without bearer/401/404 fallback. Controlled old-version bootstrap must prepare and stop the old service using its installed version before installing this protocol.
- HTTP authentication pins only its own trusted generated identity for self verification; preparation remains idempotent while fenced and does not activate selective mode.
- Existing cluster/recovery tests migrated to signed self preparation, without dropping recovery/fence assertions.
- Missing twin guard mutation yielded409 instead403 for transitive/wrong/revoked callers; missing self guard yielded200 instead403 for an active twin preparing another node. Both source files restored; parent cmp confirmed exact restoration.
- Implementation task d381d94f-c500-4630-a4ee-ffb834c0ea01 completed. Repair/proof task84b0cbfe-fe1a-45b5-bacd-d466972f8761 completed with50+3 passes andtypecheck/build.
- Parent independent task7265532b-bab9-4441-963a-b06d000ab4d7 passed31 tests, typecheck/build. Log `/tmp/twin-update-receiver-independent.log`.

ACTIVE sender task:24c71a97-b356-4e07-9373-3756d1866b61. Brief `/tmp/twin-update-sender-implementation.md`. Allowed src/updater.ts, src/twin-updates.ts, test/twin-update-fleet.test.ts, test/cluster-sanity.test.ts. Do not relaunch; inspect completion. Adds direct-twin targets, signed dispatch, post-health revocation check, exact ack and concurrent-start exclusion. UI target inventory and receiver feed-race proof remain after it.

Designated-executor manual UI verification completed for canvas:
- Disposable `npm run dev:local` under `.dev-env`, empty inherited environment except PATH and explicit fixture settings, loopback8791. Created two synthetic clusters/projects and checked each selection exposes only its project.
- Explicit Mac executor/profile used. A no-profile discovery request failed because Homeserver returned502; explicit same Mac profile continued successfully, with no machine fallback.
- Research/Operations assertions returned passed:true. Screenshot inspected: `.dev-env/cluster-canvas-desktop.png`.
- Browser profile9fc45433-a543-4e20-89d5-071e155e0bc5 closed explicitly, restoreOnRestart:false. Preview task56f42baf-6476-4f56-a9b7-fdabd5ab2da0 stop requested; verify stopped before restarting/cleanup. Screenshot/fixtures are ignored local artifacts, not release files.
- Discovered production machine IDs through browser status only: Mac27adb497-52db-4c3b-bdf4-87d26ddc3c19; Homeserveraea53035-6e54-4ad6-b9ba-16cb28b2e57b. This is NOT twin verification, adoption or rollout.

Main is newer: localmain74d1675a, version1.53.0; inspected origin/mainfc4f2eac before fetch. Original checkout has unrelated AI-DLC/docs changes and must stay untouched. Reconcile committed main in isolated worktree before remaining secret/runtime work. No branches created. No feature commit/push/deployment.

## Historical continuation: finish, commit and push

Latest user instruction: **finish the implementation, commit and push**. Complete-feature release gate remains in force. The sections below contain historical failures and task statuses; this section supersedes them.

Completed since the earlier ledger:
- Resource duplicate-sender and stale-context defects fixed; 41 focused tests independently passed.
- Manager HTTP, offline successor relay, and atomic acknowledgements implemented. Narrow mutations proved acknowledgement atomicity, bootstrap authentication and completed-retry handling; production source restored exactly.
- Project creation now registers ownership/outbox atomically; local sharing GET/PUT and additive bulk sharing exist.
- Twin HTTP includes bilateral consent, signed endpoint binding, retained context-specific endpoints, bootstrap of owned policies, durable revocation, and isolation from independent memberships.
- Unseen revocations now retain non-adopting tombstones; deletion is owner-scoped and terminal across contexts. Three regressions failed before the fix, then 44 focused tests passed.
- Full suite then found one real store import-order regression: 1338 passed, 1 failed (`no such table: cluster_node`), log `/tmp/cluster-sharing-integrated-full.log`. Pure mode state was extracted into `src/cluster-v2-mode-state.ts`; unchanged failing test now passes.
- Twin acceptance now rejects a valid certificate for a different relationship rather than reporting false success. Regression observed 201 instead of503 before repair.
- Parent independently reran node-project-sync, twin HTTP and unseen-revocation tests: **14 passed**, plus typecheck and build. Full suite must be rerun after remaining implementation; no claim that overall validation is green.

Current supervised work (inspect outputs, never rerun completed launches):
- `a0e62f8b-e294-4e0d-b24d-4b1a90f73aab`: policy HTTP transport and exact durable acknowledgements. Brief `/tmp/cluster-sharing-policy-transport-brief.md`.
- `5c68990b-3e6f-4aa0-9a48-026118f567a0`: tests-first for membership-triggered resource bootstrap/revocation/atomicity. Brief `/tmp/cluster-sharing-topology-red-brief.md`. Expected RED; no production edits.

Next: review policy transport; implement observed topology regressions inside existing membership transactions; then resource metadata bootstrap/change delivery, ownership-preserving imports, ticket/secret lifecycle and scoped credential projection, filesystem isolation, migration, UI and complete gates. Policy delivery alone is NOT content replication. Keep metadata and file synchronization tied to original-owner/source-context authorization, not blanket folders. Historical endpoint records are needed for departed-peer tombstones. Unknown-resource revocation after a departed admission also needs verified historical context handling, without granting access or adopting ownership.

No feature commit, push, deployment, or production pairing/migration occurred. Preserve original checkout and do not commit the `node_modules` symlink.

## Latest continuation: canvas and twin-only updates

User approved additional repair passes. User then explicitly required a multi-cluster Settings canvas with click-through contents, remote version updates restricted to twins, and verified Mac/Homeserver twin pairing for rollout. These requirements are now in the design. No production pairing or rollout has happened.

Completed metadata security proofs after approval:
- New real-node sender-forgery case: another admitted member's forged metadata is403; same original-owner request is200; state unchanged on denial. Removing sender check produced200 instead403, then source restored byte-identically.
- New version/protocol case: cookie-only401, extra path400, invalid inner signature401; stale metadata cannot roll back newer state; same-version conflicts409. Narrow mutations detected stale native-name rollback and missing409. Source restored byte-identically.
- Native reconstruction/private-workspace-reuse case was added. The user's interruption occurred during temporary workspace-guard mutation. Parent inspected the exact diff, restored the single `false &&` guard mutation, and confirmed `src/store.ts` byte-identical to `/tmp/cluster-metadata-reconstruction-before-store.ts`. All four boundary tests passed independently, `/tmp/cluster-metadata-post-interruption.log`. Do not claim all interrupted mutation checks completed: no final coder result exists for that invocation.
- Receipt-failure atomic rollback proof remains outstanding.

Implemented Settings canvas:
- `public/app/cluster-canvas.js` native selectable buttons and SVG member diagrams, selected-cluster member/project detail, desktop/mobile layout.
- Membership-only create/join/invite, per-membership auto-share, explicit owned-project bulk sharing and selected-membership leave. No destructive replacement join or invitation project checkboxes.
- `GET /api/clusters` adds member names/URLs from verified snapshots.
- Browser-machine section retained; legacy pairing is read-only pending migration. Manager-transfer/removal/twin management UI still needs completion.
- Service-worker shell includes new module, literal cache bumpedv203 and matching pins updated.
- A delayed real invitation response originally showed the old cluster's link after selection changed. New browser assertion observed RED, then request/selection invalidation fixed it.
- Legacy secret-sync empty state, test ID and partial-failure reporting restored after review caught unrelated omissions.
- Ported only the existing main-branch classification max-width fix because the older feature base failed its existing browser assertion. No unrelated original-checkout changes touched.

Independent checks:
- Canvas/membership browser + API/source regression batch:20 passed, typecheck/build passed, `/tmp/cluster-canvas-independent.log`.
- Existing smoke + two-node browser regression:50 passed, `/tmp/cluster-canvas-ui-regression.log`.
- Full `npm test`:1354 passed, no failures/skips, `/tmp/cluster-canvas-full.log` (before next updater tests are added).
- Full UI first attempt:176/193, mostly missing bundled Chromium under disposable HOME. Existing tests support CHROME_PATH; use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, no download or real profile. Classification failure was the known main fix described above.
- Full UI with explicit installed Chrome and CSS correction:192/193, one `database is locked` in ui-notification-links fixture. Focused unchanged rerun passed1/1. Logs `/tmp/cluster-canvas-full-ui-final.log`, `/tmp/cluster-canvas-notification-recheck.log`. Do not claim a completely green full UI run.
- Codemirror app-shell URLs are served from node_modules/codemirror by existing core route, not public/vendor; corrected asset validation passed. Manual designated-executor dev-site inspection remains outstanding.

Completed RED-test task, do not relaunch:
- `17f6dc73-4e7e-4917-9dca-224ffb8f8d76`, twin-update-authorization-tests, exact writable file `test/twin-update-authorization.test.ts`. Brief `/tmp/twin-update-auth-red.md`. Expected RED tests, not implementation. Inspect output on completion and continue source work.

Updater inspection found:
- `src/updater.ts` still enumerates legacy listClusterPeers and posts shared bearer credentials to `/api/cluster/update/install`.
- `src/server/routes/updates.ts` still treats machine authentication as sufficient update/preparation authority.
- `scripts/install-service.sh` calls legacy bearer `/api/update/prepare`, which selective mode currently rejects even for local preparation. New twin-only protocol must fix local preparation and staged bootstrap compatibility too, not merely hide UI buttons.
- Planned signed route `/api/cluster/v2/update/install` with explicit relationshipId/version; validate direct active relationship and sender before eligibility/feed and again after awaited feed lookup, enumerate only direct active twins, recheck each target before dispatch. Preserve local human self-update. Never infer twin trust from membership or names; no transitive trust or legacy bearer fallback for remote updates.
- Production bootstrap on old protocol nodes needs controlled per-node migration before automated twin fleet rollout. Verify actual Mac/Homeserver IDs and reciprocal active certificates before that rollout.

No commit, push, deployment, production migration or pairing. Full feature remains incomplete: updater authorization/local preparation, secret/ticket lifecycle, content/files/transcripts, import/copy ownership, migration, remaining management/filter UI and end-to-end gates.

## Metadata continuation after renewed request to complete the feature

No background worker remains running for this continuation. The stopped metadata-test task wrote no test file; a fresh foreground guarded Sol invocation subsequently created `test/cluster-project-metadata-api.test.ts`. Parent model preflight was `gpt-6-astra`; coders used `openai-codex/gpt-5.6-sol`, low reasoning, exact file/check allowlists, no Git or shell tools.

The four previously listed transport/topology tasks completed. Parent independently verified their combined changes with 45 tests, typecheck and build; log `/tmp/cluster-sharing-policy-transport-independent.log`.

Added metadata-only replication:
- `src/cluster-project-metadata.ts`: portable metadata schemas, durable revision/acknowledgement/receipt state, original-owner export selection, current-context visibility.
- `src/server/project-metadata.ts`: separately signed owner-only metadata delivery with exact acknowledgements.
- `src/server/routes/resource-policy.ts`: separate signed metadata endpoint; policy-only route remains separate.
- `src/cluster-sharing.ts`: current persisted context/admission validation for metadata receipts.
- `src/store.ts`, `src/types.ts`: native inventory projection, isolated workspace/path mapping, owner fields, filtering revoked foreign projects while retaining native rows/files.
- `src/server/cluster-manager.ts`: metadata delivery after policy delivery in existing single-flight loop.
- `test/cluster-project-metadata-api.test.ts`: both real-node journeys first failed because authorized metadata never appeared. Now cover update, unshare, retention, fresh reshare and bridge/twin inventory isolation.

One implementation pass and its one focused repair were used. The coder omitted most requested security tests in BOTH passes. Do not accept the metadata work as fully verified. The repair added atomic source capture, reconstruction from highest validated metadata after native-row removal, and workspace-mapping deletion/recreation fixes, but reconstruction/private-workspace-reuse/receipt-rollback and protocol negative tests remain unproven. Required sender/version/conflict/rollback/workspace mutation proofs were NOT performed by the coder. Further repair passes need approval under the current Pi Develop workflow limit.

Parent independently reviewed the new modules and changes, then supplied valid RED evidence for the sole added atomic-capture regression. A temporary clone restored the broken capture ordering, and the retained test observed `Wanted` instead of `Concurrent`. Correct source stayed byte-identical, temporary clones were removed, and current tests passed. Log `/tmp/cluster-metadata-atomic-red-independent.log`. This supersedes the coder's invalid initial RED caused by a fixture name override.

Parent independent validation:
- Seven relevant test files: 25 passed, `/tmp/cluster-metadata-independent.log`.
- Typecheck and build passed.
- Full suite `/tmp/cluster-sharing-metadata-full.log` timed out after 600 seconds, having reached test1223. It also recorded a Claude fork socket-event timeout at test618. No complete-suite green claim.
- Focused `test/conversation-fork.test.ts` rerun: 15 passed, `/tmp/cluster-sharing-metadata-fork-recheck.log`. This does not replace the unfinished full run.

Remaining feature work still includes ticket/secret lifecycle and scoped runtime authorization, source-isolated file/transcript/content synchronization, import/copy/alias ownership protections, resource deletion integration, migration/adoption, UI/filters, distributed/browser acceptance, and reconciliation with newer main. Metadata is not file synchronization. No commit, push, deployment, or production pairing occurred. Original checkout untouched.

Briefs: `/tmp/cluster-sharing-project-metadata-red-brief.md`, `/tmp/cluster-sharing-project-metadata-implementation.md`, `/tmp/cluster-sharing-project-metadata-repair.md`.

## Historical active implementation continuation, 2026-09-17

Latest user instruction: **so finish**. Continue the remaining implementation and release gates. Background completion notifications are evidence to inspect and continue from, not a reason to stop at another partial status. No production migration/pairing, commit, push, or deployment occurred.

Parent preflight remained `gpt-6-astra`. All implementation/verification children used guarded `openai-codex/gpt-5.6-sol`, low reasoning, exact file/check allowlists and no Git/shell tools. Several children explicitly omitted requested tests; do not treat their exit0/typecheck or summary as acceptance.

Added this continuation:
- `src/cluster-v2-mode.ts`
- `src/server/cluster-v2.ts`, `src/server/routes/cluster-v2.ts`
- `src/server/cluster-manager.ts`, `src/server/routes/cluster-manager.ts`
- `src/cluster-sharing.ts`
- `test/cluster-manager-wire.test.ts`
- `test/cluster-v2-membership-api.test.ts`, `test/cluster-v2-join-retry.test.ts`
- `test/cluster-resource-policy.test.ts`, `test/cluster-resource-adversarial.test.ts`
- Manager HTTP/ack tests are being added by the active repair task; verify their existence/results.
- Modified `src/server.ts`, `src/server/http-auth.ts`, `src/server/routes/core.ts`, `src/cluster-membership.ts`.

Membership HTTP now creates independent clusters, membership-only signed links, joins without leaving another cluster, lists seniority/preferences, and routes invitation/removal requests through the sole manager. Bootstrap temporarily pins inside a transaction, verifies exact signed HTTP plus invitation capability, and rolls back invalid attempts. Durable local join attempts/results and in-process coalescing cover concurrent/restarted retries. The invitation hash excludes the secret so correcting a mistyped secret can reuse the signed pending join identity. A dedicated real two-node test verifies wrong-secret rollback, cookie/CSRF boundaries, concurrent joins, no project import, remote member invitation, conflicting request IDs and offline restart retry.

Manager wire now has signed offer, explicit successor acceptance and committed certificate, durable fences and successor-relayed certificate outbox. Review repaired stale cached-certificate acceptance, lagging observer key validation ordering, unauthorized committed retry and successor delivery after old manager goes offline. Arbitrary older-backup restoration is NOT proven by SQLite close/reopen tests and still needs startup/migration reconciliation.

Resource policy has owner CAS, context/admission-bound signed fragments, durable outbox/tombstones, effective scoped-secret subsets and forwarding guards. Review repaired owner-admission forwarding, duplicate emission, cancellation of a fresh admission's upsert, and scoped-secret revival. It is NOT yet accepted: parent independently reproduced two further failures in `test/cluster-resource-adversarial.test.ts`:
1. Exact duplicate returns before transport-sender authorization (`Missing expected exception.` for unrelated sender D).
2. `effectiveShares` unions stale X context after original owner departed X, causing valid Y update to fail `Node ... is not a member of cluster ...`.
Next focused resource fix: authorize every statement before idempotent return, and transactionally filter/invalidate effective contexts against current owner/recipient admission before rebuilding projection. Preserve legitimate owner tombstone delivery after departure, exact authorized duplicate behavior, and independent-context ordering. Do not expose resource receive HTTP until these regressions pass.

Parent independent checks this continuation:
- Manager wire + membership wire + local membership: **24 passed**.
- Resource policy + original policy + twins: **39 passed**, `/tmp/cluster-sharing-resource-independent.log` (does NOT include the two newly failing adversarial cases).
- Real join-retry + membership API + auth: **9 passed**, `/tmp/cluster-http-independent.log`.
- Parent reproduced **2 failing adversarial resource tests** after those green suites. Overall release validation is NOT green.
- Full suite/build/UI not rerun after these changes; earlier1308 result is historical only.

RED validation artifacts: `/tmp/cluster-sharing-before-resource-repair.ts` is exact prior source. Parent created temporary `src/.review-cluster-sharing.ts` and `test/.review-cluster-resource-policy.test.ts` (test differs only by import). Running current tests against prior source produced **3 semantic failures** (forwarding, fresh-admission delivery cancellation, revoked secret scope), logged `/tmp/resource-policy-before-repair-red.log`. Correct clone passed7, `/tmp/resource-policy-correct-clone.log`. A focused mutation task is testing signature/CAS guards on the temporary clone. After it completes, compare clone to current real source, check `/tmp/resource-red-proof-production.sha256`, then remove ONLY those two temporary clone files. They must never be committed.

Task ledger (use supervisor status/output, do not rerun completed tasks):
- manager wire `ea43a280-eaa3-4a7f-827a-6cb0dd5bf415`: complete
- manager wire repair `7ca031c6-cb65-4499-a2e3-4a824b7ef600`: complete
- membership HTTP `40db5d9f-4de4-4576-989c-61f3163a5231`: complete
- membership HTTP repair `2e5932a3-f006-47b4-9fc5-641f4a700a62`: complete, omitted some acceptance tests
- resource policy `df6525c1-19f3-4d86-843c-3e3fe7c59d0f`: complete
- resource repair `ffeddbb9-8dca-4e14-bbdd-5c289bda52fa`: complete, coverage incomplete
- manager HTTP `b232f4dc-2a6e-4b44-bd8f-1e09adf56781`: complete, omitted both new HTTP tests
- join HTTP verification `61099a05-d161-4f12-be38-8c9c0ea2f914`: complete, independently passed; mutation proof pending
- first resource RED proof `50c19b8c-5b84-4fc2-bd4d-09fa22eaa68f`: complete without checks because child could not perform exact copies; parent prepared clones and ran proofs instead
- resource adversarial verification `13c4f1c4-d769-4a68-bcb2-6f3cfe4a82a9`: complete; two failures reproduced independently
- manager HTTP repair `085b9955-3e1e-4870-b102-b3d751534fc5`: ACTIVE at this note; adding real two/three-node tests, completed retry behavior, unknown-transfer404, atomic certificate+covered-membership ack
- resource signature/CAS mutation proof `0b6a2ae4-21de-4f57-b227-bce2a61ef066`: ACTIVE at this note; temporary clone ONLY

Briefs all under `/tmp/cluster-sharing-`: `manager-wire-brief.md`, `manager-wire-repair.md`, `membership-http-brief.md`, `membership-http-repair.md`, `resource-policy-brief.md`, `resource-policy-repair.md`, `manager-http-brief.md`, `manager-http-repair.md`, `join-validation-brief.md`, `resource-adversarial-brief.md`, `resource-red-proof-brief.md`, `resource-mutation-brief.md`.

Next: inspect running task results; review/test manager HTTP and finish missing boundary proofs; fix the two reproduced resource defects; wire resource ownership/generations transactionally into `src/store.ts` project creation/import, ticket registration and secret lifecycle; add actual sharing routes/filtered snapshots, source-context replication/files/secrets, twin HTTP/bootstrap, migration and UI. Store `projectDatabase()` is private; new-project `saveProject` currently has no encompassing owner/outbox transaction. Reuse its same `DatabaseSync`, never open another connection mid-write. Alias resolution must precede policy checks; imports cannot relabel ownership. Resource fragment topology must reconcile membership changes, not merely existing grant rows. Context metadata/URLs for offline tombstone delivery need durable verified peer endpoint records (membership rows disappear on leave; twins currently store identity but not URL).

## Historical consent fix and deployment assessment, 2026-09-17

The user explicitly authorized the additional consent repair and requested deployment. Parent `gpt-6-astra` delegated only `src/cluster-membership.ts` and `test/cluster-membership-wire.test.ts` to guarded `openai-codex/gpt-5.6-sol`, low reasoning. Brief: `/tmp/cluster-sharing-consent-fix-brief.md`. Task `67bf58f6-9ccb-483f-b033-904eb8c732ae` completed.

New or replaced LOCAL admissions now require a matching persisted local join, including cluster, manager identity/key/epoch, request IDs and local public key. The check runs inside the existing transaction after authoritative signature verification. Same-admission updates, other members' rejoining, departures and identical retries remain allowed. Two retained regressions failed before the fix and pass after it; explicit fresh rejoin succeeds and consumes consent.

Parent reviewed the complete source/test diff and independently verified:
- Repository membership tests plus unchanged temporary exploit regression: 12 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `env -u JOINT_BOB_INSTALL_ROOT npm test`: 1308 passed, no failures/skips. Log: `/tmp/cluster-sharing-consent-fix-full.log`.

This resolves the consent defect and supersedes the failed-validation/repair-approval status in the historical continuation review below. No additional repair was required for this fix.

Deployment assessment: current local `main` is `941d3716`, release 1.42.1, ten commits ahead of this detached 1.40.1 base. Neither `src/cluster-membership.ts` nor `src/cluster-sharing-policy.ts` exists in main's tree. The original checkout still contains extensive unrelated changes, which were not touched. This is a fix to unreleased groundwork, not a patch to an existing production membership module. The full feature still lacks production membership/resource handlers, distributed manager transfer, scoped replication, migration and UI. Deployment remains withheld under this plan's complete-feature release gate. No commit, push, version change or service restart occurred.

## Historical continuation review, 2026-09-17

Parent preflight `PI_MODEL=gpt-6-astra` passed. Sol used `openai-codex/gpt-5.6-sol` with low reasoning, exact file/check allowlists and deny-git. Two implementation tasks each received one focused repair; both are complete, but the membership task is NOT accepted for production integration.

Added signed membership invitations, persisted snapshots, admission tombstones and membership delivery queue in `src/cluster-membership.ts`. Its first repair corrected secret checking on consumed retries, initial manager substitution, old-admission share retention across skipped leave/rejoin, dependent secret cleanup, and mutation during pending handoff. Nine repository membership-wire tests pass. Some newly written functions still need readable multiline formatting.

Wired exact raw-body signed authentication into actual Express middleware with the existing node-local SQLite store. Its repair closed a case-insensitive routing bypass and stopped namespace-root query parse errors from logging malformed bodies. Four HTTP tests exercise actual production middleware. No production test probe route was added.

Parent reviewed every changed file and diffs, then independently ran:
- Six focused files: 60 passed. Log `/tmp/cluster-sharing-continuation-focused.log`.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `env -u JOINT_BOB_INSTALL_ROOT npm test`: 1306 passed, zero failed/skipped. Log `/tmp/cluster-sharing-continuation-full.log`.

Independent adversarial validation then FAILED:
```sh
npm run test:file -- /tmp/cluster-sharing-consent-regression.test.ts
```
Failure: `Missing expected exception: a departed local node must require fresh local consent`.

`applyMembershipSnapshot` checks pending local acceptance only for an unknown cluster. After B explicitly leaves and applies its departure, A can sign a newer snapshot listing B at a new admission rank. B currently installs it without any new local pending join. The temporary regression uses a valid A signature, unchanged public-key pins, preserved departure tombstone and increasing rank. No malformed signature or database corruption is involved. The source remains unfixed and must not be exposed through join/snapshot HTTP handlers.

The membership task has used its single focused repair under Pi Develop. Further repair needs user approval to extend that limit. Next repair must retain the reproduced negative case in the repository, also test valid explicit rejoin and same-admission updates, and require fresh pending local consent whenever an incoming snapshot creates or changes the LOCAL admission. A different member's legitimate readmission must remain accepted without asking the local user. Keep checks, signature verification and projection updates in the same transaction.

Briefs are `/tmp/cluster-sharing-membership-wire-brief.md`, `/tmp/cluster-sharing-membership-wire-repair.md`, `/tmp/cluster-sharing-http-auth-brief.md`, `/tmp/cluster-sharing-http-auth-repair.md`, and `/tmp/cluster-sharing-consent-validation-brief.md`. All five supervised tasks completed. No task remains running, no commit/push/deployment occurred, and overall validation is NOT green despite the repository suite passing. Full feature implementation remains unfinished.

## Requirements

1. A node can belong to several independent named clusters. Joining one must never leave another.
2. Invitations establish membership only. Remove the project-selection invitation controls and server-side invitation grants.
3. After joining, a member sees resources shared into that cluster by other members.
4. An owner can share and unshare its projects with selected clusters, bulk-share existing owned projects, and move a sharing selection between clusters. This does not move files or transfer ownership.
5. Each membership has an independent auto-share-new-owned-projects setting. Enabling it is future-only unless the user also invokes bulk sharing. Disabling it preserves existing explicit shares. Importing or rediscovering a project never triggers automatic sharing.
6. All tickets, including shell tickets, are fully shared whenever their parent project is shared. Existing and future tickets, conversations, files, attachments, workspaces, and merge state inherit project access. No independent ticket sharing selection or exclusion.
7. Secret accounts have explicit replication destinations: cluster-wide, or restricted to selected projects within a selected cluster. Sharing a project never implicitly exports its attached accounts.
8. Projects and conversations have cluster filters, including All and Local/private. All conversations and tickets inherit their parent project's cluster visibility. A filter is not an authorization boundary.
9. Explicit twin-node pairing establishes direct, symmetric high trust for the two nodes' owned managed data, including projects, files, conversations, tickets, secrets, and attachments, with automatic synchronization of existing and new data.
10. Project resharing is prohibited, including by an original owner's twin. Only the original owner changes cluster destinations. Data received through another cluster never travels over a twin relationship or into a different cluster. Independently authorized recipients synchronize through the original cluster context instead.
11. Sharing revocation stops subsequent access and delivery. It does not erase files or secrets already copied outside Joint Bob's control. Do not promise remote erasure.
12. Removal authority follows immutable admission order within each cluster. Only a strictly older member can remove a younger one. Inviter, twin, and manager status never override seniority. Self-leave is separate; rejoining creates a new junior admission.
13. The original node is initially both the most senior member and sole cluster-membership-manager. The manager role is transferable without changing seniority. A fenced, persisted handoff prevents two managers from acting concurrently. Removing or leaving as active manager requires handoff first, except last-member cluster closure.

## Corrections to the earlier plan

### Do not merge ownership identities

Keep the original owner node ID on each resource. Twins replicate the original node's owned data but cannot change its cluster-sharing policy. Disconnecting a twin removes replication access without splitting an invented shared owner ID or rewriting ownership. Received cluster data is never exported through a twin link, even when that twin has independent source-cluster access.

There is no requirement proving a one-twin-per-node restriction is needed. The policy supports multiple explicitly accepted direct relationships but no transitive trust. Network implementation still needs a bilateral acceptance protocol for each relationship.

### Separate secret sharing from secret attachment

Existing attachment resolution remains workspace, project, conversation, most-specific variable wins. Replication permission does not add a new secret resolution tier. A cluster-wide share makes an account available to that cluster; it does not automatically attach it to every project there.

A project-restricted secret share requires the project to be shared in that same cluster. Removing the project's share removes its dependent secret sharing selections; restoring the project must not silently restore the secret permission.

Recipient machines control their own operating systems. Project scoping governs Joint Bob's delivery and runtime selection, not the recipient administrator's ability to reuse a raw secret once received.

### Twin exceptions

Do not copy node identity, authentication sessions, native service configuration, machine URLs, local encryption keys, runtime process state, or filesystem path assumptions. Re-encrypt secret material using the recipient node's key. Browser profiles and cookies remain pinned to the owning browser machine under the existing browser policy.

### Whole-folder synchronization is an authorization bypass

`src/server/maintenance.ts` currently calls `configureTicketWorkspacePeer` for every legacy peer. It shares `TICKET_WORKSPACE_FOLDER_ID`, `AGENT_RESOURCES_FOLDER_ID`, and all `listHarnessSyncFolders()`.

`src/server/routes/cluster-tasks.ts` accepts these managed-folder share requests before the project-grant check.

Ordinary selective clusters must not retain this broad folder access. Full owned-data replication may be used for explicitly accepted twins only, and only where a folder cannot contain externally owned restricted data. A mixed-owner transcript or workspace root cannot safely be copied merely because two nodes are twins.

Selected strategy: resource-specific Syncthing folders, per-ticket workspace boundaries, and per-conversation filesystem exports with verified native transcript import. Twins use the same boundaries with automatic eligibility, never broad mixed-owner roots. See the completed design for folder layout, authorization, conflict handling, and pending-revocation semantics. Do not implement per-peer ignore rules as a security barrier on a common replicated folder.

### Authenticate the sender, not a claimed owner

`src/server/http-auth.ts` accepts both the receiver's machine token and tokens found in the global peer table. Many callers use the receiver's token, while some use their own. Existing membership snapshots distribute peer tokens. This is unsuitable for enforcing owner-authenticated selective sharing between distinct clusters.

New cluster/twin operations need authenticated sender identity that a different member cannot impersonate, cluster-bound membership proof, and replay-safe policy versions. Do not expose the new policy setters over HTTP behind the old shared bearer credential and assume their actor argument is trustworthy.

## Implemented policy foundation

The module uses an injected `DatabaseSync`, with no network, filesystem, secret material, or new dependencies. Tables are prefixed `sharing_` and do not replace the legacy tables yet.

It supplies:
- Cluster creation and multiple memberships.
- Independent membership auto-share flags.
- Immutable resource ownership for project, ticket, secret.
- Direct twin receive eligibility, without any sharing-administration exception.
- Original-owner-only resource share replacement, additive bulk owned-project sharing, and scoped secret shares.
- Immutable ticket-parent registration and inherited project access, with direct ticket grant mutations rejected.
- Per-cluster admission sequences, seniority-based removal, five-member limits, and permanent last-member closure.
- A persisted local manager transfer with successor acceptance, epoch checking, idempotence, and atomic commit.
- Receive-permission checks and active cluster IDs for filtering.
- Membership departure and dependent secret-scope cleanup.
- SAVEPOINT-based writes that participate in caller transactions.

Topology and twin setters are trusted internal APIs. Their comments require verified invitations/snapshots or accepted twin handshakes before network callers can use them. They are not a finished authentication protocol.

No resource metadata replication versions, resource deletion tombstones, or delivery outbox have been added. The twin lifecycle separately retains signed relationship revocations. Resource versions and delivery state must be integrated transactionally with policy mutations before the policy governs live network access. Deleting a local row alone is not a distributed revocation protocol.

## Historical implementation outline

The outline below records the initial investigation. Its open-ended design instructions are superseded by `CLUSTER-SHARING-DESIGN.md`, sections 2 through 11. Follow that document's settled decisions and ordered packages for implementation.

### 1. Authenticated membership and twin protocol

Inspect and replace the relevant paths in:
- `src/cluster.ts`
- `src/server/http-auth.ts`
- `src/server/schemas.ts`
- `src/server/routes/core.ts`
- `src/server/routes/cluster.ts`
- `src/server/maintenance.ts`

Persist cluster IDs, cluster-bound invitations and memberships, sender credentials, replay/version state, and accepted twin relationships in node-local SQLite. Membership snapshots must never merge unrelated clusters or forward unrelated peer credentials. Scope the existing five-node limit per cluster. Preserve peer connectivity when another membership or twin relationship still authorizes it.

A twin handshake must show the high-trust scope explicitly and require acceptance, not infer trust from machine names, old pairing, or shared Tailscale membership. Joining a cluster imports its authorized inventory but automatically contributes none of the joining node's existing resources.

### 2. Ownership registration and legacy migration

Integrate resource registration with the real transactions in:
- `src/store.ts` and `src/types.ts`
- `src/tasks.ts` and `src/task-workspaces.ts`
- `src/secrets.ts`

Project creation plus auto-share must be atomic. Imports retain original ownership. Alias reconciliation must resolve to the same resource before permission checks, without claiming ownership from filesystem location.

Legacy clusters need an agreed cluster ID and a coordinated upgrade path. Existing per-node grants cannot be converted to a union visible to every member without widening access. Preserve legacy effective visibility until explicit reconciliation; unknown legacy owners require an adoption flow. Do not automatically grant twin access to all old peers. Reject incompatible writes rather than half-apply a new protocol on an old peer.

### 3. Resource replication, revocation, and reshare

Integrate:
- `src/replication.ts`
- `src/secret-replication.ts`
- `src/server/cluster-helpers.ts`
- `src/server/maintenance.ts`
- Runtime snapshots, push synchronization, project discovery, task handoffs, file APIs, and browser execution routes.

Every outgoing and incoming item needs verified resource provenance. Existing unscoped session-name and conversation-ownership events cannot replicate globally into unrelated clusters. Filter mixed batches per resource; disallow re-export through a bridge node.

A new share needs current-state bootstrap, not just unsent events. `eventsForPeer` currently marks blocked deliveries as delivered, so flipping a grant without resnapshotting loses state. Revocations need durable versioned tombstones, purge/cancel queued delivery, cache invalidation, and reconciliation after offline peers return. Preserve access if another cluster still grants it.

Secret replication currently supports only `operation: 'upsert'`. Add deletion/revocation semantics with provenance and versions. Preserve independently authorized copies and attachments. Never globally delete an account solely because one cluster grant ended. Do not send irrelevant project or workspace assignments alongside a permitted secret. Refresh secret resolution before the next message while preserving a running message's credential snapshot.

### 4. Scoped files and ticket synchronization

Implement the scoped transfer approach after inspecting concrete harness and ticket paths. Reconcile existing Syncthing device/folder permissions on grant changes. Do not remove a device from a folder still authorized through a different cluster or twin relationship.

All ticket contents travel together under the parent project's sharing policy. Per-ticket folders are a storage boundary only, not an independent permission. Do not use the global ticket-workspace folder to expose tickets from unshared projects. Project unshare must not delete user-owned repositories, worktrees, or transcripts. Handoffs must not bypass a revoked grant; running work needs an explicit safe settlement rule rather than silently retaining network authorization.

### 5. UI and filters

Update `public/app/cluster-panel.js`, `public/index.html`, associated element/state bindings, project/conversation list components, and secret/ticket editors.

Show named cluster memberships, seniority-ordered member lists, a single manager badge and transfer controls, membership-only invitations, per-cluster auto-share, original-owner project/secret share pickers, twin acceptance/status/disconnect, and resource owners. Received projects have no resharing controls, with no twin exception. Tickets show inherited project sharing without independent controls.

Remove invitation project checkboxes and the destructive Replace cluster join confirmation. Cluster filters must apply to actual project/conversation inventories, not only decorative badges. Add visible sync/revocation errors without displaying secret values. Bump `public/sw.js` cache name and verify every app-shell asset.

### 6. End-to-end verification and delivery

Extend `test/dev-nodes.ts` to represent at least three isolated nodes and two overlapping clusters. Add network and browser tests for:
- One node joins two clusters without merging them.
- Owner shares, adds, removes, auto-shares, and reshares projects.
- Bridging node cannot leak a resource or a credential between clusters.
- Nonowner and forged sender mutations fail.
- Secret cluster-wide/project-specific selection and runtime attachment behavior.
- Every existing and future ticket fully inherits parent-project sharing and revocation.
- Only older members remove younger members, independent of manager/inviter/twin status.
- Fenced manager transfer preserves seniority and never permits two active managers.
- Twins cannot republish received projects or carry source-cluster data over their twin link.
- Twin full replication, bilateral acceptance, direct-only trust, and revocation.
- Offline/restart/stale-event revocation and re-share bootstrap.
- Overlapping access paths survive leaving one cluster.
- UI removal of invitation project selection and functioning cluster filters.
- Syncthing/file-level isolation, not just inventory filtering.
- Legacy upgrade without broadened grants.

Tests must be seen failing against broken behavior before being retained. Run full typecheck, tests, build, UI tests, and browser verification with the documented isolated development harness. Do not configure the production Mac/Homeserver until the complete feature passes and the intended twin pairing is confirmed through the supported flow.

Only then review the entire feature diff, integrate without unrelated concurrent changes, commit, run the release gate, and push. Never create or rename a branch or force-push main.

## Verification evidence so far

Parent environment preflight: `PI_MODEL=gpt-6-astra`. Sol availability and required guard extension were checked successfully. Sol used `openai-codex/gpt-5.6-sol` with low reasoning, explicit file allowlist, and only two approved test commands. No child Git operations.

Sol initial test failed with `ERR_MODULE_NOT_FOUND` before module creation. Ten tests then passed. Parent read both files and independently reran them and typecheck.

One repair pass was used: a new noncanonical resource-ID regression first failed with Missing expected exception, then passed after validation repair. Authorization checks moved inside write savepoints. Test coverage expanded to 20 cases. Parent independently reran all 20 successfully, plus typecheck and build.

Initial full test run: 1263 passed, 3 failed out of 1266 tests. Causes investigated:
- The temporary worktree path made `runtime-settings.test.ts`'s assumed non-temporary cwd actually temporary. Worktree moved from `/tmp/joint-bob-clusters-GKP6Pi` to its current non-temporary path.
- The surrounding native service's `JOINT_BOB_INSTALL_ROOT` caused two updater launch tests to take a different path. Tests were rerun with that deployment-only environment variable removed, without changing app/test source.

Focused rerun at current path:
`env -u JOINT_BOB_INSTALL_ROOT npm run test:file -- test/runtime-settings.test.ts test/updater-launch.test.ts test/cluster-sharing-policy.test.ts`
Result: 24/24 passed.

Corrected full rerun at the current path:
`env -u JOINT_BOB_INSTALL_ROOT npm test`
Result: 1266/1266 passed, zero skipped. Parent typecheck and build also passed. These results validate the isolated policy addition against the existing suite, not the unimplemented end-to-end feature.

UI tests have not run because no UI implementation exists. No full-feature validation or live twin conversion has occurred. No feature commit or push.

Review outcome: both new source/test files read in full before and after the one repair. The internal policy is a prerequisite only. The blocking delivery finding is absent authenticated network integration, safe file/secret replication, migration, UI, and end-to-end coverage. Do not label a green policy suite as a completed feature.

Temporary implementation briefs and Sol logs are under `/tmp/joint-bob-clusters-policy*`. These are evidence for the original internal module only.

## Implementation continuation, 2026-09-17

Parent model preflight: `PI_MODEL=gpt-6-astra`. All coders used `openai-codex/gpt-5.6-sol`, low reasoning, the deny-git extension, exact file allowlists, and approved focused test/typecheck commands. The existing detached worktree was reused. No branch, feature commit, push, or production conversion occurred.

Completed and independently reviewed in this continuation:
- Corrected owner-only publishing and parent-project ticket inheritance. Focused policy suite: 23 tests.
- Added local admission seniority, removal restrictions, five-member cap, permanent closure, and manager prepare/accept/commit state. Focused membership suite: 7 tests.
- Added encrypted stable Ed25519 identities, immutable public-key pins, domain-separated signatures, recipient-bound raw-request verification, and SQLite nonce replay protection. Focused identity/protocol suite: 8 tests.
- Added explicitly accepted twin invitations, two-signature certificates, permanent signed revocation, and reconnect using a new relationship ID. Focused twin suite: 9 tests.

Parent review requested one focused repair for each of two tasks:
- Identity result validation originally ran after savepoint release, masking a corrupt persisted public key with `no such savepoint: cluster_v2_identity_create`. The new test failed before the fix and passed after validation moved before release.
- Twin certificate activation originally read relationship state before its transaction. A second SQLite connection revoked the pending relationship immediately before activation opened its write transaction; the new regression observed resurrection. All activation state checks now occur inside the transaction. Additional consumed-invitation, missing-consent, and third-party-revocation tests were observed failing against narrow temporary mutations, then passed after the mutations were removed.

Parent read the changed source/tests and full diffs, then independently ran:
- `npm run test:file -- test/cluster-twins.test.ts test/cluster-protocol.test.ts test/cluster-sharing-membership.test.ts test/cluster-sharing-policy.test.ts`: 47 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `env -u JOINT_BOB_INSTALL_ROOT npm test`: 1293 passed, zero failed or skipped. Full output: `/tmp/cluster-sharing-full-suite.log`.

No frontend changes or browser tests in this continuation. These results cover the isolated foundations and existing regression suite, not end-to-end delivery of the feature.

The complete plan remains unfinished. Next work is authenticated membership invitations and snapshots, signed cross-node manager transfer, then transactional ownership/policy generations and delivery outbox. Resource and file authorization, per-context replication, secret delivery, migration, UI, and four-node/browser acceptance remain mandatory before release. In particular, the current receive-eligibility function is not a cross-context forwarding guard, and the local manager transaction is not yet a distributed handoff protocol.

Current briefs: `/tmp/cluster-sharing-owner-ticket-brief.md`, `/tmp/cluster-sharing-membership-brief.md`, `/tmp/cluster-sharing-identity-brief.md`, `/tmp/cluster-sharing-identity-repair.md`, `/tmp/cluster-sharing-twins-brief.md`, and `/tmp/cluster-sharing-twins-repair.md`. Sol runs were supervised by the local task CLI and completed. Remaining implementation still needs exact inspected briefs under Pi Develop.
