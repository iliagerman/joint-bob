# Activity Chat agent mode implementation plan

> **For agentic workers:** Implement tasks in order with test-first changes. Keep user edits in the shared checkout untouched.

**Goal:** Make Activity Chat a capable project agent that can search the conversation and project, use tools when the user disables read-only mode, and honor the selected effort level.

**Architecture:** Keep Activity Chat's conversation history separate from the source conversation. Give the selected harness the source transcript path and project directory, allowing on-demand tool search instead of pre-summarizing the complete transcript. Default each chat to read-only; persist its mode per conversation. Pass effort through existing model settings.

**Tech Stack:** TypeScript, Express/Zod, browser JavaScript, existing harness runtime and Playwright tests.

**Spec:** Approved in this conversation: access transcript and project files; allow multiple agent tool calls; add a default-on read-only toggle and effort selector; side-chat history stays outside the main conversation; commit and push the feature.

## Global Constraints

- Read-only is on for a new Activity Chat; it retains only known read/search tools, while disabling it allows normal project tools and actions.
- Activity Chat messages remain separate from the source conversation transcript.
- Limit agent context to the selected project and authorized conversation transcript; follow existing conversation-scoped secrets and tool policies.
- Use existing model-specific effort levels and keep tests isolated through documented harnesses.
- Preserve unrelated working-tree and index changes.

## Review Focus

- Requests with read-only enabled must retain project/transcript read tools but exclude mutating tools; assert the exact allowed tool set.
- Requests with read-only disabled must receive tools and may make multiple calls; test against the harness fixture.
- Conversation segments and absent transcript files must not expose another conversation's path; test path resolution and authorization.
- Unsupported effort values must be rejected; test schema validation.
- Queued requests must retain the mode and effort selected when submitted; test FIFO queue behavior.

---

### Task 1: Route transcript and project context to the Activity Chat agent

**Files:**
- Modify: `src/server/conversation-chat-runner.ts`
- Create: `src/server/conversation-chat-agent.ts`
- Modify: `src/server/conversation-turns.ts` only if a focused transcript-path resolver is needed
- Test: `test/conversation-chat-api.test.ts`

**Interfaces:**
- Preserve conversation authorization in `src/server/routes/conversation-chat.ts` before resolving transcript paths.
- The runner gives the harness the project's directory plus every transcript path for the logical conversation's segments.
- Read-only mode enables the harness's read/search tool subset and excludes write, shell, and action tools; action mode leaves the harness's normal tools enabled.

- [x] Write server tests showing that the prompt identifies the authorized project and transcript paths and that read-only mode retains read/search tools but excludes mutating tools, while action mode retains normal tools.
- [x] Run `npm run test:file -- test/conversation-chat-api.test.ts` and confirm the new assertions fail for the expected missing behavior.
- [x] Implement scoped path resolution and conditional tool access; do not load and summarize the whole transcript before agent search.
- [x] Re-run the focused tests and verify source transcript immutability; use the native harness's tool iteration loop.

### Task 2: Persist mode and effort with Activity Chat

**Files:**
- Modify: `src/conversation-chat.ts`
- Modify: `src/server/routes/conversation-chat.ts`
- Modify: `src/server/conversation-chat-runner.ts`
- Test: `test/conversation-chat-api.test.ts`

**Interfaces:**
- Add a per-conversation `readOnly` setting defaulting to `true`, with a chat update endpoint for toggle changes.
- Add model `thinkingLevel` to the per-question model choice and pass it as runtime reasoning.
- Validate user-provided model and effort at the route boundary.

- [x] Add tests for the default mode, saving/restoring a changed mode, effort persistence, and rejection of invalid effort values.
- [x] Run the API tests and verify they fail before implementation.
- [x] Implement the schemas, route, persistence, queue snapshot, and runtime setting propagation.
- [x] Run the API and runner tests.

### Task 3: Add controls to Activity Chat

**Files:**
- Modify: `public/index.html`
- Modify: `public/app/conversation-chat.js`
- Modify: `public/styles.css`
- Modify: `public/sw.js` (cache version)
- Test: `test/ui/ui-activity-panel.test.ts`

**Interfaces:**
- Add a read-only toggle defaulting on and an effort selector next to the existing harness/model controls.
- Reuse `fillModelOptions`/`fillThinkingOptions` from `public/app/git-reviewer-options.js`.
- Save mode changes per conversation and send the selected effort with each queued question.

- [x] Add a browser test for mode default/persistence, model-specific effort choices, and unchanged source conversation history.
- [x] Run the browser test and confirm the new assertions fail before implementation.
- [x] Implement controls and status copy; keep them usable at narrow panel widths.
- [x] Bump the service-worker cache version and run the browser test.

### Task 4: Verify and commit the feature

**Files:** only feature hunks from the files above and the focused tests.

- [x] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:ui` through their documented isolated commands, following `TESTING.md` and shared-checkout test guidance. Full-suite attempts timed out; see verification notes below.
- [ ] Review the full diff and isolate only this feature from unrelated shared-tree edits.
- [ ] Commit the feature and push existing branch `main` to `origin`.
- [ ] Verify the resulting commit and remote branch; report any release-gate work required.

## Execution and verification notes

- Implemented a dedicated native Activity Chat session runner instead of extending the disposable Git reviewer. It preserves side-agent context across follow-ups and reopens the same transcript, without continuing the original runtime.
- Read-only tool lists exclude shell, writes, web actions, delegation, and unknown extensions. Pi's normal active tools are saved separately so disabling read-only can restore commands after reopening.
- Source model metadata is parsed only when inherited settings are absent. Source transcript content is not injected into the model prompt or sent through summary calls.
- Independent review found inherited-model fallback and a permission-save/navigation race. Both were corrected; the inherited-model regression was observed failing before its fix.
- Final focused verification passed 16 tests, including native session reuse, permission switching, effort, long-history handling, authorization, durable history, FIFO follow-ups and browser controls. Typecheck and build passed.
- Full `npm test` and `npm run test:ui` attempts each reached the 30-minute tool timeout, so neither is claimed green.
- Full server run reported failures in `skill-scoped-sharing-api.test.ts` and `twin-replication-runtime.test.ts`; both passed in the later candidate-focused run and the clean-main comparison.
- Full browser run reported failures in `browser-profile-access.test.ts`, `browser-website-login.test.ts`, `ui-activity-panel.test.ts`, and `ui-cluster-login.test.ts`. The first two reproduced on clean main. Activity-panel passed on both clean main and the candidate rerun. Cluster-login outcomes varied between runs; its failures were not resolved by this feature.
