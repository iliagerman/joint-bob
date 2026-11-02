# Assistant mode Implementation Plan

> **For agentic workers:** Implement task-by-task. Keep each test change before its production change.

**Goal:** Turn per-conversation assistants into persistent agents with a single continuous chat over resumable topic conversations, configurable semantic routing, and assistant-owned webhook/scheduled-task controls.

**Architecture:** Retain the current personal-assistant record as the stable assistant identity and introduce durable topic/timeline associations plus a separate routing-classifier contract. Reuse ordinary harness sessions, conversation records, authorization, and the existing cron/webhook workflows; expose the assistant’s logical timeline and controls through the existing assistant view.

**Tech Stack:** Node.js 24, TypeScript, SQLite, Express, existing browser modules, Playwright UI harness.

**Spec:** `docs/superpowers/specs/2026-11-01-assistant-mode-design.md`

## Global Constraints

- The visible chat is one continuous, chronological assistant timeline.
- Resuming a topic reuses its existing conversation identity and context.
- No destructive clearing of context, deletion of topic history, or automatic replay of interrupted external actions.
- Route classifier selection is independent of prompt difficulty classification.
- Preserve normal user/project/resource/node authorization and creator-based automation profile semantics.
- Reuse existing webhook and scheduled-task management and execution paths.
- Keep and migrate existing assistant settings, saved items, screenshots, links, and source-conversation history.
- Work only in the current checkout; preserve all unrelated working-tree changes and stage only this feature.

## Review Focus

- Two incoming messages race during first-topic creation; serialize routing and avoid orphan duplicate topic records.
- A reused topic belongs to another user/project/node or has had access revoked; reject it without disclosing its transcript.
- A selected classifier errors or returns malformed/unknown topic IDs; preserve history and show a retryable or clarifying error, never silently start fresh.
- A topic switches harness segments while assistant turns stream; keep message, tool, and completion events bound to the correct assistant timeline turn.
- A webhook/scheduled task targets an assistant while it is idle or switching topics; deliver once to the right assistant without changing existing non-assistant automation behavior.

---

### Task 1: Durable assistant topics and timeline

**Files:**
- Modify: `src/personal-assistants.ts`
- Modify: `src/server/routes/personal-assistants.ts`
- Test: `test/personal-assistants.test.ts`
- Test: `test/personal-assistants-api.test.ts`

**Interfaces:**
- Produce assistant-owned topic operations and a timeline-turn storage API that associates a source conversation on creation and returns durable chronological visible messages plus topic references.
- Use existing conversation record/session primitives; do not duplicate transcript storage.

- [ ] Add failing store/API tests for source-conversation seeding once, topic association, turn ordering/idempotency, assistant authorization, and migration preserving existing assistant/item records.
- [ ] Run the focused server and store tests and confirm they fail on missing topic/timeline behavior.
- [ ] Implement minimal schema migration, stable association, validated assistant endpoints, and bounded chronological payloads.
- [ ] Re-run focused tests.

### Task 2: Semantic router and original-session resumption

**Files:**
- Create: `src/classifiers/conversation-routing.ts`
- Modify: `src/classifiers/contract.ts` and `src/classifiers/registry.ts` only as needed for a separate router contract.
- Modify: `src/server/harness-chat.ts` and the smallest existing harness/session/queue modules required.
- Test: `test/conversation-routing.test.ts`
- Test: `test/harness-chat.test.ts` or a new focused assistant-chat server test.

**Interfaces:**
- Produce a conversation-routing contract with the chosen existing classifier ID, bounded candidate topic data, and one of continue(existing assistant topic), new, or recall.
- Reuse the existing serialized prompt queue, normal session execution, access checks, and saved conversation identity.

- [ ] Add failing unit/server tests proving A → B → A resumes A's original session; the visible timeline stays ordered; reload returns identical turns; read-only recall does not replace the active topic; unauthorized targets are rejected; failures never silently reset context.
- [ ] Run the focused tests and verify expected RED failures.
- [ ] Implement deterministic candidate assembly, separate TypeSafe/Laya routing adapters using their supported decision mechanism, validated routing, durable target binding, and existing-session continuation. Treat candidate misses as recall/search, never proof of newness.
- [ ] Add assertions for missing keys, malformed classification, unknown IDs, concurrent queue input, and preserved source-conversation history.
- [ ] Run focused routing, harness, and conversation storage tests.

### Task 3: Assistant chat UI and conversion entry points

**Files:**
- Modify: `public/assistant.html`, `public/assistant.js`, and focused styles/assets.
- Modify: `public/app/conversation-sharing.js` and toolbar markup/styles only for desktop Create assistant placement.
- Test: `test/ui/ui-personal-assistant.test.ts`

**Interfaces:**
- Consume the assistant topic/routing API from Tasks 1–2.
- Present one timeline, one composer, and assistant settings; never replace the timeline with an individual resumed session's `ready` transcript.

- [ ] Add failing browser assertions for desktop toolbar creation, mobile-menu creation, assistant open/list mode, full-screen mobile timeline/composer, classifier settings, continuous A/B/A chat, and reload persistence.
- [ ] Run the isolated UI test and verify failure at the new assertion.
- [ ] Implement desktop/mobile entry points and the assistant timeline view with accessible streamed turns, reconnect behavior, error states, and same-chat clarification.
- [ ] Verify the existing personal-assistant settings, secrets, MCP controls, saved links, screenshots, and return-to-conversation links remain intact.
- [ ] Run the focused assistant UI journey at desktop and phone viewports.

### Task 4: Assistant-scoped scheduled tasks and webhooks

**Files:**
- Modify: existing cron/webhook schemas, APIs, and dispatch only as needed for assistant identity.
- Modify: `public/assistant.html`, `public/assistant.js`, and existing cron/webhook dialog integration.
- Test: focused assistant automation API and UI tests.

**Interfaces:**
- Create/list/edit/pause/delete assistant-targeted automations by stable assistant ID. Existing automation APIs and ordinary targets remain backwards compatible.
- Cron and webhook events enter the same serialized assistant router and are idempotent; creator identity/profile rules remain authoritative.

- [ ] Add failing API/UI tests for assistant-targeted task and webhook creation/list/edit using the dedicated assistant controls, verifying mobile full-screen forms and desktop dialogs.
- [ ] Run the focused tests and verify failure.
- [ ] Reuse existing webhook/cron forms, validation, authentication, execution history, and scheduling/delivery paths. Preserve assistant identity across topic switches and prevent duplicate delivery on retry.
- [ ] Verify normal project and conversation automations are unchanged; run focused automation tests and mobile/desktop assistant UI journeys.

### Task 5: Full verification, independent review, commit, push

**Files:** only files from Tasks 1–4 and their tests, `docs/superpowers/specs/2026-11-01-assistant-mode-design.md`, `docs/superpowers/plans/2026-11-01-assistant-mode.md`, and `mockups/assistant-mode.html`.

- [ ] Re-read `git diff` and stage only assistant-feature files; do not stage unrelated pre-existing changes.
- [ ] Run relevant unit/server tests, `npm run typecheck`, `npm run build`, focused UI tests, and checks documented in `TESTING.md`.
- [ ] Use `local-code-review`; fix feature blockers before commit.
- [ ] Verify staged diff and create one `feat: add persistent assistant mode` commit.
- [ ] Confirm branch is the existing `main`, fetch and inspect remote ancestry, then push without force. Report the pushed commit and any checks that could not run.
