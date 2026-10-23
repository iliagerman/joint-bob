# Built-in file sync (replacing Syncthing) — plan for review

Status: **draft**. Proposed decisions are in section 9 and still need review. This plan supersedes the file-transport decision in `CLUSTER-SHARING-DESIGN.md` §6 ("Do not build a replacement bidirectional file-sync engine"), which must be amended when this is accepted.

## 1. Goal

Joint Bob moves project, ticket and worktree files between machines itself, over the transport it already uses for everything else. Syncthing is no longer installed, configured or required.

- **One identity, one network path.** Files travel over signed cluster requests, either direct or through a Joint Bob relay, like transcripts do today. There are no Syncthing device IDs, no second daemon and no public Syncthing relays or discovery.
- **Sharing rules don't change.** The same cluster and twin policy decides which machine gets which project (`mayShareProject` in `src/server/sharing-files.ts:41`). Revocation takes effect on the next request.
- **Precise readiness.** A machine knows exactly which version of each file every peer has. Handoffs wait for the files that are actually needed instead of polling a folder state.
- **Joint Bob controls the order.** Worktree metadata and files a turn needs go first; bulk copies go last and are copied locally when the content already exists on the machine.
- **A broken share never takes a node down.** File sync is reported in status and never blocks startup, health, project creation or ticket creation.

## 2. Why replace Syncthing

Problems seen on the Mac and the homeserver this month:

| Date | What happened | Root cause in the Syncthing integration |
|---|---|---|
| 2026-10-06 | Homeserver at health 503 for 9 hours; three release activations rolled back | Project row saved, Syncthing folder never created; startup ignore-rule POST failed (`maintenance.ts:75`) |
| 2026-10-08 | No worktree synced Mac↔homeserver | One project's folder path mismatch aborted enrollment for every project with that peer |
| 2026-10-11 | Worktrees showed up 35 minutes late; pulls ran at a few files a minute on a LAN | `smallestFirst` queue is fixed per pull iteration; `worktree.json` was file 5,411 of 44,093 |
| 2026-10-11 | Homeserver event loop at 90–100% | Syncthing held 118k of 123k inotify watches; enrollment made ~12 REST calls per project per peer |
| 2026-10-12 | Folder stuck in error on one node | First-match ignore semantics: `*.key` (not deletable) matched before `(?d).dev-env/` |
| ongoing | Relay-only peers need a loopback tunnel hack | Syncthing dials its own addresses (`src/relay/syncthing-tunnels.ts`) |

Structural issues:

- Two daemons, two configurations and two authentication domains. Joint Bob drives Syncthing through about 15 REST calls (`src/syncthing.ts`) and can only see what Syncthing chooses to report.
- Revocation is not enforceable while Syncthing runs independently (`CLUSTER-SHARING-DESIGN.md` §5).
- The installer ships a pinned binary for each OS and architecture, adopts or starts a daemon, and fails the build if Syncthing isn't running (`scripts/install-service.sh:92-95`). Self-update staging goes through the same path (`scripts/supervisor-install.mjs:33`).
- Conflict copies appear with Syncthing's naming and are then merged by a background agent (`src/server/sync-check.ts`).

## 3. What Syncthing does for Joint Bob today

### 3.1 Folders

Each shared project has three Syncthing folders, enrolled per peer in `enrollFiles` (`src/server/sharing-files.ts:54`):

| Folder | ID | Root |
|---|---|---|
| Project | `projects.sync_folder_id` (e.g. `joint-bob-<slug>-<id>`) | project path |
| Tickets | `projectTicketSyncFolderId(id)` | per-project ticket workspace root |
| Worktrees | `joint-bob-worktrees-<sha256(projectId)>` | `projectWorktreeRoot(id)` |

There are also legacy folders that stay paused or have their devices removed: the global ticket folder, `joint-bob-conversations-*`, `joint-bob-agent-resources`, `dot-pi` and `dot-claude`. Transcripts, skills, secrets and settings already travel over Joint Bob's API.

Measured on the Mac on 2026-10-23: 79 active folders, about 850,000 files and 117 GB. The largest folder has 255,000 files (2.8 GB) and the biggest by size is 17 GB. Some folders in that daemon are not Joint Bob's (`video-translator`, `dot-codex`, `dot-copilot`, `dot-antigravity`). The daemon must keep running for them.

### 3.2 Couplings outside `src/syncthing.ts`

| Area | Where | Dependency |
|---|---|---|
| Startup readiness | `server/maintenance.ts:75`, `routes/core.ts:100` | `startup.syncthing` must succeed before `/api/health` is ok; webhooks, cron and quick-note dispatch wait on it |
| Ticket creation | `routes/tasks.ts:74` | `ensureTicketWorkspaceFolder()` runs before every `createTask` |
| Project creation | `routes/projects.ts:110-120` | `addProject` first, then `ensureSyncthingFolder`, with no rollback |
| Project move | `server/projects.ts:132-158` | Re-points the folder, and again on rollback |
| Handoff gate | `server/cluster-helpers.ts:87-92,132-175`; `task-handoff.ts`; `routes/cluster.ts:188-252` | `assertSyncthingFolderReady`; eligibility depends on Syncthing's state values |
| Twin state | `server/twin-sharing.ts:65-99` | `sharingFilesStatus` → `syncthingPeerCaughtUp` |
| Worktrees | `project-worktrees.ts:122-128` | `announce()` forces a rescan after every metadata write; `.creating-<id>` staging has no ignore rule |
| Git | `git-catch-up.ts` | Assumes files sync and `.git` does not |
| Conflict names | `harnesses/shared-paths.ts:22`, `harnesses/pi/recovery.ts:89`, `sync-check.ts:21`, `public/app/recents.js:19` and others | `name.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext` |
| Identity | `store.ts:371,437,792`; `cluster-project-metadata.ts:13` | `syncFolderId` is unique, matches imports and is in the signed, strict portable project metadata |
| Relay | `relay/syncthing-tunnels.ts`, `relay/runtime.ts:669`, `relay/protocol.ts:28`, `relay/store.ts:447` | `syncthing` channel kind and tunnel table |
| Settings | `settings.ts:28-31,237,276`; `server/schemas.ts:381` | Endpoint and encrypted API key; `syncthing` is required in every `PUT /api/settings` |
| UI | `index.html:1419,2544`; `project-list.js:199,316`; `tasks.js:280-370`; `ownership.js:19-52` | Badges, "Rescan with Syncthing", "Waiting for Syncthing", a fixed 5 s wait before a takeover |
| Agent prompt | `task-runs.ts:232` | "Syncthing transfers these files between nodes" |
| Install / CI | `scripts/install-syncthing.sh`, `check-prerequisites.sh`, `versions.sh`, `.github/workflows/release.yml:56` | Binary, units `joint-bob-syncthing.service` / `com.joint-bob.syncthing`, apt install in CI |
| Tests | `test/native-syncthing.ts` and 6 native tests; ~15 fake-REST tests; ~60 fixtures with `syncthing:{endpoint:""}` | |

`flushSharingFiles` also exchanges **project locations** (`receiveLocations`, the `project_locations` table). That has nothing to do with Syncthing and must stay.

## 4. Scope

In scope: the three per-project shares above, every caller in 3.2, migration of running clusters, and removal of Syncthing from Joint Bob.

Not in scope:

- **`.git` stays node-local.** `git-catch-up.ts` keeps moving HEAD when synced files match upstream.
- **No file bytes in SQLite.** SQLite holds only metadata and the index.
- **No public fallback.** If neither the direct URL nor a Joint Bob relay reaches a peer, files wait. The cluster API has the same requirement.
- **Folders that aren't Joint Bob's.** The user's own Syncthing folders and daemon are left alone.
- **Legacy folders.** They are removed, not ported.

## 5. Design

The code lives in `src/file-sync/`. The parts below map to modules.

### 5.1 Shares

A **share** replaces a Syncthing folder plus its device list. It is derived, never configured by hand:

- `{shareId, kind: project|tickets|worktrees, projectId, root}`; the peers are `sharedProjectIds(db, local, peer)` evaluated on every request.
- `shareId` reuses today's folder IDs: `syncFolderId` for the project share and the existing ticket and worktree IDs. `syncFolderId` stays in the schema and on the wire as the share ID (D13), so older peers and imports keep working.
- Roots come from server-owned project records. A caller never supplies a path.

Creating, moving or deleting a project only changes records. The engine notices the next time it reads its shares, so there is nothing to half-create and nothing to roll back.

### 5.2 Index

Each node keeps its index in its own SQLite file, `<data dir>/file-sync.db` (D8), apart from `node.db`. That file holds about 850k rows and churns on every edit.

| Table | Contents |
|---|---|
| `shares` | share ID, kind, project, root, `index_id` (random, regenerated if the index is rebuilt), `max_seq`, state |
| `local_entries` | path (NFC, `/`), type (file/dir/symlink), size, `mtime_ns`, exec bit, sha256 or symlink target, version vector, deleted flag, `seq`; local-only stat fingerprint (inode, `ctime_ns`); indexed by `(share, seq)` and `sha256` |
| `remote_entries` | the same fields per `(share, peer, path)`, as last announced by each peer |
| `cursors` | per `(share, peer)`: the peer's `index_id` and the highest `seq` received from it |
| `need` | the pull queue: path, source peers, priority, size, attempts, last error |
| `partials` | resumable downloads: path, sha256, temp file, bytes received |
| `errors` | per-path apply failures with a reason |
| `notify_outbox` | change notices not yet delivered to a peer, resumed by `resumeDeliveriesTo` |

**Versions.** Each entry carries a version vector `{nodeId: seq}`. When the scanner records a local change, it bumps this node's share `seq` and sets the entry's vector to the known vector plus `{local: seq}`. A remote change is stored with the remote vector unchanged and a new local `seq`, so a third machine can pull it through this one.

Disk work (scanning, hashing, index writes, applying files) runs in a **worker thread** (D9). The homeserver's main thread was already 82% busy on 2026-10-12. The main thread answers HTTP and streams bytes. It reads the index through its own read-only WAL connection.

### 5.3 Ignore rules

Ignore rules come in three explicit classes instead of Syncthing's first-match `(?d)` rules (`src/file-sync/ignore.ts`, porting the lists in `src/syncthing.ts:56-160`):

| Class | Synced | When a peer deletes the parent directory | Examples |
|---|---|---|---|
| `local` | never | kept, reported once as a notice (not an error) | `.git`, `.env*`, `*.pem`, `*.key`, `.npmrc`, `credentials.json`, `.joint-bob/` |
| `regenerable` | never | deleted along with the directory | `node_modules`, venvs, caches, `dist/`, `build/`, `.build`, `target`, `.next`, `DerivedData`, `.terraform`, `tmp`, `.tmp`, `.claude/worktrees`, `.pi/*worktrees`, logs, `.test-build-*`, `.dev-env/`, `.creating-*`, sync temp files |
| user rules | never | kept, unless the rule is marked regenerable (`(?d)` today) | per project, stored in replicated project settings (D11); for example guitar_player's `(?i)/local_bucket/**.mp3` |

- **The outermost matching directory rule decides.** Everything under `.dev-env/` is regenerable even when it matches `*.key`, which fixes the 2026-10-12 case by construction.
- Worktree shares treat every rule as regenerable and add the existing heavy-directory and binary lists (`worktree-filters.ts`), as today.
- The server applies the same rules when serving. A file that matches an ignore rule is not in the index, so it is never served, whatever a peer asks for.
- Media and other binaries stay synced in project shares, with no size limit (decided 2026-10-23). Game art, public images and screenshots are real project content. A bulk data set is excluded with a user rule instead.
- Measured on 2026-10-23 before the change: the Mac synced 100 GB in 775k files, and only about 5 GB was code, docs and data. The rest was:
  - 59 GB of guitar_player mp3s, now a user rule;
  - 30 GB of trees that can be regenerated (the rules added to `regenerable` above, shipped in Syncthing's project rules first);
  - a 255k-file decompiled APK, since deleted.

  The first index in P1 runs against what remains.

### 5.4 Scanning and watching

- **Full scan** happens when a share is added, at startup, after a watcher error or overflow, before a handoff, and from the "Rescan files" action. It walks the tree with the ignore rules, compares (size, `mtime_ns`, inode, `ctime_ns`) with the index, and hashes only what changed. A file modified in the last 2 s is checked again once it settles. A file that changes while it is being hashed is retried.
- **Watcher**: `@parcel/watcher` (D4), which uses FSEvents on macOS and inotify on Linux. Ignored directories are passed as exclusions. P1 must confirm on Linux that they cost no inotify watches. It replaces Syncthing's watches rather than adding to them. Events are debounced for 1 s and then rescan only the affected directories.
- **Turn end**: when an agent turn ends, the engine rescans that project's shares. This catches anything the Linux watcher missed (`shared-transcripts.ts:113` documents such misses) without a timer.
- **No periodic rescans** (D5), in line with the push-on-change rule.
- **First index**: hashing about 117 GB happens once, throttled to one file at a time with yields, and is measured in `performance.jsonl` as `fileSync.scan`. Syncthing keeps moving files during this time (section 7).

### 5.5 Conflicts and deletes

- Vectors are compared per path. If the remote vector dominates, the remote version is applied. If the local vector dominates, nothing happens. Otherwise the change is **concurrent**: the newer `mtime` wins, with ties going to the higher node ID, and the loser is renamed to `name.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext`. `XXXXXXX` is 7 uppercase characters derived from the losing node's ID. That is the format the existing regexes expect, so `sync-check.ts`, the background merge agent, Pi recovery and the UI filters keep working unchanged (D6).
- When a delete and a modification are concurrent, the modification wins and the file comes back.
- **Tombstones** come only from observed deletes. They are kept for 30 days and pruned at startup.
- A rename is a delete plus a create. The receiver creates before it deletes within a batch, so the new path is copied locally from the old one (5.6).
- Before replacing or deleting a file because of a remote change, the engine moves the old version to a **trash** at `<root>/.joint-bob/sync-trash/`. That folder is on the same filesystem (so it's a rename) and is node-local. The trash keeps files for 7 days, up to 5 GB per share, and is pruned when it is written to. It is not used for worktree shares or regenerable files (D7).

### 5.6 Wire protocol

All endpoints are machine-only signed cluster requests (`requireClusterV2Auth`, `machineOnly`). Each handler checks `mayShareProject(db, local, peer, projectId)` for the share. GETs have empty bodies. POST bodies are small JSON, so they can be signed and replayed for relay fallback.

```
GET  /api/cluster/v2/files/shares                       → [{shareId, kind, projectId, indexId, maxSeq}] this peer may sync with me
GET  /api/cluster/v2/files/index?share&since&limit      → {indexId, maxSeq, entries[], more}   (gzip, ≤5,000 entries a page)
POST /api/cluster/v2/files/changed {shares:[{shareId, indexId, maxSeq}]} → 202
POST /api/cluster/v2/files/fetch   {shareId, items:[{path, sha256}]}     → framed stream (≤256 items, ≤8 MiB)
GET  /api/cluster/v2/files/file?share&path&sha256       → one file, Range supported (large files, resume)
GET  /api/cluster/v2/files/status?share                 → {cursors:{nodeId: seq}, need:{files, bytes}, errors[]}
```

- **Push on change.** After the scanner commits a batch, the node sends `changed` to each peer that shares the project. The peer then pulls `index` from its cursor. Failed notices go to `notify_outbox`. At start, on wake and after a join, `announceReturn` (`server/peer-return.ts:54`) pulls every share from its cursor and sends one `changed`. This is the notify-then-pull model of `server/shared-workspaces.ts`.
- **A new `index_id`** (the peer rebuilt its index) resets the cursor and triggers a full pull.
- **`fetch` frames**: `[u32 header length][header JSON {path, sha256, size} | {path, error}][bytes]`. The server sends a file only if it is in its index with that sha256 and still matches on disk. Otherwise that item answers `changed` and the receiver waits for the next index update.
- **Large files** use `file` with Range and resume from `partials`. This reuses the transcript pipeline (hash while streaming, check, atomic rename) from `shared-transcripts.ts:241-313`. The stall guard aborts after 30 s with no bytes, with no cap on total time.
- **Old `/files/enroll`** keeps exchanging project locations. The `deviceId` field becomes optional and is ignored by new nodes.

### 5.7 Transfer

- **Whole files with whole-file SHA-256** (D2). Block-level deltas are deferred until measurements show large files that change often.
- **Local reuse first.** Before fetching, the engine looks up the sha256 in `local_entries` across all shares. If the content exists on this machine, it is copied with `fs.copyFile(..., COPYFILE_FICLONE)`, which is an APFS clone on the Mac and a reflink where Linux supports it. A new worktree is mostly copies of the project's files, so it costs almost no network.
- **Priority queue**, ours to reorder at any time:
  1. explicit requests (a handoff, a worktree being opened);
  2. `.joint-bob-worktree/**` and other files under 64 KiB in worktree shares;
  3. project files, smallest first;
  4. tickets;
  5. worktree bulk, with `.joint-bob-baseline` last.
- **Batching**: small files go in `fetch` batches, so 10,000 small files take about 40 requests instead of 10,000.
- **Parallelism**: up to 4 requests in flight per peer. Over a relay, each channel moves about 256 KiB per round trip (`relay/protocol.ts:15-23`), and `RelayAgent` pools up to 16 connections per peer, so parallel requests are how relay throughput scales. A dedicated `files` channel kind with a bigger window is a later option.
- **Relay allowance**: bulk sync counts against the relay's monthly byte cap (`relay-server.ts:559`), as Syncthing's tunnel traffic does today. File bytes sent over a relay are shown in Settings → Relay.

### 5.8 Applying a change safely

For each item in `need`:

1. Get the content: a local clone (5.7), or a download into `.joint-bob-sync.<name>.<random>.tmp` in the target directory, with sha256 checked.
2. Check the current local file against the index fingerprint. If it changed since the last scan, rescan that path first; if the change is now concurrent, follow 5.5.
3. Create parent directories after checking with `lstat` that no part of the path under the root is a symlink. Writes never pass through a symlink.
4. Move the previous version to the trash when 5.5 says so, rename the temp file over the target, and set mtime and the exec bit.
5. Record the entry with the remote vector and a new local `seq`.

Path rules apply on receive. The engine rejects absolute paths, `..`, NUL, `/`-only names, paths longer than 4096 bytes and names Windows/WSL can't hold. Paths are normalized to NFC.

On a case-insensitive filesystem (the Mac), two remote paths that differ only by case are a collision. The second one is refused and listed in `errors`, never overwritten.

Symlinks are synced as their target text and never followed. Permissions other than the exec bit are not synced.

A crash between the temp write and the rename leaves only a temp file, which is ignored and cleaned up at the next start. A crash after the rename is detected as a fingerprint mismatch at the next scan, and the file hashes to the remote content.

### 5.9 Readiness and status

- **`ProjectSyncStatus` keeps its shape** (`types.ts:21-28`). `synced` means no `need` rows and every reachable peer's cursor is at its current `maxSeq`. `syncing` comes with `need` counts as `remainingFiles` and `remainingBytes`. `error` comes with per-path reasons. `paused` means the engine is off for the share. `unavailable` means the peer is not reachable. The text changes from "Syncthing …" to "Files …".
- **Handoff gate** (replaces `assertSyncthingFolderReady`). The source rescans the project's shares, notes its `maxSeq`, and waits until the target's `status` shows a cursor at or above that value with no `need`, with a time limit and a progress display. The target puts the share at the top of its queue while a handoff is pending. This is stricter than today's check, which only looks at the local folder.
- **Twins**: `sharingFilesStatus` reads the same cursors instead of `/rest/db/completion`.
- **Takeover**: the fixed 5 s wait in `ownership.js:19-52` becomes the same cursor check, which returns immediately when there is nothing to copy.
- **Worktree merge guard** (open item from 2026-10-11): merging a worktree is refused while its share has `need` rows for that worktree.
- **Startup**: `startup.syncthing` is removed from readiness. The engine starts after readiness and never affects `/api/health`.

### 5.10 Authorization and revocation

- Every request is authenticated by node key and authorized per share. When a project is unshared, the next `index`, `fetch` or `file` request from that peer gets 403, and incoming `changed` notices from it are dropped. The removed peer keeps the copy it already has, as `CLUSTER-SHARING-DESIGN.md` §5 already states. Joint Bob now controls the transport, so stopping it is no longer best-effort.
- The coarse relay gate (`relayPeerRequestAllowed`) is not enough on its own. Each handler checks the specific share.
- In multi-user mode, files are written as the service account through the existing group permissions, as Syncthing does today. The file sync status and settings are admin-only (`MULTI-USER-PLAN.md`).

### 5.11 Caller changes

| Today | After |
|---|---|
| `routes/tasks.ts:74` `ensureTicketWorkspaceFolder()` | removed |
| `routes/projects.ts:110-120` `ensureSyncthingFolder` | removed; the share is derived |
| `server/projects.ts:132-158` move + rollback | removed; the share follows the record |
| `maintenance.ts:75` `reconcileSyncthingProjectFolders` | removed from readiness |
| `project-worktrees.ts:122` `announce()` rescan | `fileSync.changed(shareId)`: scan that path now and notify peers |
| `cluster-helpers.ts:87-175` | `fileSync.peerCaughtUp(peer, shareIds)` / `fileSync.status(shareIds)` |
| `sharing-files.ts` enroll / revoke / caught-up | locations exchange stays; device and folder code goes |
| `twin-sharing.ts:65` resume folders | removed |
| `skill-sharing.ts:53` pause agent-resources folder | removed after cleanup (section 7.4) |
| `routes/projects.ts:66` rescan | `fileSync.rescan(projectId)` |
| `sync-check.ts` folder checks | reads `fileSync.status`; the conflict-copy part stays |
| `relay/syncthing-tunnels.ts`, `relay_syncthing_tunnels` | deleted; the relay server keeps accepting the `syncthing` kind for old machines |
| `settings.syncthing`, env vars, audit fields | optional in P0, removed in P6 |

## 6. Settings and UI

- **Settings → File sync** (admin): each share's state, with a page of per-peer cursors and the `need` queue, errors with reasons, shadow-mode differences during migration, and bytes sent over relays. Lists are paged, not scrolled.
- **Project card**: same badge; "Rescan with Syncthing" becomes "Rescan files".
- **Handoff dialog**: "Waiting for Syncthing" becomes "Copying files to <node>: 312 files, 4.1 MB left".
- **Project settings**: user ignore rules (D11).
- The Syncthing fieldset is removed in P6.

## 7. Migration

### 7.1 Capability and per-project switch

- Nodes advertise `fileSync: 1` in their node descriptor and `/hello`.
- A project moves to the built-in engine only when **every** node it is shared with advertises the capability (D12). That rules out two engines writing the same directory. A project shared with a node on an older release stays on Syncthing. Matan's and Ido's relay-only Macs must update first for the projects they share.
- The project's owner node records `fileSyncEngine: {engine, generation, updatedAt}` in the project's replicated metadata. It is last-writer-wins and versioned, so an older statement can't flip it back.

### 7.2 Shadow mode (before any write)

With Syncthing still moving files, the engine scans, indexes and exchanges indexes with peers but **writes nothing**. Settings → File sync shows, per share, the files where the built-in engine's view differs from the disk on the peer. On a quiet project this should be zero; in-flight edits show up briefly. Shadow mode runs on the Mac and homeserver until the counts stay at zero. It tests scanning, hashing, ignore rules, cost and the protocol on real data with no risk to files.

### 7.3 Cutover for one project

1. The owner checks that every peer's Syncthing folder is idle and caught up, using the existing `syncthingPeerCaughtUp`.
2. The owner records `engine: builtin`.
3. Each node removes Joint Bob's devices from that project's three Syncthing folders, then removes the folder configuration. Syncthing doesn't delete files when a folder is removed.
4. **Bootstrap reconciliation** from the shadow index:
   - same sha256 on both sides: the vectors are merged and nothing is transferred;
   - present on one side only: copied to the other. Absence is never read as a delete at bootstrap;
   - different content: treated as concurrent (5.5), with the loser kept as a conflict copy.
5. The share reports `synced`.

**Rollback** is possible until P6: the owner records `engine: syncthing`, and each node re-adds the folders with today's `ensureSharedProjectFolder`. Syncthing rescans and finds the same content.

### 7.4 Syncthing cleanup (P6)

- Remove every Joint Bob folder from Syncthing's configuration, including the legacy paused ones.
- Delete `.stfolder` from project roots.
- Move user rules from `.stignore` into project settings, then delete `.stignore` when only managed rules remain.
- Stop and remove `joint-bob-syncthing.service` / `com.joint-bob.syncthing` only if Joint Bob installed the unit and no other folders remain in that daemon. Otherwise leave the daemon running and say so in Settings → File sync. On this Mac the daemon is Homebrew's and holds the user's own folders, so it stays.

## 8. Phases

Each phase ships on its own. P0 fixes known incidents even if the rest is never built.

| Phase | Content | Behavior change |
|---|---|---|
| **P0 Decouple** | `src/file-sync/` facade with the operations callers need, with Syncthing behind it as the only backend. Take `startup.syncthing` out of readiness. Ticket and project creation stop depending on Syncthing. `.creating-*` ignore rule. `settings.syncthing` optional. | Small; fixes the 2026-10-06 class of outage |
| **P1 Local engine** | Ignore classes, `file-sync.db`, worker-thread scanner and hasher, `@parcel/watcher`, turn-end rescans, `fileSync.scan` measurements | None (index only) |
| **P2 Protocol + shadow** | `shares`, `index`, `changed`, `status` endpoints; cursors; return hooks; the shadow-difference page | None (no writes) |
| **P3 Transfer + apply** | `fetch`/`file`, priority queue, local clone reuse, partials, apply procedure, conflicts, tombstones, trash | Enabled for test projects only |
| **P4 Integration** | Handoff gate, twin status, takeover wait, merge guard, badges and texts, `sync-check` on the new status, revocation tests, relay parallelism and byte accounting, agent prompt text | Built-in projects behave fully |
| **P5 Migration** | Capability, per-project switch, bootstrap, rollback. Dogfood order: one small project → several → `joint_bob` itself (its checkout is edited from both machines at once) → all. Then relay-only peers. | Per project |
| **P6 Removal** | Delete `src/syncthing.ts`, the tunnels, `install-syncthing.sh`, prerequisite checks, `versions.sh` entries, the CI apt step, the settings field, UI and native Syncthing tests. Run the cleanup in 7.4. Update `README.md`, `agents_readme.md`, `CLUSTER-SHARING-DESIGN.md` §6, `RELAY-PLAN.md` §4.9, `TESTING.md` and `docs/features/clusters.*`. | Syncthing gone |

## 9. Decisions (proposed)

| # | Topic | Proposal | Alternative |
|---|---|---|---|
| D1 | Write model | Several writers with conflict copies, as today: both machines edit the same checkout | One writer per project via project locks; simpler, but changes how people work |
| D2 | Transfer unit | Whole files with whole-file SHA-256, local clone reuse; block deltas later if measured | 128 KiB–1 MiB blocks from the start (partial updates of big files, more code) |
| D3 | No path | No public Syncthing-style relays or discovery; files go where the cluster API goes | Keep a public fallback (needs our own discovery service) |
| D4 | Watcher | `@parcel/watcher` (native, prebuilt for darwin/linux x64/arm64; `node-pty` is already native) | Node `fs.watch` (misses on Linux, one watch per file there) |
| D5 | Rescans | Event-driven only: start, wake, watcher error, turn end, handoff, manual | An hourly safety rescan (a timer, against the no-polling rule) |
| D6 | Conflict names | Keep Syncthing's format so existing code keeps working | A Joint Bob format (touches 8+ places) |
| D7 | Trash | 7 days / 5 GB per share for remote overwrites and deletes; not for worktrees | None (Syncthing's default) |
| D8 | Index storage | Separate `file-sync.db` | Tables in `node.db` (simpler backups, but contention and size) |
| D9 | Threads | Disk work in a worker thread | Main thread with yields |
| D10 | `.git` | Stays node-local; `git-catch-up` unchanged | Sync `.git` (unsafe with two writers) |
| D11 | User ignore rules | Stored in replicated project settings; migration imports each project's existing `.stignore` user rules (on 2026-10-23: guitar_player's `/chords_generator/models` and `local_bucket` mp3s) | Keep a file in the root |
| D12 | Cutover | Per project, all its peers at once, after shadow mode; rollback until P6 | Per peer pair (two engines in one directory) or one big switch |
| D13 | `syncFolderId` | Kept as the share ID in schema and wire format | Rename (breaks signed metadata with older peers) |
| D14 | Syncthing daemon | Leave it running if it holds other folders; remove only our own unit otherwise | Always uninstall |

## 10. Testing

- **Unit**: vector comparison; ignore classes (port the scenarios in `test/syncthing-dependency-filters.test.ts` and the 2026-10-12 `.dev-env` case); conflict names against the regexes in `sync-check.ts` and `shared-paths.ts`; path checks (`..`, absolute, NUL, symlinked parents, case collisions, NFD names); the frame parser with truncated and oversized frames.
- **Engine, in one process**: three engines on temp directories over a fake transport, in the style of `test/relay-transport.test.ts`. Covers:
  - create, modify, delete, rename;
  - concurrent edits, delete against modify;
  - directory delete with regenerable and local content;
  - resuming a large file after an abort;
  - a child process killed between the temp write and the rename;
  - 50,000 small files (requests and wall time);
  - a new worktree, checking that bytes on the wire are about the size of the diff;
  - a missed watcher event caught by the turn-end rescan;
  - an `index_id` reset;
  - revocation answering 403.
- **Real nodes**: extend `test/cluster-sanity.test.ts` and the dev-node harness:
  - share a project and edit on both sides;
  - the handoff gate waiting on a pending file;
  - a relay-only peer through the relay harness;
  - shadow mode reporting zero differences on an idle project;
  - cutover and rollback with Syncthing present.
- **Replace** the native Syncthing tests (`worktree-native-sync`, `twin-native-files`, `twin-legacy-folders`, `twin-idle-enrollment`, `selected-sharing-runtime`) with built-in equivalents before P6, then drop `test/native-syncthing.ts` and the CI install.
- **Performance**: `fileSync.*` operations in `performance.jsonl`. On the homeserver, event-loop busy time must not rise above its level with Syncthing, measured with `scripts/perf-report.mjs` before and after.

## 11. Risks

| Risk | Mitigation |
|---|---|
| An engine bug loses files | Shadow mode first; trash; deletes only from observed tombstones; no deletes at bootstrap; per-project rollback; `joint_bob` migrated late |
| CPU and disk on the homeserver | Worker thread, throttled first hash, scans only on events, measured per phase |
| Mac (case-insensitive, NFD) against Linux | NFC index, collision refusal, tests for both |
| Linux watcher misses | Turn-end and pre-handoff rescans; full rescan on overflow |
| Relay throughput and monthly cap | Local clone reuse, batching, parallel requests, bytes shown in Settings |
| Mixed versions in a cluster | Capability check per project; old peers keep Syncthing until P6 |
| Size of the project | P0 delivers value alone; each phase is independently shippable; P1–P2 change nothing for users |
