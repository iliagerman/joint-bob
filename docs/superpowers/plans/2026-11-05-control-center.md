# Control center: implementation plan

Design: `docs/superpowers/specs/2026-11-04-control-center-design.md` (goals 1–28). Mock: `mockups/command-center.html`. Decision this plan adds: **the control center replaces the Canvas** (same toolbar icon and keyboard toggle) and **the Canvas is deleted** afterwards.

## What the review found

- The server already knows what the board needs. `GET /api/running` lists running sessions per project (`src/server/routes/sessions.ts`); each `SessionSummary` carries `turnRunning`, `backgroundRunning`, `reviewState` (`running | needs_review | reviewed`), `executionNodeId`, agent, model; `storedDigest(projectId, conversationId)` (`src/conversation-digest.ts`) gives each conversation's running summary, and the digest runner pushes updates to open pages.
- Assistants (`src/personal-assistants.ts`, `src/classifiers/conversation-routing.ts`, `src/assistant-collaboration/*`) already route a message among saved topics with TypeSafe or Laya and let one assistant ask another. Bob is built on them, not beside them.
- Auto respond (`src/conversation-auto-respond.ts`), Guardian (`src/guardian/*`), scheduled tasks (`cron_tasks`), webhooks, dashboards, the Telegram assistant bridge and ownership transfer all exist and are reused.
- **The Canvas is not self-contained.** It is `public/canvas.js` (1214 lines), `public/canvas-layout.js` (327, which also holds the chord/keymap code the conversation switcher and `app.js` use), `public/app/cluster-canvas.js` (a different thing: the cluster map, kept), iframe "pane mode" in `public/app.js`/`shell.js`/`focus-input.js`, `src/canvas-shortcuts.ts` + `src/canvas-keys.ts` with their tables, API routes, replication and preferences (`src/preferences.ts`, `src/replication.ts`, `src/account-keys.ts`, `src/server/replication-v2.ts`, `roaming.ts`, `http-auth.ts`, `browser-agent.ts`), `canvas_shortcut_*` tables in `node.db`, about 25 UI/unit tests, and README/TESTING/docs mentions. Removing it is a project of its own and must not strand data or break the conversation switcher.

## Phases

Each phase ends with passing tests (`npm test`, `npm run test:ui` for UI) and ships on its own.

### Phase 1: board and shell (replaces the Canvas entry)

1. `src/control-center/board.ts`: build the board from `sharedProjectSessions` for all visible projects: only running sessions and `needs_review` sessions, each with project, title, agent, model, node, started-by (user, Bob, schedule; from conversation metadata, "user" until Phase 3), `turnRunning`, elapsed, `reviewState`, and the stored digest summary line.
2. `src/server/routes/control-center.ts`: `GET /api/control-center/board`; registered in `src/server.ts`. Schema-validated, no new storage.
3. Client `public/app/control-center.js` + `public/control-center.css`: the screen from the mock (project list left, board middle, project filter chips, Grouped/Free layout with reset, color picker per card, Watch/Take control/Story/Overview/Dashboard buttons wired to existing actions), polling-free: refreshed from the existing running-change push (`noteUnannouncedRunChanges`) and a refresh on open.
4. Layout wiring: the Canvas icon (`#openCanvasButton`), `toggleCanvasView` and Esc now open and close the control center; the canvas panel stays reachable only until Phase 2.
5. Per-user layout (card colors, free positions, project filter, chat side and width) stored through the existing preferences route.
6. Tests: unit for `board.ts` (grouping, filtering, digest line), route test, UI test (open, filter, color, reset, open a card).

### Phase 2: delete the Canvas

1. Move what other code needs out of `canvas-layout.js` (chord and switcher key helpers used by `conversation-switcher.js`, `app.js`) into `public/switcher-keys.js`.
2. Delete `public/canvas.js`, pane mode (`canvasPaneMode` in `app.js`, `shell.js`, `focus-input.js`, `layout.js`), canvas markup in `index.html`, canvas CSS in `styles.css`/`focus.css`/`browser.css`, "Add to canvas" button, canvas shortcut dialogs.
3. Server: delete `src/canvas-shortcuts.ts`, `src/canvas-keys.ts`, their routes, preference keys and replication entries; add a migration that drops `canvas_shortcut_*` tables and removes canvas keys from stored preferences (one-way, safe to run twice). Twins on older versions keep ignoring unknown keys.
4. Delete the canvas tests; update tests that only mention it (`ui-smoke`, browser-login suites that embed browsers in the canvas, `source-invariants`).
5. README, TESTING.md, CHANGELOG, docs; remove `docs/features` references if they describe the canvas (the cluster map stays).

### Phase 3: Bob (chat, routing, delegation)

1. Bob is a built-in assistant per user (`src/control-center/bob.ts`) with settings (harness, model, effort, decision model, confidence threshold default 90).
2. `src/control-center/decisions.ts`: batched decision-model questions (kind, project, conversation, short or long, memory topics, urgency, labels) via `src/classifiers/typesafe.ts`; project choice split into parallel groups; below the threshold, Bob's agent decides; no model available: agent decides.
3. Delegation: start or continue a conversation in a project with the same harness as Bob unless told otherwise; mark "started by Bob"; list under normal conversations.
4. Chat panel with project and importance labels and filters (stored on each message).
5. Watch/Take-control lease and monitor pause.

### Phase 4: auto respond, Guardian, memory

1. Bob turns auto respond on or off per conversation and is notified when it ends (hook in `conversation-auto-respond.ts`).
2. Guardian rule "production or destructive" ships as a preset, set to ask, applied to Bob's conversations; Needs-your-OK items surface on the board, in chat and in Telegram.
3. Memory topics: markdown files with an index and links (`~/.joint-bob/control-center/memory/`), topic selection by the decision model, changes list with Keep/Edit/Revert and "ask before saving".

### Phase 5: automations, triggers, dashboards, moves

1. Automations tab over existing cron tasks and webhooks (CRUD), Bob-owned schedules (morning and evening report).
2. Incoming triggers: urgent in chat, rest in the bell.
3. Dashboards tab and per-card button (reuses dashboards).
4. Move jobs: single, bulk, "stop and move now" with the continue message, through the existing ownership transfer.

### Phase 6: assistants, Telegram, phone

1. Assistants rail (XL) or tab, click opens the assistant's chat; Bob asks whoever the user may ask.
2. Telegram: Bob's bot linked only to the user, everything the chat can do including approvals.
3. Phone view: chat first with the agents sheet.

### Phase 7: docs and clean-up

`docs/control-center.md`, README, CHANGELOG, final test run on the Mac and the homeserver.

## Status (2026-11-06)

All 28 goals of the design are implemented, each with server, client and tests, and released (2.213 to 2.215); `docs/control-center.md` describes what a person sees and `docs/superpowers/plans/control-center-contract.md` what a feature builds on. Added after the design, at the person's request: the review check (is stopped work really done), Bob creating and arranging workspaces, projects and conversations, and a single board layout grouped by project.

- **Canvas removed.** The canvas workspace, pane mode, conversation shortcuts, the `canvas_shortcut*` tables and the saved canvas layout are gone; the toolbar icon and toggle shortcut open the control center. The app-wide keyboard shortcuts stay, under their own names (`public/keymap.js`, `public/app/shortcuts.js`, `src/shortcut-keys.ts`). Only the stored and sent name of the shortcut preference, `canvasKeymap` (column `canvas_keymap`), keeps the old word, so saved preferences, roaming profiles and older pages still match. Older machines keep sending `canvas.shortcut` events and `canvasLayout` preferences; both are accepted and dropped.
- **Board, Bob, tabs.** One board layout (lanes grouped by project), colors, project filter, Watch / Take control over the board, driver ribbons and review-check marks; Bob's chat with saved timeline, Markdown replies, project and importance filters, resize and left/right, settings (harness, model, effort, threshold, auto respond, review check, pause); tabs for project overview, memory, automations, dashboards, moves, triggers, assistants and clusters; phone view; Telegram (text). Colors, filter and chat placement are saved with the account's preferences (a test forbids Web Storage).
- **Across machines.** The person's chat with Bob (`control.bobMessage`), memory topics, that they use Bob with Bob's settings (`control.bob`), and review-check results (`control.reviewCheck`) replicate to the person's twins and roaming machines; a button pressed on a machine that did not write the message is run on the machine that did (`POST /cluster/control-center/bob/action`, twins only). Reports, triggers and the Telegram link stay on the machine that set them up.
- **Limits.** Bob's own actions (moves, stopping turns, changing or deleting automations, arranging projects) wait for the person's button in the chat rather than a Guardian review. Bob's Telegram bot reads text only until the assistants' speech to text is released (another session's work, not yet on main).

## Rules for the work

Small commits per concern, nothing committed unless asked (shared tree). No new abstraction before it is needed twice. UI follows the paginate-not-scroll rule and the project's existing CSS. Every step is verified by running its tests before the next starts.
