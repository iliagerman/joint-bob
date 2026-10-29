# Ownership sync scope implementation plan

**Goal:** Ownership takeover waits for the conversation's working folder, not every worktree in its project.

**Spec:** User approved the chat description: normal conversations check only the main project; worktree conversations check and prioritize only their worktree; the banner shows that scope; transcript and ownership checks stay unchanged. Background synchronization continues.

**Architecture:** Add a scoped status operation in the file-sync facade, exposed through an authenticated project route. The existing ownership wait supplies the selected session's worktree ID. Reuse the worker's pending-prefix counts and priority operation.

**Tech stack:** TypeScript, Express, browser JavaScript, node:test and Playwright using the disposable repository harness.

## Constraints

- Work on the existing, current main checkout. No new branch or worktree.
- No production data or sync-setting changes.
- Keep Syncthing and remote-destination grace waits, the two-minute limit, and transcript/ownership mutation logic unchanged.
- Validate optional worktree IDs at the HTTP boundary.
- Keep global project sync reporting unchanged outside takeover.

## Review focus

- An unrelated worktree backlog must not change a normal conversation's count or delay it.
- A worktree count must exclude siblings and the main project; priority must use its exact prefix.
- An index still catching up must not report that the selected folder is current prematurely.
- A failed status request must be visible and must not trigger an ownership mutation.
- Cancellation must discard an in-flight status result.

## Task 1: Scoped status and ownership wait

Files: `src/file-sync/facade.ts`, `src/file-sync/db.ts`, `src/file-sync/need.ts`, `src/file-sync/protocol.ts`, `src/server/routes/projects.ts`, `public/app/ownership.js`, `public/sw.js`; tests in `test/file-sync-facade-dispatch.test.ts`, `test/file-sync-facade.test.ts`, `test/file-sync-need.test.ts`, `test/ui/ui-ownership-sync.test.ts`, `test/ui/ui-cluster-login.test.ts`.

Interface: `conversationFilesStatus(project: ProjectRecord, worktreeId?: string): Promise<FacadeSyncStatus>`; GET `/api/projects/:projectId/sync/status` accepts optional UUID `worktreeId`, responds `{ syncStatus }`.

- [x] Write and run failing browser regression showing the project-wide count instead of the selected worktree count.
- [x] Add facade tests for main-project isolation, exact worktree counts and priority, index catch-up, worker states and errors.
- [x] Add route checks for authenticated access, missing project and invalid worktree IDs.
- [x] Implement scoped facade and route, then connect ownership wait and bump the service-worker cache.
- [x] Run focused tests, typecheck, build, full non-browser suite and browser suite; report failures precisely.
- [x] Review diff and prepare an atomic commit containing only this change.

## Review and verification

The first browser regression reproduced exactly `77569 files, 828.9 MB` instead of `3 files, 3.0 KB` before implementation.

Independent review identified whole-share error and rescan flags leaking into worktree readiness. Added failing regressions, then scoped error/blocked counts through the existing pending-prefix operation. Incremental sibling rescans no longer hold the selected worktree after the first local index. Root failures, the first index and peer-index catch-up still apply because they can affect the selected worktree. This extends the existing local worker result, not the peer protocol.

Final verification after that correction:
- 54/54 file-sync core, pending queue, facade and route tests passed.
- 51/51 cluster-sanity and ownership/cluster-login/transcript-conflict browser tests passed.
- `npm run typecheck`, `npm run build`, `git diff --check` passed.

Broad verification is **not green**:
- `npm test`: 2,935 passed, 2 failed, 11 skipped. `test/browser-agent.test.ts`, "Claude new and resumed spawns receive browser identity and keep attached environment", failed during temporary-directory cleanup with `ENOTEMPTY`; it failed the same way in isolation. `test/skill-scoped-sharing-api.test.ts`, "workspace and conversation skill grants reach only nodes sharing the project, load only there, and revoke", failed with `Project not found`, then passed in isolation.
- `npm run test:ui` reached the one-hour command limit without completing. Failures outside this change were `test/ui/ui-bob-goal.test.ts` status-toast timeout; `test/ui/ui-by-the-way.test.ts` action-mode persistence assertion; and desktop/phone cases in `test/ui/ui-dropdown-styling.test.ts` for missing chevrons on `webhooks-tags-managed` and `cron-tags-managed`.
- The broad run also exposed missing harness initialization in the new synthetic ownership test. It now explicitly loads harness metadata before supplying a synthetic conversation, and passed in the final focused run.

No production sync settings, files or ownership records changed. Deployment was not performed.
