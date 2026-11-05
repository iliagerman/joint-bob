# Control center: what a feature may build on

Read first: `docs/superpowers/specs/2026-11-04-control-center-design.md` (the numbered goals), `docs/superpowers/plans/2026-11-05-control-center.md` (status), `docs/control-center.md`, and the visual reference `mockups/command-center.html` (open the HTML; it shows each feature as the user approved it). Real code to read for patterns: `public/app/control-center.js`, `public/app/control-chat.js`, `src/server/bob.ts`, `src/control-center/*`, `src/server/routes/control-center*.ts`, `test/control-center-*.test.ts`, `test/ui/ui-control-center.test.ts`.

## Primitives that already exist

**A tab.** `public/app/control-views.js`: `createControlViewElement(id)` gives you a container; `registerControlView({ id, title, order, element, onShow })` adds the tab (the live board is order 0; use 10, 20…); the returned handle has `setBadge(n)`. Build the view's DOM inside your element. Draw into it when the tab is shown (`onShow`) and when your data changes.

**Card buttons.** `public/app/control-cards.js`: `registerCardAction({ id, label, title, order, visible(card), run(card) })` adds a button to every board card's action row; `registerCardDecorator((element, card) => …)` adds anything else to a card; `registerBoardTool({ id, label, title, run })` adds a button to the board's toolbar. A `card` has `projectId, projectName, conversationId, sessionId, path, title, column ("running" | "review"), agentId, agentLabel, agentModel, executionNodeId, turnRunning, backgroundRunning, summary, autoRespondActive, startedBy`.

**Bob's timeline and buttons.** `src/control-center/bob-store.ts`: `bobDatabase()`, `appendBobMessage(db, accountId, { role: "bob" | "system" | "user", text, via, projectId, projectName, importance, actions })` where `importance` is one of `needs-ok | urgent | needs-you | report | done | fyi` (the chat labels and filters by it), and `readBobSettings(db, accountId)` (`monitoring: false` means the person paused Bob: do nothing on your own). `src/control-center/bob-actions.ts`: `registerBobAction(actionId, async ({ session, db, message, action }) => BobMessage[] | void)` is what a button on a message does; put `{ id, label, style: "primary" | "warn", data }` in the message's `actions`. A button runs once and comes back if the handler throws.

**What Bob knows.** `src/control-center/bob-hooks.ts`: `registerBobContextProvider(name, async (turn) => ({ text, via? }) | null)` adds text to what Bob's agent is shown before it answers (and a note under the reply); `registerBobExchangeObserver(name, async (turn, reply) => …)` hears about each finished exchange.

**The board and projects.** `src/server/control-center-board.ts` `loadBoard(session)`. `projectsWithSharedNames()`, `sharedProjectSessions(project, userId, accountId)` for conversations. `runGitReview` (`src/server/git-review-run.ts`) runs a read-only agent for text answers.

**Decision model.** `src/control-center/decisions.ts`, `src/classifiers/typesafe.ts` (`askSystemOneChoices` sends several Choice questions in one request), `bobDecisionModel()` in `src/server/bob.ts`. Below Bob's saved confidence threshold a decision is not used (`needsAgentDecision`).

**Tests to copy.** Unit: `test/control-center-bob-store.test.ts`. API with a signed-in node: `test/control-center-api.test.ts`. Browser: `test/ui/ui-control-center.test.ts` (mocks the control center routes in the page's `fetch`; the real server answers the rest).

## What you may edit

Your own files only, already created as empty stubs and already imported everywhere they must be:

- `src/server/routes/control-center-<name>.ts` (routes; you may add more files under `src/control-center/` and `src/server/` named for your feature; if you add a **new** server route file, import it from your stub, not from `src/server.ts`)
- `public/app/control-<name>.js` and `public/control-<name>.css` (if you add a **new** client module, import it from your stub file; if you add a new file under `public/`, add it to the `APP_SHELL` list in `public/sw.js`: a test checks every module and asset is listed and exists)
- your tests: `test/control-center-<name>*.test.ts`, `test/ui/ui-control-<name>.test.ts`
- `docs/control-center.md`: add one short section for your feature

Do **not** edit `public/index.html`, `public/app/elements.js`, `public/app.js`, `src/server.ts`, `src/preferences.ts`, `src/server/schemas.ts`, `public/app/control-center.js`, `control-chat.js`, `control-views.js`, `control-cards.js`, `src/server/bob.ts`, `src/control-center/bob-*.ts`, `board.ts`, `decisions.ts`, or `public/styles.css`. If you truly need a change there, make the smallest additive edit, re-read the file right before editing, and say exactly what you changed in your report. Other agents work in the same tree at the same time. Some files carry another session's unrelated uncommitted edits (`src/server/webhooks.ts`, `src/webhooks.ts`, `src/assistant-telegram.ts`, `src/server/telegram.ts`, `src/webhook-telegram.ts`, `public/app/activity-overview.js`, `public/assistant/resources.js`): if you must touch one, edit surgically and never overwrite the file.

## Rules

- Follow the repository's own rules (`AGENTS.md`/`CLAUDE.md` in the repo and the global instructions): smallest clear implementation, no defensive code for impossible states, validate at boundaries (zod on every request), no silent failures. No `localStorage`/`sessionStorage` (a test forbids Web Storage); per-person state goes in the account (your own table in `clusterV2Database()` keyed by `accountId`, with `CREATE TABLE IF NOT EXISTS`).
- UI: lists fit the height and page instead of scrolling (a "paginate, never scroll" rule); keep to the look of the existing control center and the mock; every interactive element gets a `data-testid`.
- Anything production-related or destructive Bob does must go through the person's confirmation (a message with a `needs-ok` button); never approve a Guardian review for the person.
- Never run `git add`, `git commit`, `git stash`, `git checkout` or create branches or worktrees. Do not run the whole test suite. Run only your own test files with `npm run test:file -- <file>`, and `npx tsc --noEmit` after server changes. Other agents run tests at the same time, so a timing failure may be load: rerun the file alone before concluding. UI tests: run one file at a time.
- Do not use real credentials, production data, or the live browser executor; UI tests use the repository's own fixture (`nativeUiFixture`).
- Finish the feature: backend, client, tests (unit, API, UI) and the docs section. A feature that only works in a mock is not finished.

## Report

When done, report: what you built (files), what you verified (commands and results), what you could not do or decided on your own (so the owner can redirect), and any shared-file edit you made.
