# Ticket workspace merge-back — design specification

Approved by GPT-5.6 Sol review, rounds 1–12. Status: **implemented** (see
"Implementation status" at the end for shipped scope and deviations).

## 1. Problem

1. `mergeOwnedTask` (src/server.ts) requires `worktreeBranch`; `createTask`
   (src/tasks.ts) sets `worktreeBranch: null` for fs.cp tickets → merge is dead.
   Archive/delete `rm -rf` the workspace — agent work is stranded.
2. File resolution rejects workspace-absolute paths, then basename-matches inside
   the project root: a same-named project file can open silently (wrong content).

## 2. Decision

Manifest 3-way merge over fs.cp workspaces, no git dependency. Git worktrees
rejected: single-node worktrees, 8 MiB bundle handoff cap, `.git`+Syncthing
corruption, requires git on every node and clean `main`. Git appears only as
manual post-merge commit, never in the mechanism. New dependency: `node-diff3`.

Threat model: confused (not adversarial) agent with workspace cwd — same trust as
existing phases. Trusted state: replicated task record + node-local SQLite.
Untrusted: everything inside the workspace.

## 3. State layout and trust model

Syncthing ignores `.joint-bob/` at every depth but not longer names
(`.joint-bob-attachments/` syncs). Inside the workspace (syncs, untrusted):

- `.joint-bob-baseline/` — baseline CONTENT tree + `manifest.json`
  (`{path: {sha256, mode}}`); diff3 needs baseline bytes, hashes alone are not
  enough
- `.joint-bob-merge/` — `staged/`, `plan.json`, `conflicts.json`

Trusted, replicated on the task record: `mergeState`
(`none | conflicts | resolved | merged`), `conflictCount`, `mergeWarning`,
`mergeTx` (`null | open | committed | rolled_back`), digests of plan.json +
conflicts.json + baseline manifest, baseline per-file hashes.

Node-local trusted: `merge_transactions` journal table in `node.db` (written via
a dedicated `PRAGMA synchronous = FULL` connection; existing connections are WAL
+ default NORMAL, not per-commit durable), backups under
`~/.joint-bob/merge-backups/<taskId>/<txid>/`.

`.joint-bob-baseline/` and `.joint-bob-merge/` are excluded from merge scans and
from fuzzy file search. Applying-node-only crash recovery (documented limitation);
permanent node loss mid-apply → manual recovery, workspace sources stay intact.

## 4. Baseline capture

`createTaskWorkspace` writes the baseline tree + manifest during the same
`copyAllowed` walk (secrets excluded; same filter governs merge-back). Exec bits
captured per file.

## 5. Pure 3-way decision engine (no I/O)

`decide(baseline, workspaceState, projectState) → Plan` with per-file results:
skip / apply / delete / conflict-choice / conflict-text.

- Text conflict ⟺ both changed AND decodable UTF-8 AND ≤ TEXT_FILE_LIMIT;
  oversized text and binaries are choice-only; symlinks/special files are never
  merged (logged unmergeable)
- No-baseline legacy tickets: every changed file is choice-only
- plan.json paths validated for containment before ANY use: realpath nearest
  existing ancestor must be inside the root, remaining segments plain names, no
  symlink escapes; immediate parent re-realpath'd right before temp creation and
  again before rename

## 6. Prepare (trusted code, phase 1)

- Acquire the task merge reservation (§11) — requires no active run, no lease,
  zero open task terminals, no pending handoff, no open transaction
- Run the engine; stage clean results and diff3-merged texts into `staged/`
- Text conflicts staged with uniquely tagged markers:
  `<<<<<<< JB-MERGE <entryId> `, `||||||| JB-MERGE <entryId> `,
  `======= JB-MERGE <entryId> `, `>>>>>>> JB-MERGE <entryId> `
- `conflicts.json` entries: `choice` (allowedChoices with sha256s) or `text`
  (`unresolvedSha256`, generated marker lines, preExistingMarkerLines)
- Digests (plan.json, conflicts.json, baseline manifest) written to the
  replicated task record — the trust anchor
- Re-prepare is an explicit destructive action (wipes resolutions, warns)
- Blocks handoff, manual sends, terminals for the task while reserved

## 7. Resolution protocol

All resolution state lives in `conflicts.json`, hashed into the replicated
record at prepare; only trusted server code rewrites it (agent edits detected by
digest mismatch → choice-only degradation).

- `choice` resolved ⟺ staged file hash equals one of the allowed choice hashes
  (server API writes trusted bytes; agent copying bytes itself validates
  identically)
- `text` resolved ⟺ staged hash ≠ unresolvedSha256 AND all generated marker
  lines absent AND any remaining line matching
  `^(<{7,}|={7,}|>{7,}|\|{7,})( |$)` is in preExistingMarkerLines (compared as
  MULTISETS) AND no `JB-MERGE <entryId>` tag remains anywhere
- Resolution paths: UI panel (take-workspace/take-project/edit marker files in
  the existing editor), the merge agent run (§9), bulk `take=workspace|project`

## 8. Finalize (phase 2) and crash protocol

- Pre-apply: re-hash every affected project path; drift since prepare ⇒ refuse
- Per-project serialization: in-process lock + owner-routed cluster op
- Op record: `{op: write|delete, path, oldSha256, newSha256, oldMode, newMode,
  backupPath, tempPath, createdParents[], createdBackupDirs[]}`.
  Nullability triple: `oldSha256`/`oldMode`/`backupPath` all null or all
  non-null. `newSha256`/`newMode` non-null for writes, null for deletes
- Write op: mkdir + fsync created ancestors (journaled write-ahead BEFORE each
  mkdir) → backup (fsync file + backup parent) → temp file with newMode (fsync)
  → rename → fsync target parent dir. Delete op: backup → unlink → fsync parent
- Journal: `merge_transactions` row, state `planned → applying → committed`,
  per-op progress committed durably in the same transaction; deterministic temp
  paths `<name>.jb-merge-<txid>.tmp`
- Commit point: last op done + all touched dirs fsynced → single durable
  `applying → committed`. No roll-forward. Then replicated task update
  (`mergedAt`, `mergeState: merged`, digests cleared)
- Rollback (reverse order, idempotent, hash-verified): existing-file write →
  restore backup bytes + oldMode (temp+fsync+rename+parent fsync); new-file
  write → unlink; existing-file delete → restore; absent-file delete → no-op;
  then remove orphan temps, delete backup files, rmdir created dirs in reverse
  (parent fsync after each rmdir) → durable `rolled_back`
- Cleanup after BOTH committed and rolled_back: journaled per-artifact progress,
  crash-resumable at the same recovery points as tx recovery
- Recovery runs at startup (before the server accepts mutating traffic), before
  any merge/handoff/archive/project-op on the project, and at owner takeover.
  Outcomes: in-progress/`planned`/`applying` → rollback → park
  `mergeState: conflicts` + degraded warning; `committed` → reconcile to merged;
  NEVER reads workspace files — SQLite row + node-local backups only; after
  recovery, artifacts marked degraded (digests untrustworthy mid-crash)
- Crash tests at every boundary incl. mid-cleanup

## 9. Done trigger and merge agent run

- Every done transition triggers merge: run-completion callbacks (checked AFTER
  the run removes itself from the run maps — `finishTaskPhase` runs while still
  registered, triggering there would always skip), manual status PATCH, board
  drag, creation with initial status done
- Guards: owner node, fs.cp workspace, reservation acquirable
- Zero conflicts or zero changes → finalize immediately
- Conflicts → auto-start merge agent run (product decision; Sol accepted with
  mitigations). Distinct run kind — NOT a TaskPhase:
  - Own registration (`kind: "merge"`), may resume `task.sessionPath` for
    context only; completion NEVER advances taskPhase/status; its completion
    handler = validate staged → finalize or park
  - Post-run verification re-hashes baseline tree + project + non-staged
    workspace paths vs replicated digests; out-of-staged change → park with
    persisted `mergeWarning` (no restoration claim), artifacts degraded
  - Recovery: unfinished merge runs never auto-resume; they park
- Persisted `run_kind` column on tasks (`null | "phase" | "merge"`), set with
  the lease grant, cleared atomically with release — so
  `recoverLocalRunningTasks()` parks merge rows (distinct audit event
  `task.merge.parked`) instead of marking them failed;
  `performUpdatePreparation()` fences merge runs BEFORE abort so failure
  callbacks cannot mark them failed; `activeUpdateRecoveries()`/`recoverTask()`
  never see merge runs
- Resume (agent pass) and Restart (re-prepare) are explicit board actions
- Handoff/manual sends/terminals blocked while reserved

## 10. State transitions

| Situation | Behavior |
|---|---|
| reopen from `none` | no-op |
| reopen from `conflicts`/`resolved` | remove `.joint-bob-merge/` artifacts; count→0; state→none; workspace+baseline unchanged (nothing was applied) |
| reopen from `merged` | remove workspace if still present (merge and archive are separate ops; `createTaskWorkspace` rejects existing dirs) → fresh fs.cp workspace + fresh baseline; clear `mergedAt`, state→none, warning→null, ALL digests |
| legacy fs.cp, not done, no baseline | next done → choice-only prepare |
| legacy fs.cp, already done, no baseline | board shows explicit Prepare / Discard (gates would strand) |
| archived (`worktreePath === null`) | exempt from gates |
| git-worktree ticket (`worktreeBranch` set) | existing merge flow, exempt |

## 11. Reservations and distributed fences

Task-level merge reservation (token-based, non-reentrant):

- Public entry points acquire once and call `…Reserved(token)` internals; run
  callbacks acquire as the outermost holder
- Guards: status PATCH transitions (incl. reopen), `startTaskRun`, Resume,
  Restart, manual finalize, discard, archive, delete, handoff, terminal attach,
  `beginTaskMerge`
- Terminal registration added to terminal sessions (taskId-scoped); attach
  rejects while reserved — closes the TOCTOU where a terminal opens after the
  prepare check

Project-level exclusion (relocation src/server.ts, deletion src/store.ts):

- In-process: project token ↔ task reservations mutually exclude per project
- Cross-node: peer-held fences. `POST /api/cluster/fences/acquire` /
  `/api/cluster/fences/release` — exact static machine-auth paths, no path
  params; holder taken from `response.locals.machineNodeId` (outbound calls use
  the caller's machine token, never `peer.token`; credentials resolving to the
  receiver's own node ID rejected; release requires recorded holder). Project
  alias resolved via `canonicalProjectId()`; unmapped rejected
- Protocol: acquire local token → capture `{membership, revision}` atomically →
  acquire fences on ALL peers (fail-closed on any refusal/conflict/unreachable
  peer, release everything, error names the peer) → operate → release reverse.
  Fences carry a TTL refreshed by the holder so crashes cannot deadlock forever
- `membershipRevision` = sha256 over canonical serialization of exactly what
  `getClusterMembership()` returns (sorted node IDs, peer records, tombstones) —
  content-addressed, receiver-comparable (the node-local
  `cluster_membership_state.generation` is delivery state, NOT usable)
- One per-node `clusterGuard` mutex serializes (through SQLite commit): fence
  validation+grant/release, AND every membership mutation — `saveClusterPeer()`,
  `mergeClusterMembership()`, `assertPeerCanBeRemoved()` path, and
  `updateClusterNode()` (changes name/url/updatedAt = revision fields; reached
  from `/api/cluster/node` and join flows). Membership changes block while any
  fence is live
- Guarantee: mutual exclusion with AT MOST ONE winner; simultaneous acquisition
  may produce zero winners (both get explicit conflicts, retry). No coordinator
  — out of proportion for this cluster size
- Project relocation/deletion also reject when any task has replicated
  `mergeTx = "open"` (belt under the fences)

## 12. Ticket-scoped file resolution (ships first, independent)

- `taskId` param on `/file-resolution`, `/file`, `/file-content`;
  `projectFileLinks` carries it into returned URLs; threaded through cluster
  proxies and machine-auth routes
- Validate task belongs to project; owner-routed; resolution root = ticket
  workspace with realpath containment against it; exact paths resolve before any
  fuzzy search; fuzzy search scans the workspace root
- Frontend adds `state.activeTaskId` to `projectFileApiUrl`
- Regression test: workspace path whose relative path also exists in the project
  root serves WORKSPACE content (the silent-wrong-file bug)

## 13. Enforcement

- Archive/delete blocked while `mergeState != merged` on fs.cp tickets (API +
  board UI; done-column archive button unhidden — board currently hides archive
  on done)
- Explicit Discard action (confirm + audit event) is the only escape
- Board card merge chip: "N conflicts" / "Merging…" / "Merged"; `mergeWarning`
  surfaced

## 14. Implementation order

1. Ticket-scoped file resolution fix
2. State formats + transition policy (this document)
3. Baseline capture + pure 3-way engine
4. Prepare + resolution APIs (+ terminal registration)
5. Finalize (drift check, serialization, journal, recovery)
6. Merge state in TaskRecord/API/board
7. Archive/delete/discard gates
8. Done-transition wiring (incl. initial-done creation)
9. Merge agent run + verification + resume/restart (+ fences infra where first
   needed: fences/journal land with their first consumer)

## 15. Testing

Per TESTING.md: every test watched failing first, at the layer that breaks.
Unit: engine decisions (delete/edit matrix, legacy choice-only, marker
protocol incl. tweak attacks `JB-MERGE`→`JB-MERG`, `<<<<<<<`→`<<<<<<<<`,
multiset dupes), baseline roll, journal op semantics. API: prepare/finalize/
resume/discard, done wiring, gates, taskId resolution (silent-wrong-file
regression), terminal-rejected-while-reserved, fences (all three orderings with
deterministic barriers), membership/fence races (updateClusterNode included).
Crash matrix: every journal boundary, mid-cleanup commit+rollback. Cluster:
two-node merge owner-only, artifacts arrive before finalize allowed, fences
cross-node (filesystem delivery simulated explicitly — harness runs no real
Syncthing). Browser: board merge states, conflict panel, resume/discard.
Restart matrix: hard restart mid pi/claude merge run, graceful update abort.

## 16. Deferred

Rolling re-sync (auto re-baseline of untouched files at quiescent boundaries
with pre/post hash checks) — correct without it; revisit after real usage.
Auto git commit after merge — manual for now.

## 17. Implementation status

Shipped (all tests green: unit, API, board UI source assertions; `npm test` 573/573;
typecheck/build clean; `test:ui` 19/19):

- §4 baseline content capture in `createTaskWorkspace`, taken from the just-written
  workspace copy (never the live source, so workspace and baseline cannot disagree)
- §5 pure 3-way engine with legacy choice-only degradation (`legacy` flag)
- §6 prepare with diff3 + tagged markers; `copyAllowed` governs all merge scans
- §7 resolution protocol: marker-attack hardening (tag-anywhere rejection, `{7,}`
  widths, multiset pre-existing lines), hash-verified choice resolution incl.
  delete-side decisions, apply-time staged-byte verification for trusted ops
- §8 journal: SQLite row via synchronous=FULL connection, backups outside the
  workspace, C6 containment (realpath'd roots, symlink-ancestor rejection),
  full old-state triples for writes AND deletes, hash-verified idempotent
  rollback, journaled cleanup progress, committed rows reconciled to task state,
  fail-closed rollback (mergeTx stays open until rollback succeeds),
  per-project serialization, recovery before listen
- §9 done-trigger on every transition path incl. the cluster mirror; distinct
  merge run kind with persisted `run_kind`, park-with-warning on failure/restart,
  exclusion from update recovery, reservation-held completion
- §10 reopen transitions (conflicts reopen allowed, artifacts cleaned; merged
  reopen gets a fresh workspace+baseline), unmergeable symlinks block as explicit
  choice entries, exemptions
- §12 ticket-scoped file resolution (shipped first)
- §13 gates (archive/delete/discard incl. project deletion guard) + board chip/menu
- Journal tests isolated (env set before dynamic import; verified zero rows in the
  production node.db)
- `node-diff3` pinned to the public npm registry in the shrinkwrap

Round-2 review fixes (all in):

- finishMerge releases the run lease before acquiring the reservation; the
  completion catch never clears an open mergeTx (fail-closed fence)
- acquireTaskMergeReservation rejects `mergeTx === "open"`
- recovery is fail-closed (exit(1) instead of listening), reconciliation errors
  propagate, rolled-back rows return until reconciled
- rollback is transition-strict: write-new only unlinks content this transaction
  created; restores happen only from verified backups when the current state is
  exactly the transaction's new state; third-party content refuses rollback
- created directories are journaled before they exist; cleanup keeps its own
  durable per-artifact progress column and resumes after crashes
- assertPathContained lstats before resolving; staged writes validate against the
  staging root (stagedPathFor)
- baseline manifest digest is anchored on the task record at creation; prepare
  degrades to choice-only when the anchor no longer matches
- post-run verification rehashes the baseline content tree and the project side
  against the plan, not just artifact digests
- apply-time staged-byte verification covers clean text merges too; only
  conflicted text entries are exempt (their resolution IS the change)
- choice resolution supports the project-deleted side, verifies workspace
  absence on workspace-deleted selections, and hash-checks chosen bytes
- merge-resume accepts `resolved` (finishes instead of 409); the done-column
  archive item is visible-but-disabled while a workspace is unmerged

Round-3 review fixes (all in):

- project-deleted choice side: accepting the project's deletion records a delete
  decision; both deletion selections verify the side is still absent
- staged-hash exemption narrowed to paths with unresolved text entries at prepare
  (clean text merges verified like every other trusted write)
- mkdir journaling: tracked list updated, journal persisted, THEN the directory
  created; backup directories follow the same write-ahead order
- rollback runs assertOpContained per op and cleans created directories
  regardless of the file branch outcome
- cleanup advances per-artifact progress only on success/ENOENT; failures retry
  on the next recovery
- baseline anchor: missing anchor degrades to choice-only (never trusts an
  existing manifest); prepare never replaces the creation-time anchor; reopen
  re-anchors the freshly captured baseline
- post-run verification compares the manifest digest against the recorded anchor
  and detects unlisted files in the baseline tree
- handoff start rejects open transactions, held reservations and unresolved
  merge states; relocation checks open transactions and reservations separately
- pre-mutation recovery: beginTaskMergeIfNeeded settles interrupted transactions
  for the project before touching state
- merge API requires status done and rejects already-merged reruns
- UI: conflict-picker dialog (binary/delete choices per file, staged text files
  open in the existing editor) wired to merge-resolve

Round-4 review fixes (all in):

- unanchored (legacy) baselines are never trusted: prepare requires a recorded
  creation-time anchor that matches exactly; parking never promotes the workspace
  digest to an anchor; unanchored tickets record no baseline digest
- baselineTreeProblems flags unlisted files in the baseline tree
- rollback validates containment per op BEFORE orphan-temp removal; created-dir
  cleanup is never skipped by file-branch continues (they are gone)
- cleanup stops and throws on a stuck artifact instead of advancing past it
- staged deletion resolution propagates containment failures (no unchecked
  path.join fallback)
- the cluster handoff mirror carries the same merge guards as the public route
- project deletion fences on active merge reservations as well
- the conflict picker passes the ticket's taskId to the staged-file editor
  (explicit scope, not ambient activeTaskId)
- non-owner replicas see merge state: the board branches on replicated
  mergeState even without a local worktreePath; the conflict-list GET
  owner-routes to the task owner through a new machine-auth cluster endpoint

Round-5 review fixes (all in):

- baseline bytes are rehashed against the anchored manifest before diff3 trusts
  them (manifest digest alone is no longer sufficient)
- conflict resolution never invents a baseline digest key for unanchored tickets
- journal ops carry the ACTUAL validated staged hashes (resolved text entries and
  agent-staged choices), so rollback recognizes them instead of refusing
- rolled-back transactions complete their cleanup on re-entry; final backup-dir
  removal failures propagate instead of being swallowed
- reservations are tracked per task WITH project id; deletion/relocation fence on
  the project's exact reservation (a discard clearing worktreePath cannot dodge it)
- ticket-scoped file requests route to the task OWNER regardless of the ambient
  activeNodeId (replicas can list conflicts and edit staged files)
- post-run confinement: every workspace path the plan recorded is rehashed; any
  change outside the staging area parks the merge
- mode-only changes (chmod) participate in the decision matrix

Round-6 review fixes (all in):

- final backup-directory cleanup failures propagate (non-ENOENT)
- project deletion fences solely on projectHasMergeReservation (the discard path
  clearing worktreePath cannot dodge it)
- file-resolution routes on the owner-derived effectiveNodeId
- choice entries record workspace hashes and workspace modes; confinement treats
  recorded-null-but-now-present as a change; choice resolution carries the chosen
  side's mode into the plan
- divergent workspace/project modes become explicit mode-conflict choices
- rollback restores modes (content equality alone no longer skips the restore);
  all stat modes are masked to permission bits so file-type bits cannot break
  comparisons

Round-7 review fixes (all in):

- every captured mode is masked to permission bits (service oldMode capture included)
- the decision matrix is mode-aware in every branch: both-created with divergent
  modes, workspace-delete vs project chmod, and project-delete vs workspace chmod
  all become explicit choices
- choice resolution preserves the prepare-time workspace hash and both modes
- choice conflict entries record per-side modes; staged validation requires the
  staged mode to match the selected side, so equal-content mode conflicts are
  distinguishable and the applied mode is the chosen side's
- plan entries record prepare-time project and workspace modes; the pre-apply
  drift check and the post-run confinement check compare modes, not just content

Round-8 review fixes (all in):

- the engine's no-baseline, workspace-deleted and project-deleted branches are
  mode-aware (both-created mode divergence, delete-vs-chmod in both directions
  are explicit choices); covered by new engine tests
- finalize applies the staged file's own validated mode, so an agent-staged
  project side of a mode conflict applies the project's mode
- delete-side choice resolution preserves projectMode, workspaceMode and
  workspaceSha256 from the prepare-time entry (drift detection stays armed)
- new marker-suite test: equal-content mode conflicts resolve only when the
  staged mode matches one of the recorded sides

Round-9 review fixes (all in):

- finalize keeps prepare-time stagedSha256 and mode as the integrity anchor for
  every path except successfully validated text resolutions (their staged bytes
  and mode are read after validation); tampered staged files fail apply-time
  verification instead of self-updating the expectation
- choice resolution chmods the staged file to the chosen side's mode, so
  selecting an executable side applies 0755 (API-tested)
- engine tests cover both-created mode divergence, workspace-delete vs project
  chmod, project-delete vs workspace chmod, and identical-bytes-and-modes skip

Round-10 review fixes (all in):

- agent-staged choices refresh their journal hash and mode from the validated
  staged bytes (validator matched them to a recorded side first), so equal-byte
  mode conflicts apply the selected side's mode
- the apply-time staged-source callback verifies EVERY write op against the
  journal's newSha256 (anchored paths pin the prepare-time digest; refreshed
  paths pin the post-validation hash) — no concurrent-edit window remains
- choice resolution verifies the source MODE against the recorded side mode in
  addition to the content hash
- API test covers a real mode conflict: executable ticket side vs plain project
  side, resolved take-workspace, final project mode 0755

Round-11 review fixes (all in):

- validateStagedConflicts returns a VALIDATED snapshot (sha256 + mode per
  resolved path); the journal records that snapshot for refreshed paths instead
  of rereading the filesystem between validation and journaling
- the apply-time read remains, but it is verified against the journal's
  newSha256 for every op, so a mutation in that window fails the apply
- choice resolution reuses the VERIFIED mode for the staged chmod and the plan
  entry (no second stat)
- writeDurable chmods the file handle to the exact mode before fsync, so umask
  cannot turn 0664 into 0644
- backups revalidate the source hash against the drift-checked oldSha256 before
  writing; a concurrent project edit aborts instead of being overwritten

Round-12 review fixes (all in):

- backup file names are hex-encoded op paths (`a/b` vs `a__b` can never collide)
- backups read once: the hashed buffer IS the backed-up buffer (no ABA window);
  the old state is revalidated at mutation time, immediately before the apply
  write, including mode equality
- the old-state capture never downgrades an expected-existing target to absent
  and rejects mode drift against the plan's projectMode
- all journal writes go through writeAll (partial-write loop) with an explicit
  handle chmod before fsync; backups use the same protocol

Known deviations from the approved design (deliberate, flagged for review):

1. **Distributed fences (§11)**: local task reservations + per-project merge lock +
   replicated `mergeTx` + mergeState guards on relocation, workspace-type change and
   project deletion are implemented; the peer-held-fence protocol with membership
   revisions and `clusterGuard` is NOT. Cross-node relocation/deletion during an
   open merge retains a narrow TOCTOU window.
2. **UI**: board chip + menu actions (resume/restart/discard); no dedicated conflict
   panel — marker files are edited through the existing ticket-scoped file editor.
   Board coverage is source assertions; the merge behaviour itself is covered by
   server tests.
3. **Cluster**: merge actions owner-route through one mirror endpoint; no two-node
   merge journey test in `cluster-sanity` yet.
4. **Update-abort fencing (§9)**: merge runs are excluded from update recovery
   records; abort relies on the run failure callbacks parking the ticket rather
   than pre-abot fencing.
5. Rolling re-sync deferred (per §16).
