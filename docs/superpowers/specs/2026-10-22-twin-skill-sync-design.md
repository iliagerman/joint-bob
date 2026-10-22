# Twin skill synchronization

## User-approved behavior

- Twins synchronize skill additions, content changes and deletions automatically in both directions, similar to Syncthing.
- The Mac is authoritative for the initial synchronization to Homeserver. Do not merge their initial inventories.
- Initial reconciliation adds missing skills, replaces differing skills and removes extra removable skills on Homeserver.
- Deletions from either twin, including bulk deletion, propagate to the other twin.
- Relay-imposed skills remain protected. Offline twins catch up after reconnecting.

## Scope and exclusions

Synchronize app-managed, node-wide skill directories, including their scripts and executable bits. Independent native skill directories, harness/runtime packages, project-local skills, MCP configuration, credentials and unrelated files are not mirrored. Report excluded resources rather than claiming the complete native agent environments are identical. Never widen an existing scoped or third-party grant by republishing its received copy. Relay copies are never sources or removal targets; collisions with relay-controlled names are reported as protected differences.

Activation preferences remain node-local in this change. Content equality is not a claim that both machines have identical agents or runtime capabilities.

## Architecture decision

Use a new opt-in synchronization channel scoped to a direct, active trusted-twin relationship. Keep existing selective cluster sharing intact and keep the legacy Syncthing agent-resource folder paused. Reuse authenticated node transport and validated skill bundles, not arbitrary file paths or shell commands.

Store relationship initialization state, per-skill versioned records, durable deletion tombstones, received acknowledgments and sync status in SQLite. Use causal versions rather than wall-clock timestamps. Persist conflict copies and removal backups outside discovered skill directories. File installation uses validated staging and atomic replacement; recover interrupted work from a durable application journal before publishing new state.

Implementation choice for this first release: one initialized skill-sync partner per node, matching the requested Mac ↔ Homeserver pair. A node may still have multiple ordinary twins, but configuring a second skill-sync partner is rejected before any preview or filesystem mutation. Supporting overlapping multi-twin skill-sync groups is outside this release; this avoids an accidental transitive sharing path through a node's single managed skill directory.

No network I/O may hold the existing shared skill mutation lock. Recheck active twin authorization immediately before applying a downloaded mutation. Use the same mutation lock as imports, removal, reconciliation and relay delivery.

## Initialization

1. The administrator selects a direct twin and chooses "Make this twin match this node and keep syncing". For the user's requested initialization, the source is the Mac and the destination is Homeserver.
2. A bounded preview lists additions, replacements, removals and protected differences. Names and counts come from a fresh, authenticated destination snapshot.
3. Confirmation is bound to source and destination identities, relationship ID, source inventory digest and destination inventory digest. Reject stale previews; never silently regenerate a destructive plan and execute it.
4. Back up overwritten and deleted destination copies. Protected relay and excluded resources remain untouched. Implementation choice: any destination-owned skill adopted into the baseline becomes an explicit non-publishing twin replica, even when its content already matches. Revoke its destination-owned selective grants rather than silently exporting the source's content through them. Preview and confirmation must list this grant withdrawal separately, including affected skills and recipients. Source ownership/grants stay unchanged; later edits from Homeserver update the synchronized source content under the already-authorized twin relationship.
5. Initialize both endpoints to the acknowledged common baseline. The destination must not publish its old inventory before this completes. Interrupted or offline initialization remains pending and resumes idempotently without interpreting incomplete results as local changes.
6. Only a completed initialization enables automatic bidirectional reconciliation. Existing twins are not destructively initialized merely by upgrading the application.

## Ongoing reconciliation

Scan managed content after relevant app mutations and during the existing maintenance cycle. Compare content digests with the durable baseline to detect external filesystem changes too. A successful scan of a valid root is required before deriving deletions. Missing/unreadable mounts, partial scans and network errors must not turn into an empty authoritative inventory.

Exchange bounded manifests and fetch changed bundles by expected digest. Increment the editing node's causal counter for a genuine local mutation, including deletion. Do not emit a fresh local edit for remotely applied content. Acknowledgments and tombstones survive restarts; an offline old copy must never resurrect a deleted skill.

- Causally newer edit replaces the old copy with a backup.
- Causally newer deletion removes the skill and its managed aliases with a backup.
- Concurrent content edits preserve both versions outside the active discovery path and choose an identical, deterministic active version on both endpoints. Show the conflict for explicit resolution.
- Concurrent deletion and edit keep the deletion active, preserve the edited content as a recoverable conflict, and show the conflict.
- Reimporting a previously deleted skill is a new causal edit, not a replay of its stale pre-deletion version.

A delayed or duplicate message must be idempotent. Digest mismatch, invalid bundle, symlink escape, duplicate names, oversized inputs or untrusted author/relationship state must not mutate active content. A revoked twin is no longer allowed to read or write sync data. Synchronization must not create a transitive sharing route through another twin or export received scoped/third-party resources.

## Integration with selective sharing and removals

Keep content synchronization separate from ownership/grant policies. A synchronized twin replica must have explicit provenance so native reconciliation cannot adopt it as a newly owned skill or publish it through unrelated cluster grants. Selective refresh must not independently resurrect or remove content owned by this synchronization channel. A replica's user-initiated removal creates a twin tombstone rather than only a local suppression marker. Existing relay protection is enforced again on the server, even if a stale UI offered removal.

Retain local-removal behavior for resources outside an initialized twin-sync relationship. Revoke owned sharing grants when their source skill is deleted; do not let a receiver rewrite another owner's grants. This ownership boundary needs explicit integration tests before enabling sync.

## Status and controls

Settings → Resources shows the direct twin relationship, initialization state, last successful sync, pending changes, protected differences and conflicts. Provide preview/confirm initialization, refresh, pause and conflict-resolution controls. Switching node or scope invalidates an open preview and ignores stale responses. Failed loads never show the previous node's state as editable.

## Deployment and live application

Implement and test using isolated fixture nodes first. Do not access production skill directories during tests. The Mac-to-Homeserver initialization is a separate live action after the candidate is deployed and both nodes support the protocol. Discover and verify actual machine IDs then; never infer authorization from display names alone. Do not claim the user's live twins are synchronized merely because repository tests passed.

## Verification

Two isolated nodes must demonstrate authoritative initialization, add/edit/delete in both directions, bulk deletion, filesystem edits, offline catch-up, process restart, duplicate delivery, interrupted install, stale preview rejection, concurrent edits, delete/edit conflict, explicit reimport, relay collision, selective-share coexistence and rejection of non-twin/revoked senders. A three-node test must prove there is no unintended transitive publication. Browser tests verify previews, destructive confirmation, node switching and visible status against loopback fixtures.
