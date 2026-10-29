# Webhook resources implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Give each webhook reusable described files, script tools, private skill selections/imports, and persistent Markdown memory editable by both the user and its agents.

**Architecture:** Keep resource metadata and immutable versions on the webhook owner, outside project/global resource directories. Carry trusted webhook context through the durable prompt queue, add a scoped harness skill overlay, and expose revision-checked memory updates through a bounded agent capability. Extend the existing webhook editor and twin-owner management route rather than introducing another management screen.

**Tech stack:** TypeScript, Node filesystem and SQLite, Zod, Express/WebSocket, existing harness adapters, vanilla browser JavaScript, isolated Node and Playwright tests.

**Spec:** `docs/superpowers/specs/2026-10-29-webhook-resources-design.md`

## Global constraints

- No branches or worktrees. Work in the existing checkout and stage only this work.
- Existing webhook owners remain node-local. No local fallback when an owner is unavailable.
- Static file contents are not automatically read, processed, or injected into model context.
- Webhook resources never alter global/project skill installation, activation, or sharing.
- Preserve strict harness resource isolation and existing independently authorized project resources.
- No scripts, hooks, or dependency installers run during upload or skill import.
- Proposed limits: 4 MiB per file; 6 static files; 6 tool files; 20 skills; 4 MiB and 200 files per skill folder; 2,000 characters per description/usage; 200,000 UTF-8 bytes of memory.
- Every static file needs a nonempty description. Missing/revoked resources fail visibly.
- Run tests through `npm run test:file`, never with real account/profile/data directories.
- These are implementation tasks, not a statement that implementation has started.

## Review focus

1. Two different webhooks targeting one conversation cannot leak skill overlays or memory capabilities between turns. Task 4 tests both dispatch orders and a subsequent manual turn.
2. A user editing memory while an agent saves must retain their draft and receive a conflict, not silently overwrite. Tasks 2 and 6 cover the API and browser journey.
3. A queued run must retain selected resource versions after replacement, removal, or restart. Tasks 1 and 4 cover retained files and durable metadata.
4. A twin managing another owner's webhook cannot accidentally install skills or write memory locally after an uncertain response. Tasks 3 and 5 cover owner routing and failure.
5. Local folders and Git skill imports can contain traversal, symlinks, executable hooks, duplicate names, or oversized content. Tasks 1 and 3 test rejection without execution or partial installation.

## File boundaries

New backend modules:
- `src/webhook-resources.ts`: schemas, metadata, immutable file/tool versions, resource snapshots and conversation association.
- `src/webhook-memory.ts`: canonical Markdown, revision check, atomic saves and per-webhook serialization.
- `src/webhook-skills.ts`: existing/Git/local skill import into webhook-private roots.
- `src/webhook-agent.ts`: scoped capability identity and command handling.
- `src/server/routes/webhook-resources.ts`: resource management using the owner-routing policy from webhook management.
- `bin/joint-bob-webhook.mjs`: agent memory read/write commands.

New frontend module: `public/app/webhook-resources.js`, responsible for resources inside the existing webhook form. Keep `public/app/webhooks.js` responsible for owner selection and the webhook itself.

Extend existing queue, harness, and settings modules only at their actual resource/dispatch boundaries. Do not replace the general resource system or reuse project memory as webhook memory.

## Task 1: Resource storage and immutable versions

**Files:** Create `src/webhook-resources.ts`, `test/webhook-resources.test.ts`. Modify `src/webhooks.ts`.

**Interfaces:**
- `WebhookResourceRecord`: ID, webhook ID, kind `file | tool`, display name, description, nullable usage, version ID, MIME type, byte count, created/updated timestamps.
- `WebhookResourceSnapshot`: webhook ID, owner node ID, static/tool version IDs, skill version IDs, memory-enabled flag.
- `saveWebhookResource(db, webhookId, input): Promise<WebhookResourceRecord>` accepts validated bytes, metadata, and optional resource ID to replace.
- `snapshotWebhookResources(db, webhookId, ownerNodeId): WebhookResourceSnapshot` returns immutable references, not client-provided paths.
- `resolveWebhookResources(db, snapshot): Promise<{ files: WebhookResourceRecord[]; tools: WebhookResourceRecord[]; skillRoots: string[] }>` validates owner, associations, stored versions and actual files.

- [ ] Write failing tests for create/read/replace/remove, required descriptions, byte/count limits, duplicate filenames with distinct server IDs, traversal/symlink rejection, and retained old versions after replacement/removal. Assert the bytes still match the accepted snapshot after reopening SQLite.
- [ ] Run `npm run test:file -- test/webhook-resources.test.ts`; confirm failures name the missing behavior.
- [ ] Implement node/account-aware storage outside project and shared resource roots, metadata migration, staged writes with rollback on metadata failure, and immutable version resolution. Reuse existing runtime path conventions. Existing webhooks migrate to no resources and memory disabled.
- [ ] Run new tests plus `test/webhooks.test.ts`; confirm all pass and inspect temporary test directories for cleanup.
- [ ] Commit only this task with `feat(webhooks): store private resource versions`.

## Task 2: Persistent, conflict-safe Markdown memory

**Files:** Create `src/webhook-memory.ts`, `test/webhook-memory.test.ts`. Modify `src/webhook-resources.ts`.

**Interfaces:**
- `WebhookMemory = { content: string; revision: string; path: string }`.
- `readWebhookMemory(webhookId: string): Promise<WebhookMemory>`.
- `writeWebhookMemory(webhookId: string, expectedRevision: string, content: string): Promise<WebhookMemory>`.
- Memory enable/disable/initialization is separate from ordinary webhook updates. A disabled memory retains its file.

- [ ] Write failing tests for empty initialization, initial Markdown upload, UTF-8 byte cap, persisted content after reload, disable/re-enable preserving bytes, and two writes from the same revision yielding exactly one success and one conflict. An externally edited file must also invalidate the old revision.
- [ ] Run `npm run test:file -- test/webhook-memory.test.ts`; confirm failures.
- [ ] Implement revision derived from actual content, serialized comparison plus temporary-file/rename save, explicit 409 conflicts, and reset as a normal revision-checked save. Never truncate a file in place or silently retry a conflicting write.
- [ ] Run memory and resource tests; confirm no successful response precedes completed persistence.
- [ ] Commit `feat(webhooks): persist revisioned Markdown memory`.

## Task 3: Private skills from existing inventory, Git, and folders

**Files:** Create `src/webhook-skills.ts`, `test/webhook-skills.test.ts`. Modify `src/git-resources.ts` only to expose reusable safe import primitives if needed.

**Interfaces:**
- `WebhookSkillRecord`: ID, webhook ID, name, description, version ID, source kind `existing | git | upload`, source identity, nullable Git commit/ref/subfolder.
- `listSelectableWebhookSkills(projectId, accountId, harnessId)` returns authorized stable inventory identities, not arbitrary filesystem paths.
- `importExistingWebhookSkill(db, webhookId, inventoryId): Promise<WebhookSkillRecord>`.
- `discoverWebhookGitSkills(webhookId, { url, ref }): Promise<{ sourceId: string; commit: string; skills: Array<{ key: string; name: string; description: string }> }>` stages discovery only.
- `importWebhookGitSkill(db, webhookId, sourceId, key): Promise<WebhookSkillRecord>` pins the discovered commit.
- `uploadWebhookSkill(db, webhookId, files: Array<{ relativePath: string; data: Buffer }>): Promise<WebhookSkillRecord>` preserves a single validated skill folder.

- [ ] Write failing tests for all three sources, valid frontmatter and supporting files, exact Git commit pinning, explicit update, source-skill revocation, duplicate skill-name rejection, traversal/symlink/size/file-count rejection, and rollback on failed import. Compare global resource inventory and activation/sharing records before/after; they must be unchanged.
- [ ] Use disposable local Git fixtures for import tests. Add a fixture with a hook/installer sentinel and assert it never runs. Do not create project branches or clone the working repository.
- [ ] Run `npm run test:file -- test/webhook-skills.test.ts`; confirm failures.
- [ ] Implement private staging/discovery/materialization. Reuse hardened Git transport and skill parsing, not `addGitSource`/global apply/share. Preserve relative resource paths and explicitly validate effective-name collisions with baseline skills.
- [ ] Run new tests plus `test/git-resources.test.ts`, `test/scoped-skills.test.ts`, and `test/harness-resources.test.ts`.
- [ ] Commit `feat(webhooks): import webhook-scoped skills`.

## Task 4: Durable execution context and scoped agent access

**Files:** Modify `src/server/webhooks.ts`, `src/server/conversation-prompt.ts`, `src/prompt-queue.ts`, `src/server/harness-chat.ts`, `src/harnesses/runtime.ts`, `src/settings.ts`, and the actual resource-loading boundary in `src/harnesses/pi/runtime.ts`, `src/harnesses/claude/runtime.ts`, `src/harnesses/kiro/runtime.ts`. Create `src/webhook-agent.ts`, `bin/joint-bob-webhook.mjs`, `test/webhook-context.test.ts`, `test/webhook-agent.test.ts`. Extend `test/webhook-delivery.test.ts`.

**Interfaces:**
- Add optional `webhookContext: WebhookResourceSnapshot` to trusted server prompt metadata and its persisted Zod schema. Old queued prompts have no webhook context.
- `prepareWebhookContext(snapshot, identity)` resolves manifests, authorized skill roots, memory instructions, and bounded agent capability environment at dispatch. Resolve source access again here.
- `bindWebhookConversation(db, { webhookId, projectId, conversationId, ownerNodeId })` applies only to conversations created by that webhook. Explicit per-turn metadata takes precedence in an existing conversation.
- `JOINT_BOB_WEBHOOK_CLI` supports `memory read` and `memory write --expected-revision REVISION --file PATH`. Token identity binds webhook, owner, account, project, and conversation; no caller-selected target webhook.

- [ ] Write failing delivery tests asserting filename/description/path presence and CSV/script-byte absence from prompt/images/files. Incoming call attachments must still travel through the existing attachment flow.
- [ ] Write queue/restart tests for snapshot preservation, startup validation, latest memory read at dispatch, deleted/revoked resources, spoofed webhook metadata from unsigned clients, and no automatic replay of a started action.
- [ ] Write harness tests for actual selected-skill discovery in Pi/Claude/Kiro. For A then B then manual in the same conversation, assert only the relevant overlay/capability is active. Separately assert a webhook-created conversation's later user feedback retains the correct association on its owner.
- [ ] Write capability tests for read/write, stale revisions, forged/expired tokens, another webhook ID, deleted webhook, owner mismatch, and revoked skill access. Ensure errors and logs never contain tokens.
- [ ] Run the new tests through `npm run test:file` and confirm failures before implementation.
- [ ] Implement trusted context propagation and turn-specific resource loading. If a harness cannot safely replace its live resource set, recreate/reload that runtime through its existing lifecycle before dispatch; do not accumulate overlays on a cached runtime. Keep normal project resources intact and strict isolation on.
- [ ] Generate the resource manifest and script usage instructions without reading static contents. Provide memory instructions to read before work and update useful lessons through the CLI; supported memory updates never depend on turn-completion callbacks.
- [ ] Run the new tests plus `test/webhook-delivery.test.ts`, `test/queued-engines.test.ts`, `test/harness-resources.test.ts`, and `npm run typecheck`.
- [ ] Commit `feat(webhooks): scope resources to durable agent turns`.

## Task 5: Authenticated management and twin-owner routing

**Files:** Create `src/server/routes/webhook-resources.ts`, `test/webhook-resources-api.test.ts`. Modify `src/server/routes/webhooks.ts`, `src/server.ts`, `src/server/http-auth.ts`, and `src/agent-capabilities.ts` where route/capability registration requires it. Extend `test/webhook-twins-api.test.ts`.

**Interfaces:**
- Route base `/api/webhooks/:id/resources`, using existing settings authorization and immutable webhook-owner routing.
- List/upload/update/remove/download file/tool/skill records by server IDs; descriptions/usage are mutable metadata, file replacement creates a version.
- `/api/webhooks/:id/memory` GET/PUT with `{ content, expectedRevision }`; enable/init/reset use explicit commands with the same revision semantics.
- Existing selection, staged Git discovery/import/update, and folder upload are typed owner commands, not filesystem-path endpoints.
- `/api/webhook-agent/command` authenticates the bounded agent identity and accepts only memory read/write commands.

- [ ] Write failing HTTP tests for authorization/creator checks, malformed uploads, safe downloads, missing resources, memory conflicts, and resources surviving ordinary webhook saves/toggle/allow-sender/address rotation.
- [ ] Extend twin tests to upload CSV/script/folder and edit memory through the twin; inspect owner storage and prove local storage/inventory remains unchanged. Owner-offline and uncertain-response tests must fail without a fallback/retry.
- [ ] Run API/twin tests and confirm failures.
- [ ] Implement bounded request decoding before allocation, owner command validation, explicit status/errors, and signed twin routing. Never route resource downloads through the public secret webhook URL. Reuse owner-management policy without broadening ordinary cluster access.
- [ ] Run new tests plus `test/webhook-twins-api.test.ts`, `test/webhook-title-api.test.ts`, and `test/webhooks.test.ts`.
- [ ] Commit `feat(webhooks): manage resources on webhook owners`.

## Task 6: Webhook resource controls and Markdown editor

**Files:** Create `public/app/webhook-resources.js`, `test/ui/ui-webhook-resources.test.ts`. Modify `public/app/webhooks.js`, `public/index.html`, `public/styles.css` as needed, and `public/sw.js`. Extend `test/ui/ui-webhooks.test.ts` and existing cache-version assertions.

**Interfaces:** `createWebhookResourceEditor({ container, endpoint, reportError })` returns `load(webhook)`, `reset()`, `hasUnsavedChanges()`. The caller supplies owner-specific endpoints and clears state on owner/webhook changes. Resources on a new webhook can be added after its initial save, with clear inline guidance.

- [ ] Write failing isolated browser journeys for upload/description/edit/download/remove, script usage, existing-skill selection, local folder preservation, Git discovery/import, and reopen persistence. Use disposable folder/Git fixtures and synthetic data only.
- [ ] Add memory journeys for enable/upload/view/edit/save/download/reset and disable/re-enable. Trigger a competing agent/API write while a user draft is open; assert 409 feedback and the exact unsaved draft remains. Switching owner or webhook must not display stale content from another request.
- [ ] Verify user-visible resource lists fit/page, controls remain usable on a narrow viewport, and all interactive controls have `data-testid`. Ensure no extra management dialog is introduced.
- [ ] Run `npm run test:file -- test/ui/ui-webhook-resources.test.ts` and confirm failures before adding controls.
- [ ] Implement sections in the existing webhook editor, folder picker preserving relative paths, safe text rendering, conflict/reload handling, explicit execution warning for scripts/skills, and busy/error states. Preserve all fields in existing webhook PUT/toggle paths.
- [ ] Bump the service worker cache and paired assertions. Run new and existing webhook browser tests plus `npm run typecheck` and `npm run build`.
- [ ] Commit `feat(webhooks): edit files skills tools and memory`.

## Task 7: End-to-end verification and documentation

**Files:** Modify `README.md` webhook section; update this plan with actual verification results. Extend preceding test files rather than introducing a second resource framework.

- [ ] Run a synthetic two-run journey: upload a described CSV, script and selected skill; accept call; assert accessible bytes and correct scope; save a lesson through the agent CLI; reopen/restart owner; edit the Markdown from the webhook menu; accept another call and assert the edited lesson is read.
- [ ] Repeat core scope/resource discovery assertions for Pi, Claude and Kiro using repository harness fixtures. Do not substitute source-only assertions for actual runtime discovery. Record authenticated-provider smoke limitations explicitly if credentials are unavailable.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:ui`. Record baseline/environment failures separately and do not claim unavailable checks passed.
- [ ] Document owner locality, per-file descriptions, the three skill sources, explicit Git updates, tool invocation/dependency behavior, memory conflict workflow, retention, and the distinction between app scoping and an OS sandbox.
- [ ] Review against every acceptance criterion in the spec; verify unchanged incoming webhook attachment behavior and no global skill installation/activation changes.
- [ ] Inspect `git diff --check` and staged diff, then commit `docs(webhooks): explain private resources and memory`.

## Plan self-review

Confirmed requirements map to Tasks 1, 3, 4, and 6. Memory editing and learning map to Tasks 2, 4, and 6. All five review-focus cases have explicit behavioral tests. Proposed defaults are marked in the design, including baseline-skill inheritance, limits, version retention, and follow-up association. No implementation or test success is claimed by this document.
