# Conversation side chat implementation plan

**Goal:** Add a persistent, tool-disabled Chat tab beside Activity, opened by `/bob-btw` without changing the source conversation.

**Architecture:** Read the transcript afresh per question, run an isolated text-only harness session using the existing review runner, and store separate per-user conversation history in SQLite. Reuse harness/model controls and the Activity sidebar. Defaults live under Settings → Conversations.

**Tech stack:** TypeScript, Express, SQLite, browser JavaScript, existing harness runtimes.

**Spec:** Approved in this conversation: full conversation context, read-only, independent history preserved until Clear history, harness/model selectors and defaults including hiding selectors, `/bob-btw` opens Chat.

## Constraints
- Stay on main; preserve unrelated working-tree changes.
- No tools, source prompts, source transcript writes or source runtime changes.
- Never silently truncate source context. Report model context errors.
- History and defaults are per user and persist on the serving node. They do not replicate between nodes.

## Task 1: Read-only backend
- [x] Write failing tests for durable isolated history and full context; add API authorization and server restart coverage.
- [x] Add `src/conversation-chat.ts` for storage and prompt construction.
- [x] Add `src/server/routes/conversation-chat.ts` for authorized history, settings, and question endpoints, using `loadConversationMessages` and tool-disabled `runGitReview`.
- [x] Register routes in `src/server.ts`.
- [x] Run focused tests and typecheck.

## Task 2: Sidebar and defaults
- [x] Add browser coverage for Chat tabs, persistent messages, clear, selector visibility defaults, and `/bob-btw`.
- [x] Add markup and styling to `public/index.html` and `public/styles.css`.
- [x] Add `public/app/conversation-chat.js`, reuse model controls and guard stale responses by conversation identity.
- [x] Change `public/app/by-the-way.js` to open Chat, not clone a writable conversation.
- [x] Load side-chat defaults from `public/app/summary-model-settings.js`.
- [x] Run focused browser regressions, typecheck and build; inspect diff.

## Verification

Passed: `npm run typecheck`, `npm run build`, and nine tests from:
- `test/conversation-chat.test.ts`
- `test/conversation-chat-api.test.ts`
- `test/ui/ui-by-the-way.test.ts`
- `test/ui/ui-activity-panel.test.ts`

The API test verifies source transcript bytes are unchanged after asking and clearing, and verifies history/defaults survive a server restart. The browser test checks desktop/mobile, reload persistence, both tabs, and hiding selectors through Settings.

`npm test` timed out after 1,200 seconds. It reached 1,952 test results with these 11 failures, outside the side-chat tests. Not a green full suite. The local run log is under `/tmp/joint-bob-side-chat-tests.*`.
- agent git refuses branch and worktree creation but allows everyday commands
- push history lists each push with its own commits and skips fetches
- a push whose release notes are already written goes out in one run
- a push missing its release notes writes them, commits them, and still goes out in one run
- the release push refuses to run outside main
- workspace and conversation skill grants reach only nodes sharing the project, load only there, and revoke
- transfers committed task branches by verified bundle
- creates each ticket on an isolated branch and worktree
- merges committed ticket work into clean main
- aborts a conflicting merge and leaves main clean
- rejects merge when ticket worktree has uncommitted changes

Follow-up queue added after user confirmation: POST accepts questions immediately with 202, stores a per-user/per-conversation FIFO, and one worker answers them serially. Waiting questions survive page reload. Push invalidations update the sidebar without polling, including after reconnect. Question IDs prevent duplicate acceptance; errors are shown on the failed question and do not discard follow-ups. Clear remains unavailable until the queue is idle.

API coverage verifies FIFO order, duplicate IDs, clearing while busy, and unchanged source transcript bytes. Browser coverage sends three questions while the first answer is held, checks queued labels, reloads, then verifies three answers appear automatically in order. No source runtime is opened; `useTools: false` invokes the existing `setTools([])` boundary. Conversation switches invalidate pending UI results. Cross-window and interrupted active-answer recovery are not covered by browser tests. Remaining waiting questions resume when an authorized user reopens Chat after a server restart; an interrupted active question is not automatically replayed.
