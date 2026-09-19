# Completed design: clusters, resource sharing, and twins

Planning status: complete for review and implementation sequencing. Feature implementation remains incomplete. This document resolves the open architectural choices in `CLUSTER-SHARING-PLAN.md` and supersedes its instructions to select a protocol or file strategy later. It does not claim the existing policy module implements the wire protocol or the UI.

## 1. Product behavior

A node has one stable machine identity and any number of independent cluster memberships. Each cluster has a stable ID, display name, and at most five members. The five-member limit does not apply to the union of all a node's peers. Different clusters may have the same display name; IDs determine authorization.

Any member can request an invitation to its cluster. Invitations contain no resource selection. Joining does not leave another cluster and does not share the joining node's resources. Members see projects and shell tickets already shared with the cluster.

Owners can share a resource with several clusters, unshare it, or move its sharing selection. Move means replace the selected cluster destinations in one policy transaction, never move directories or transfer ownership. Share all is additive for currently owned projects. Auto-share new projects is a separate membership setting, initially disabled, affecting future local project creation only. Import, rediscovery, restart, or idempotent registration must not restore a manually removed share.

Project ownership remains the original node identity. Only that original node can change the project's cluster sharing. Received projects cannot be reshared, including by the owner's twin. Twin pairing grants replication access, not project-sharing authority, and does not automatically join either node to the other's clusters. There is no transitive twin trust or implicit ownership transfer.

All tickets, including shell tickets, inherit their parent project's sharing. Sharing a project shares every existing and future ticket in full: conversation segments, attachments, baseline, workspace, and merge state. There is no independent ticket destination picker, ticket grant, or ticket exclusion. Unsharing a project removes the same access to its tickets and conversations. Tickets must resolve to a parent project before publication; an orphaned legacy ticket stays unpublished until mapped during migration.

A received resource cannot be republished into another cluster. Fork, import, alias, rename, local retention, or a twin copy must not relabel received project content as locally owned to bypass this rule. The original owner may explicitly share its own project with multiple clusters or restore a share it previously removed. This is original-owner publishing, not recipient resharing. Removing a share is not deleting the resource.

## 2. Membership authority and machine authentication

### Decision

The creating node is the original cluster-membership-manager and the most senior member. Exactly one member holds the active manager role. The manager serializes invitations and membership changes in node-local SQLite; it does not own other members' projects or relay all their files. References to a coordinator elsewhere in this document mean this single cluster-membership-manager, not a second role.

Seniority means admission order in this cluster, not machine age, application installation time, invitation creation time, or membership in another cluster. Persist an immutable increasing `joinSequence` for each admission. The creator receives sequence 1. The manager assigns later values transactionally, including concurrent joins. An idempotent join retry preserves the sequence; leaving and rejoining is a new admission with a new, younger sequence. Manager transfer preserves all admission sequences.

A member can remove another member only when its `joinSequence` is strictly lower than the target's. The authenticated requester is the actor, not the manager processing its request. Manager status, inviter status, and twin status provide no exception. The oldest member cannot be removed by a younger member. A younger manager must execute a valid senior member's removal request against another younger member, but cannot issue its own removal of an older member. Self-leave is separate from removing someone else and remains allowed.

Any member may request an invitation through the active manager. Record `invitedByNodeId` only as provenance, not removal authority. Issuing/redeeming invitations and committing membership administration require the manager online; requests made while it is unavailable stay pending or fail explicitly. Existing resource access and owner-local unsharing do not require it online. Removing the active manager or its voluntary departure requires transferring the role first; the last member instead closes the cluster. A senior member's right to remove a younger manager does not permit an unmanaged cluster or two active managers.

Only the current manager initiates a transfer to a consenting current member. Persist one manager identity and `managerEpoch` per cluster, never a collection of manager flags. Use a transfer ID and expected epoch to reject concurrent transfers. Prepare and recipient acceptance do not activate the recipient. Before releasing a signed activation certificate, the old manager atomically commits its permanent relinquishment and the successor/next epoch; it can no longer issue old-epoch mutations. The successor activates only from that committed certificate. Management can pause during handoff, but two managers must never act concurrently.

Retries resume the same transfer. An uncertain outcome cannot reactivate the old manager or start a replacement transfer. Restarts and backup restoration must reconcile committed transfer state before accepting management requests. Reject old-epoch writes, replayed transfer certificates, and stale snapshots. Offline members may display a last-known manager, not claim it is currently active. There is no automatic failover or timeout-based self-promotion in this release.

### Credentials

Each node creates an Ed25519 identity key using Node's built-in crypto APIs. Store its private key encrypted in node-local SQLite using the existing local encryption mechanism. Exchange public keys, never private keys or other members' bearer tokens.

New machine requests sign a canonical envelope containing protocol version, sender ID, recipient ID, HTTP method, exact request target, SHA-256 of the raw body, timestamp, and random nonce. The receiver verifies against its pinned sender key, rejects timestamps outside a 60-second window, and retains consumed nonces for at least 120 seconds. Store replay state in SQLite so restarts do not reopen the replay window. Resource IDs and actor IDs in JSON are not authentication.

Invitation links remain one-time, expire after 15 minutes, and carry a coordinator identity fingerprint plus the secret. Store only the secret hash. HTTPS remains required except isolated loopback development. Redeeming the same invitation with the same node and request ID is an idempotent retry; another node gets a used-invitation error.

Pin membership public keys from the verified invitation/coordinator chain. Ordinary membership snapshots cannot install twin relationships, change a node's identity key, or introduce another cluster. Coordinator snapshots include only that cluster's public membership data, epoch, revision, removals, and signature.

Legacy shared bearer credentials are never accepted for the new selective-sharing protocol. Known old peers keep only their explicitly recorded legacy relationship while migration is pending. A new v2 peer cannot call old broad machine routes to bypass v2 authorization.

## 3. Twin handshake and scope

Twin pairing is separate from cluster invitation redemption:

1. Node A's authenticated local user creates a twin invitation after seeing the all-owned-data warning.
2. Node B's authenticated local user accepts it and sees A's verified identity and the same scope warning.
3. Both persist the same relationship ID and a certificate signed by both node identities. Idempotent confirmation completes pairing. A pending handshake grants no access.
4. Either node can revoke the relationship. A signed revocation for that relationship ID is permanent; reconnecting requires a new relationship ID and new acceptance.

Both nodes automatically replicate their own managed projects, tickets, transcripts, project files, secret accounts and attachments, and agent resources. Include portable workspace definitions, names/colors, project/conversation defaults, pins, reviews, and other resource-linked metadata already replicated by the application. Preserve existing single-owner scheduling semantics so synchronizing a schedule does not execute it on both twins. Keep view-local preferences such as the selected cluster filter node-local because memberships can differ. Pairing bootstraps existing data and subscribes to later changes and deletions. It is not a clone of the operating system or the SQLite file.

Never replicate browser cookies/profiles, user login sessions, private node keys, local encryption keys, service environment files, executable overrides, machine URLs, local paths, or process/runtime leases as if those processes were running on the receiving machine. Browser ownership and login data stay pinned to their existing machine. Replicate portable metadata and resolve paths against each node's configured managed home.

Data received from another cluster is excluded from twin replication, without exception for overlapping memberships. If both twins independently belong to the source cluster, each receives that data through the source cluster's authorized synchronization, not by exporting the received copy over the twin relationship. No project, ticket, transcript, attachment, or secret received through a cluster may be carried into another cluster by a twin. Mixed-owner transcript/workspace roots must never become blanket twin sync folders.

Disconnecting preserves original ownership and files already present, cancels future delivery, removes replica-only credential attachments from future message resolution, and retains access independently granted through a cluster. It never asks the user to split a shared identity. Secret values already received cannot be recalled from a machine administrator; use provider-side rotation when confidentiality requires that.

## 4. Resource policy versions and delivery

Keep the implemented `sharing_*` policy tables as the local effective projection. Add durable ownership records, versioned owner-signed sharing statements, membership snapshots, twin certificates/revocations, and per-peer delivery state. Scope account/workspace adoption by verified identity, not identical display labels; conflicting legacy portable settings are resolved in the migration preview before overwrite. Resource statements have a stable resource key, policy generation, owner ID, writer ID, operation ID, share set, and signature. Record deletions/revocations as tombstones, not absence.

The original owner alone changes resource-sharing policy using expected-generation compare-and-set. A twin cannot submit sharing mutations on the owner's behalf, whether the owner is online or offline. Both may revoke their own twin relationship or membership. Twin edits to content continue under existing task/conversation execution rules, but do not grant ownership or publishing rights. Ticket authorization is derived from its parent project's current policy and cannot be written as an independent grant.

A new local project registration, its auto-share selections, and its outgoing policy events commit together on the existing project database connection. Imports preserve the verified owner and never auto-share. Resource aliases canonicalize before every policy check. Received metadata is never proof of original ownership without verified provenance.

Use one effective access calculation for inventory, task/conversation APIs, file requests, replication send/receive, runtime snapshots, search, browser/task execution eligibility, and sync-folder reconciliation:

- Original owner or direct accepted twin of original owner; or
- Recipient and owner are current members of the same cluster, with an active owner-authorized resource share in that cluster.

This eligibility check is necessary but not sufficient for delivery: the source context must also match, so a cluster replica cannot use twin eligibility or another cluster as an export route. For any ticket and its conversation/files, resolve owner and policy from the parent project, not from the node that happened to create or execute the ticket. Contributors cannot narrow or widen inherited ticket access.

For secrets restricted to a project, the project must also be shared in the same cluster. A grant in cluster A cannot validate a project visible only in B. An unknown policy denies remote access; it never means unrestricted.

A new share sends a current snapshot followed by changes after that snapshot's watermark. Do not rely on old `replication_deliveries` rows, because the existing sender marks excluded events delivered. A recipient becoming eligible again needs a fresh bootstrap generation. Validate the entire incoming envelope and per-resource authorization before applying a transaction. A duplicate event ID is acknowledged only within its verified identity/provenance context.

Replica synchronization is permitted only inside the same original authorized sharing context. Persist the source cluster or owner-to-twin relationship on every replica and delivery. Receiving a resource through cluster X never authorizes sending it through cluster Y or a twin link, even if the destination also has independent access. Original-owner publication to each selected cluster uses separate delivery contexts. An overlapping-cluster or twin bridge cannot republish another owner's project.

## 5. Revocation, offline nodes, and running work

The initiating owner immediately stores its revocation, stops authorizing new requests through the removed grant, cancels queued affected exports, and disables the affected outgoing sync path. Delivery of the versioned revocation is retried durably to other replicas.

Show two distinct states: locally removed, and confirmed removed from all known replicas. Offline or unreachable replicas remain visibly pending. Never report global immediate revocation or deletion of previously copied data. Older statements cannot resurrect a revoked generation. A reconnecting app must reconcile policy before re-enabling its managed sync exports.

Syncthing can run independently of the app, so a previously authorized disconnected replica may still have old folder configuration until reconciliation. This is part of the visible pending-revocation state, not a hidden security guarantee. For deployments requiring immediate centrally enforced revocation of every byte, direct peer filesystem replication would need to be replaced; that stronger guarantee is not promised here.

Preserve a peer's resource sync path if another cluster or a twin still grants access. Do not globally remove the peer or rotate unrelated credentials on a single-cluster leave.

A running message retains its credential snapshot, as today. New messages, queued messages, new handoffs, and new remote execution require current access. A local unshare is recorded even if a handoff exists; the handoff is cancelled or settled under its recorded transaction ID without granting new work. A remote agent already holding data cannot be remotely guaranteed to forget it. Existing local repositories and transcripts remain on disk as disconnected copies, hidden from ordinary shared-resource inventories unless explicitly retained as local data. Retention does not grant resharing rights.

## 6. File and transcript strategy

### Decision

Reuse Syncthing with per-resource folders and filesystem-owned transcript exports. Do not build a replacement bidirectional file-sync engine, put file bytes in SQLite, or rely on per-peer ignore rules to isolate resources in a common root.

- Project repository: retain its canonical resource identity, but isolate Syncthing folders by original sharing context. Do not put devices from different clusters or a twin link in one shared folder. The original owner publishes a filesystem export for each authorized context; a recipient cannot enroll another context. Received content may synchronize within its original context only. Context-specific exports remain filesystem-owned, and conflicts return through the existing authorized writer/merge flow rather than creating new ownership.
- Ticket workspace: use one deterministic folder ID per ticket and original sharing context, rooted in its project-owned workspace or a context-specific filesystem export. Every ticket's eligible members come from its parent project's share, never a separate selection. Remove device sharing from the old global ticket root before enabling these folders; no concurrently active parent/child sync folders.
- Git-backed task worktrees: retain `exportTaskBranchBundle` and `prepareTaskWorktreeFromBundle` for handoff. Project sharing remains a prerequisite for project-backed tasks.
- Transcripts: export each logical conversation into a filesystem directory per original sharing context under the managed home, including its ordered native transcript segments and explicitly referenced attachments. Use `listConversationSegments(projectId, conversationId)` and the harness's `paths.transcriptFile` rather than copying an entire Pi/Claude/Kiro transcript root.
- Native import: receiving nodes verify manifest hashes, engine, conversation/segment identity, and current resource authorization; then atomically copy into the configured harness-local location. Keep incompatible or divergent transcripts as conflict artifacts rather than merging native event streams. Active execution ownership determines the exporting writer; never append simultaneously from two nodes. Preserve harness resume format and register localized paths without copying the source machine's path.
- Agent resources: twin-only, using the existing dedicated agent-resources folder. They are not silently published to ordinary clusters.
- Secret files: travel only as explicitly authorized encrypted-at-rest secret account payloads, never by copying a node's `secret-files` materialization directory.

File authorization checks must bind the authenticated node to the requested resource and its recorded Syncthing device ID. Do not accept an arbitrary device ID supplied by a peer as a destination. Reject unmanaged folder IDs. Resolve filesystem roots from server-owned project/ticket/conversation records, never a caller-provided absolute root. Do not follow symlinks outside the authorized root. Preserve existing project ignore rules for node-local credentials and generated files; complete ticket sharing means all of the existing sanitized ticket workspace, baseline, merge state, and attachments, not a new copy of excluded source secrets.

Twin replication uses these same per-resource boundaries with automatic eligibility, not broad mixed-owner roots. This is the necessary correction to the earlier suggestion that twins could always retain whole-root replication.

## 7. Secret behavior

Keep accounts and runtime attachments separate:

- Account sharing: owner chooses selected cluster-wide destinations or selected project destinations within each cluster. An account's explicit twin replication is automatic for the owner's accepted twins.
- Attachment: keep existing workspace/project/conversation selection and variable precedence. Receiving an account does not automatically attach it to every project in that cluster.
- Ordinary cluster export includes only authorized project/conversation attachments. Do not copy a workspace attachment that would activate credentials in unrelated recipient projects. Materialize workspace-inherited attachment intent only for the particular authorized project. Twin export can preserve owned workspace attachments when their full scope is authorized.
- Account deletion and removal of a share are different operations. Deletion emits an owner-authorized account tombstone. Unsharing removes only the affected delivery/provenance and replica attachments, retaining copies allowed through other grants.
- Use per-recipient payload/provenance versions. A filtered assignment set delivered through one cluster must not overwrite unrelated locally owned or independently shared assignments for the same account.
- Re-encrypt received values with the recipient key. Never log payload values, signatures' input bodies containing secrets, credentials, or rendered secret file contents.

The same resource-generation ordering applies to secret rotations and twin edits: compare-and-set against authoritative account version, reject conflicts with 409, refresh before retry. No silent merge of distinct credential values. A next-message refresh sees rotations, removals, and changed attachments while the running message's snapshot remains unchanged.

## 8. Migration and Mac/Homeserver adoption

Use an explicit coordinated upgrade, not independent automatic ownership guessing:

1. Install the protocol-capable release while preserving recorded legacy relationships. Do not allow v2 selective memberships until old broad folder permissions have been reconciled on that node.
2. Present an adoption preview showing each legacy peer, effective existing project access, known project provenance, candidate twins, existing secret replication scope, and managed folder changes. Machine names alone do not prove ownership.
3. Establish the legacy creator and admission order from verified historical records. If those are missing or ambiguous, require explicit confirmation in the adoption preview rather than guessing from timestamps on replicated files. The original node starts as the sole cluster-membership-manager and most senior member; assign the confirmed remaining admission order once. It creates and distributes the single new cluster ID. All existing nodes must acknowledge the migration transaction. Offline/incompatible nodes leave adoption pending; they are not silently granted v2 access.
4. Existing asymmetric project grants remain explicit migration restrictions. Do not convert their union into cluster-wide access. The preview requires the resource owner to select a uniform new cluster share or keep that resource private. Existing legacy resource identity with ambiguous ownership requires explicit adoption confirmation; do not guess from local folder presence.
5. The user explicitly requested that Mac and Homeserver be twins for rollout. Complete and verify that adoption on both machines using their actual node IDs and reciprocal active certificates, with the same two-sided consent, all-owned-secret warning, and data-conflict preview as a new twin pair. Automated inter-node rollout must remain disabled until that verification succeeds. A protocol-bootstrap installation on an older node is a separate controlled per-node migration step, not permission for legacy fleet updates. Adopt existing identical resources once using verified IDs/folder mappings. Differing secret values or divergent transcript histories require conflict resolution before enabling overwriting replication. Never print those secret values in the preview.
6. Snapshot each node's SQLite and Syncthing configuration before cutover. Stop affected exports, apply ownership/policy and folder changes, invalidate old invitation links and broad machine credentials, then bootstrap authorized replicas. Do not expose a partially converted node as ready.
7. If preparation fails, keep old mode and report the failed step. Once v2 cutover has revoked access, rollback must not automatically restore the broader legacy trust or overwrite newer user data. Prefer repair-forward. Restoring a backup is a separately confirmed maintenance action.

Migration is a UI/API workflow delivered with the feature, not a requirement to ask the user to enumerate all production ownership now. Implementation and isolated tests can proceed without production credentials or changes.

## 9. HTTP and UI contracts

New local-user routes use normal session authentication and CSRF. New machine routes use the signed protocol and explicit resource authorization. Names below are proposed v2 routes, not claims that they exist today.

Local-user operations:

- `GET /api/clusters`: memberships, names, original node, sole manager identity, manager epoch, admission sequences, status, and auto-share setting.
- `DELETE /api/clusters/:clusterId/members/:nodeId`: authenticated senior member removes a strictly younger member through the manager; no inviter, manager, or twin override.
- `POST /api/clusters/:clusterId/manager-transfer`: `{successorNodeId, expectedEpoch, transferId}` initiated by the sole current manager, followed by successor acceptance and committed activation.
- `POST /api/clusters`: `{name}` creates a cluster.
- `POST /api/clusters/:clusterId/invitations`: membership-only invitation; no project IDs.
- `POST /api/clusters/join`: `{link, requestId}`.
- `POST /api/clusters/:clusterId/leave`: affects only this membership.
- `PATCH /api/clusters/:clusterId/membership`: `{autoShareProjects}` for local membership.
- `GET /api/sharing/:kind/:resourceId`: owner, effective grants, editable status, generation, pending delivery/revocation.
- `PUT /api/sharing/:kind/:resourceId`: original-owner-only `{expectedGeneration, shares:[{clusterId, projectId:null|string}]}` for projects and secrets. Ticket sharing mutations are rejected; ticket reads return inherited project policy.
- `POST /api/clusters/:clusterId/share-all-projects`: additive existing-project operation.
- `POST /api/twins/invitations`, `POST /api/twins/accept`, `GET /api/twins`, `DELETE /api/twins/:relationshipId`.
- Migration preview/prepare/commit/status routes keyed by a stable migration transaction ID; retries resume the same transaction.

Machine routes live below `/api/cluster/v2/` for membership, twin confirmation, policy updates, filtered inventory, resource events, and bootstrap acknowledgments. Separate local-user routing from these machine APIs; do not leave unguarded old endpoints as an alternate path.

Expected failures: 400 malformed input; 401 failed signature/session; 403 not owner/member/authorized twin; 404 unknown or nonvisible resource; 409 generation conflict, unresolved migration, running handoff conflict, or incompatible peer; 410 expired/consumed invitation; 503 required coordinator/owner unavailable. Do not reveal unrelated project names in error bodies.

Cluster filter state is `all | local | <clusterId>`. Use existing node-local SQLite preference storage, not browser localStorage. Add `clusterIds` and an explicit locally-owned/disconnected status to project/session view models. Local/private means resources owned locally or by an accepted twin with no active cluster share, not every imported object whose grant disappeared. Every ticket conversation is filtered by its parent project's grants. All means all currently visible resources, not all records ever received.

Filters compose with existing search, classification, workspaces, and ticket filters. Changing a filter refreshes project and session lists together. If it hides the selected project, clear that selection without cancelling its running conversation; active work remains reachable through the existing active-conversation controls. Deleted/left cluster selections reset to All with a visible notice.

UI locations:
- Cluster/twin management in Settings, replacing the single Cluster panel. Show multiple named clusters together on a visual canvas. Each cluster is a distinct selectable region with its member nodes and shared-project count. Clicking or keyboard-selecting a cluster opens its detail panel with members, seniority, sole manager, locally visible shared resources, membership settings and available actions. Use real authorized API data, not a decorative diagram or a global unfiltered inventory. Keep the canvas usable on mobile, with visible selection/focus and empty/error states. Show direct twin relationships separately from ordinary cluster membership.
- Project sharing in project controls; owned vs received clearly shown.
- Tickets show inherited project sharing, with no separate share picker.
- Member lists are ordered by seniority and show one manager badge. Removal controls require the viewer to be strictly older than the target; role transfer never changes this ordering.
- Received projects, including twin copies, show no share, move-to-cluster, or auto-share controls.
- Account destination picker in Secrets; attachment pickers remain in their existing project/conversation locations.
- Cluster filters above project and conversation lists.
- No invitation project checkboxes and no Replace cluster join confirmation.

### Version-update authorization

The user requires remote version updates to target only explicitly accepted, active, direct twins. Ordinary cluster membership, seniority, manager status and shared projects confer no update authority. A twin's twin is not eligible. Revoked or pending twins cannot initiate or receive coordinated updates.

Fleet target selection must enumerate direct active twins, not the legacy global peer list. Recheck relationship status before each remote update request, and enforce the same rule at the receiving server using signed v2 sender identity. Reject legacy bearer fleet routes and alternate management paths as update-authority bypasses. Resolve release versions from the receiver's trusted feed, never from caller-supplied download URLs. Keep local human-authorized self-update separate from remote fleet authority.

Preserve the installed service's local preparation path without trusting a remotely reusable legacy peer token. Inspect `scripts/install-service.sh` and `/api/update/prepare` along with `src/updater.ts` and the update routes; selective mode currently disables the script's old bearer call. Cover bootstrap compatibility and fail closed rather than silently skipping preparation.

Before production automated rollout, verify Mac and Homeserver's reciprocal twin relationship and identity, authorized migration state and readiness. No inference from display names, old pairing, or network proximity. These are release prerequisites, not completed production actions.

## 10. Ordered implementation packages

Each package gets a concrete Pi Develop brief with explicit allowed files and tests before Sol edits. Do not implement later integration against invented existing functions. The following package order and contracts are settled; code should not ship until the complete sequence passes.

### A. Membership, authentication, and twin lifecycle

Foundation modules now exist: `src/cluster-identity.ts`, `src/cluster-protocol.ts`, and `src/cluster-twins.ts`. Local seniority and manager-transfer state live in `src/cluster-sharing-policy.ts`. Signed-request authentication is now wired into production Express middleware using `src/cluster-v2-store.ts`. `src/cluster-membership.ts` implements internal invitation redemption and same-manager snapshots. The reproduced local re-admission consent bypass is fixed, with retained negative cases and explicit rejoin verification. See the consent-fix review in `CLUSTER-SHARING-PLAN.md`. Membership HTTP and maintenance are now integrated behind a fresh-node/legacy-migration gate. Signed manager transfer is implemented internally; manager HTTP/offline-relay acceptance is under review. Twin/resource HTTP, complete replication, migration and UI are still pending. See the active continuation ledger in `CLUSTER-SHARING-PLAN.md` for current verification and unresolved defects.
Modify `src/cluster.ts`, `src/server/http-auth.ts`, `src/server/schemas.ts`, `src/server/routes/core.ts`, `src/server/routes/cluster.ts`, `src/server/maintenance.ts`.

Introduce encrypted identity keys, verified request identity, replay storage, immutable per-admission seniority, sole-manager revisions and fenced transfer, invitation redemption, and bilateral twin certificates/revocations. Replace global leave/mesh semantics only after migration mode is explicit.

Tests: new `test/cluster-protocol.test.ts`, `test/cluster-twins.test.ts`; extend `test/cluster-mesh-api.test.ts` and `test/cluster-leave.test.ts`. Prove token-based impersonation, replay after restart, cross-cluster snapshot injection, invitation reuse, offline coordinator errors, and independent leave behavior.

### B. Ownership and versioned resource sharing

Extend existing `src/cluster-sharing-policy.ts`. `src/cluster-sharing.ts` now implements synchronous injected-database policy generations, verified per-context statements, outbox and projection application. It remains under adversarial review and is not yet wired into production ownership/content transactions. Production orchestration must use the existing connection for creation transactions rather than opening a second write transaction mid-create.

Modify `src/store.ts`, `src/types.ts`, `src/tasks.ts`, `src/secrets.ts`, `src/server/routes/projects.ts`, `src/server/routes/tasks.ts`, `src/server/routes/secrets.ts`.

Verified integration anchors:
```ts
export async function addProject(name: string, folderPath: string, options: AddProjectOptions = {}): Promise<ProjectRecord>
export async function importProject(project: ProjectRecord, localPath?: string, sourceNodeId?: string): Promise<ProjectRecord>
export async function canonicalProjectId(projectId: string): Promise<string | undefined>
export async function setScopeSecretAccounts(scopeType: SecretScopeType, scopeId: string, accountIds: string[]): Promise<void>
```

Original-owner-only sharing mutations use generation CAS; project creation and auto-share are atomic; imports carry verified ownership and source context; all tickets inherit project grants; secret attachment resolution is unchanged. The isolated policy foundation now rejects twin sharing-administration permission, excludes twin-owned imports from bulk sharing, derives ticket authorization from its parent project, and stores seniority/single-manager state. Its tests cover the revised rules. This does not supply the authenticated orchestration, owner-signed policy generations, or production ownership transactions. Add full snapshot bootstrap and tombstones before routing production checks through the policy projection.

Tests: extend `test/cluster-sharing-policy.test.ts`, replace invitation-selection behavior in `test/cluster-invite-projects.test.ts`, add `test/cluster-sharing-api.test.ts` with owner/nonowner/alias and transaction rollback cases.

### C. Authorization across replication and execution

Modify `src/replication.ts`, `src/secret-replication.ts`, `src/server/cluster-helpers.ts`, `src/server/maintenance.ts`, `src/server/routes/cluster-tasks.ts`, `src/server/routes/sessions.ts`, `src/server/routes/project-files.ts`, and the browser/search/runtime/push handlers that currently operate over all peers.

Bind every item to project or ticket provenance; no global session-name/ownership leakage. Implement per-recipient secret assignments, generation-aware delivery, reshare bootstrap, runtime-message refresh, and safe handoff settlement. Inventory filtering is necessary but insufficient.

Tests: extend `test/cluster-project-sharing.test.ts`, `test/cluster-inventory-api.test.ts`, and `test/cluster-sanity.test.ts`; add `test/cluster-secret-sharing.test.ts` and `test/cluster-ticket-sharing.test.ts`. Cover mixed batches and the same account/resource visible through overlapping grants.

### D. Resource-scoped filesystem replication

New planned `src/conversation-sync.ts` handles native transcript exports/imports and manifests. Modify `src/syncthing.ts`, `src/task-workspaces.ts`, `src/server/maintenance.ts`, `src/server/routes/cluster-tasks.ts`, and harness contracts/adapters for transcript artifact enumeration.

Verified anchors:
```ts
export function expectedTaskWorkspacePath(projectId: string, taskId: string, root = ticketWorkspaceRoot()): string
export async function removeSyncthingDevices(deviceIds: string[], folderIds: string[]): Promise<void>
export async function ensureSyncthingFolder(folderId: string, label: string, folderPath: string, peerDeviceId?: string): Promise<void>
export async function listConversationSegments(projectId: string, conversationId: string): Promise<ConversationRecord[]>
export async function exportTaskBranchBundle(projectPath: string, worktreePath: string, branch: string): Promise<TaskBranchBundle>
```

Use dedicated ticket/conversation folders, verified device identity, no broad native transcript roots, and conflict-preserving native imports. Shared file data remains filesystem-owned.

Tests: new `test/cluster-resource-files.test.ts`, `test/conversation-sync.test.ts`; extend handoff/cluster tests. Include a real isolated Syncthing integration run where available and explicit required test prerequisites instead of silent skipping. Verify a denied resource's bytes, names, and attachments never arrive at the unrelated node.

### E. Legacy adoption and twin conversion

New planned `src/cluster-migration.ts`; modify cluster/settings routes and migration views. Persist migration state and backups; preview original ownership, grants, secret conflicts, and device-folder changes. No implicit Mac/Homeserver production conversion during tests.

Tests: new `test/cluster-migration.test.ts` using different legacy grant sets, identical and conflicting aliases, differing secret versions, offline peers, preparation failure, restart mid-cutover, and revocation-preserving recovery.

### F. UI, filters, and release

Modify `public/app/cluster-panel.js`, `public/app/secrets.js`, `public/app/tasks.js`, `public/app/project-list.js`, `public/app/project-selection.js`, `public/app/session-list.js`, `public/app/layout.js`, `public/app/state.js`, `public/app/elements.js`, `public/index.html`, `public/styles.css`, `public/sw.js`, plus SQLite preference schemas and project/session view construction.

Verified anchors include `renderProjects()`, `renderSessions()`, `filteredProjects()`, `filteredSessions()`, `loadProjects()`, `GET /api/projects`, and `GET /api/projects/:projectId/sessions`.

Replace `test/ui/ui-invite-project-selection.test.ts` with membership-only invitation behavior. Add `test/ui/ui-cluster-sharing.test.ts`, `test/ui/ui-cluster-filters.test.ts`, and `test/ui/ui-twins.test.ts`. Verify controls, visible content, filtering composition, owner restrictions, pending revocation, and migration warnings in actual browser journeys.

Update `README.md`, version/changelog via the existing release workflow, and the PWA cache version. Rebase/reconcile against current main without creating a branch and without incorporating unrelated working-tree changes. Do not force-push.

## 11. Acceptance and release gate

The shared isolated node harness must support four nodes, not just two: twins A/B, cluster X with A/B/C, and cluster Y with A/B/D. This proves twin trust does not leak C's project to D, nor leak data to B unless B is actually authorized. Add a variant with B absent from X, and a fifth receiver only when testing the per-cluster size limit.

For each project/ticket/secret scenario verify owner, authorized member, unrelated member, direct twin, and unauthorized twin-of-recipient behavior. Explicitly reject twin and ordinary-recipient project resharing and cross-context file/event forwarding, including when the destination independently belongs to the source cluster. Prove every existing and newly created ticket, attachment, and conversation inherits project sharing and revocation without a separate grant.

Test seniority independently in two clusters, concurrent admission ordering, idempotent join, younger inviter/manager removal denial, senior removal permission, and rejoin receiving a new junior rank. Transfer must preserve seniority. At every transfer crash boundary, concurrent request, restart, and replay, prove at most one manager can commit writes. Prepared recipients cannot act; relinquished managers cannot act; stale epochs cannot revive authority. Test removing a younger active manager through the required handoff and last-member cluster closure.

Test byte-level filesystem results, API reads/writes, event batches, UI inventories, and subsequent-message secret context. Include stale snapshots, duplicated messages, offline replicas, restart, rejoin, owner-restored sharing, manager transfer, and multiple independent authorized access paths.

Required checks from the isolated worktree:
```sh
npm run typecheck
env -u JOINT_BOB_INSTALL_ROOT npm test
npm run build
env -u JOINT_BOB_INSTALL_ROOT npm run test:ui
```

Use documented disposable HOME/data and synthetic fixture accounts. Remove inherited native-service deployment overrides from test child environments. Each new behavioral test must be observed failing against missing/broken behavior before being retained. Parent Astra independently reviews all changed files and reruns checks; Sol reports do not replace parent verification.

Definition of done: all packages integrated; no legacy bypass for a new selective peer; resource isolation proven over HTTP, metadata replication, and files; full browser journeys pass; migration tested without widening access; all tests/typecheck/build pass; complete diff reviewed; only intended changes committed; release gate completed; push succeeds. Production Mac/Homeserver twin adoption is a separate explicit supported operation after the release, not evidence substituted for isolated verification.
