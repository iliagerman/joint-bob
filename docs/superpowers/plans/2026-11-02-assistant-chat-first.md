# Chat-first assistants implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open saved assistants ready to chat from the Android Assistants shortcut, with separate configuration and assistant-scoped automation controls.

**Architecture:** Keep each assistant's stable identity and continuous timeline over resumable topic conversations. Separate chat, settings, saved items and automation views. Use the existing agent configuration and automation services rather than building parallel runtimes.

**Tech Stack:** Existing Express/TypeScript backend, SQLite persistence, native JavaScript frontend and isolated Playwright tests.

**Spec:** `docs/superpowers/specs/2026-11-01-assistant-mode-design.md`, supplemented by the approved chat-first flow in this conversation on 2026-11-02.

## Global constraints

- Opening an assistant shows chat, not configuration forms or the regular conversation interface.
- TypeSafe and Laya are called decision models in assistant-facing copy. The selected decision model decides whether to continue, resume or start a conversation. Keep persistence/API compatibility where a rename would break existing clients.
- Preserve the continuous chronological timeline and original topic context.
- Preserve existing assistants, saved links, screenshots, instructions and grants.
- Reuse normal harness/model/effort capabilities and authorization.
- Do not commit unrelated shared-checkout work.

## Review focus

- Android shortcut without an assistant ID opens a list; selecting an entry opens chat.
- Reloading a direct assistant URL does not expose settings or reset its timeline.
- Changing harness/model/effort preserves existing topic history and rejects unsupported combinations.
- Saving settings or closing an automation returns to the same assistant chat.
- Decision-model failure keeps the unsent message retryable without creating a replacement topic.

### Task 1: Chat-first navigation and decision-model terminology

**Files:** `public/assistant.html`, `public/assistant.js`, `public/manifest.webmanifest`, `test/ui/ui-personal-assistant.test.ts`.

**Interfaces:** Preserve `/assistant.html` as the list route and `/assistant.html?id=ID` as the stable assistant chat route. Add explicit settings and saved-items navigation. Preserve existing `classifierId` API values `typesafe` and `laya` while displaying the label `Decision model`.

- [x] Extend the mobile journey to open the manifest shortcut destination, select an assistant and assert that chat is visible while configuration/capture forms are hidden.
- [x] Run the journey and confirm the new assertions fail before implementation.
- [x] Separate chat, settings and optional saved-items views. Saving configuration returns to chat. Replace shopping-specific defaults with neutral saved-item copy without altering stored items.
- [x] Add reload/back-navigation assertions and verify direct assistant links open chat.
- [x] Run `npm run test:file -- test/ui/ui-personal-assistant.test.ts` and JavaScript syntax checks.

### Task 2: Assistant execution configuration

**Files:** `src/personal-assistants.ts`, `src/server/routes/personal-assistants.ts`, `src/server/conversation-prompt.ts`, `public/assistant.js`, `public/assistant.html`, `test/personal-assistants.test.ts`, `test/personal-assistants-api.test.ts`.

**Interfaces:** Add persisted assistant execution preferences using the existing harness/model/reasoning identifiers. Keep source-conversation identity immutable and separate from preferred execution settings. Use existing harness capability discovery and queue settings; use normal harness-segment transitions when changing an existing topic's harness.

- [x] Inspect existing harness/model configuration and segment-change paths before choosing exact preference fields.
- [x] Add storage/API tests for preference round-trip, old assistants without preferences, invalid execution choices and unchanged source identity.
- [x] Implement migration, boundary validation, capability-based controls and dispatch using saved preferences for new and resumed topics.
- [x] Test that changing harness/model/effort preserves topic identity/history and current authorization.
- [x] Run typecheck and focused assistant/routing tests with the decision-service key removed and a loopback-only test setup.

### Task 3: Automation management inside assistant mode

**Files:** `public/assistant.html`, `public/assistant.js`, `public/app/cron.js`, `public/app/webhooks.js`, relevant existing automation routes and tests.

**Interfaces:** Dedicated scheduled-task and webhook views remain scoped to the stable assistant identity. Reuse current validation, creator/profile rules and delivery history. Do not launch the workspace in a popup as the assistant management experience.

- [x] Inspect reusable automation form dependencies and delivery targets before changing the UI integration.
- [x] Add mobile and desktop journeys for opening, saving and closing scoped automation forms without leaving assistant mode.
- [x] Reuse the standard forms/services with mobile full-screen presentation and desktop dialogs.
- [x] Route assistant-target automations through the shared assistant turn pipeline and persist stable assistant identity, creator and run attribution.
- [x] Run relevant assistant, cron and webhook tests through the isolated loopback-only harness.

### Task 4: Verify and review

**Files:** `test/conversation-routing.test.ts`, `test/ui/ui-personal-assistant.test.ts`, `public/sw.js` and feature files above.

- [x] Test conversation routing independently of difficulty scoring and keep classifier requests confined to loopback fixtures.
- [x] Verify existing-topic routing and recall behavior, plus assistant chat navigation and reload in the UI journey.
- [x] Verify the Android shortcut list, direct chat entry, settings save, optional saved items and automation return navigation at mobile dimensions; verify desktop automation too.
- [x] Retain the manifest list shortcut without promising per-assistant launcher shortcuts.
- [x] Bump the frontend cache and run typecheck, build, focused server tests, UI journeys and `git diff --check`.
- [x] Review feature changes and identify only the requested files for selective staging.
- [ ] Commit and push after the release hooks can run without unauthorized external API calls or sweeping unrelated `CHANGELOG.md` / `package.json` edits into the commit.
