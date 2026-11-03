# Webhook files and workspaces implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit and replace webhook attachments, revert their last change, and run webhooks in fresh or webhook-dedicated directories.

**Architecture:** Reuse immutable `webhook_resource_versions` for attachment updates and rollback. Introduce server-owned execution directories and carry their identity through the automation queue, resolving the actual working directory only when the webhook turn starts. Never accept an arbitrary client-supplied working path.

**Tech stack:** Existing TypeScript, SQLite, browser JavaScript, Node test runner, isolated Playwright test harness.

**Spec:** Approved scope in this conversation: inline text attachment editing; attachment replacement without deletion; one-version rollback; preservation off creates a newly allocated temporary directory for every run, preservation on reuses a dedicated directory only for that webhook. Directories are not security sandboxes.

## Global constraints

- Work on existing `main`; preserve unrelated staged and unstaged changes.
- No git branches or worktrees, no dependencies added.
- Keep resource IDs stable and retain immutable versions used by accepted calls.
- Binary attachments support replacement and download, not inline text editing.
- Runs must actually use the selected working directory, not merely receive instructions to change directories.
- Existing conversation and assistant targets must not change a running unrelated turn's directory.
- Keep generated files available for subsequent inspection; do not delete a run directory at turn completion.
- Implementation choice: fresh workspaces default for newly created webhooks. Explicitly migrate existing webhooks without silently relocating their existing conversations.

## Review focus

- A browser or another agent still attached to the target conversation must not cause a webhook to run in the project directory instead.
- Concurrent fresh runs must have different directories; preserving runs must not overwrite user-generated files when staging unchanged attachments.
- A replacement or rollback after call acceptance must not alter that call's pinned version.
- Non-UTF-8 binary content must never be decoded and saved as text; stale editors must report conflicts.
- Remote-owner operations must retain existing creator authorization and owner routing.

### Task 1: Version-aware attachment operations

**Files:** `src/webhook-resources.ts`, `src/server/routes/webhooks.ts`, `test/webhook-resources.test.ts`, `test/webhook-resources-api.test.ts`.

**Interfaces:** Extend save input with optional `expectedVersionId`. Add `revertWebhookResource(db, webhookId, resourceId, expectedVersionId, options)` returning `Promise<WebhookResourceRecord>`. Expose previous-version availability on resource listings and `POST /api/webhooks/:id/resources/:resourceId/revert` via the existing owner-routed command protocol.

- [ ] Add failing unit tests for replacement preserving ID, previous-version restore, no previous version, cross-webhook IDs, and stale expected version returning 409.
- [ ] Run `npm run test:file -- test/webhook-resources.test.ts` and verify the new cases fail.
- [ ] Implement previous-version lookup using insertion order, not timestamp alone. Revert copies the preceding saved version into a new immutable version so accepted snapshots remain valid. Do not let description-only saves create misleading content rollback steps.
- [ ] Add API tests for owner routing, authorization, replacement, and rollback, including a call snapshot captured before either mutation.
- [ ] Run `npm run test:file -- test/webhook-resources.test.ts test/webhook-resources-api.test.ts`.

### Task 2: Inline editor and replacement controls

**Files:** `public/app/webhook-files.js`, `test/ui/ui-webhooks.test.ts`; use existing styles unless a necessary scoped rule is missing.

**Interfaces:** Consume resource `versionId`, previous-version availability, existing download/save endpoint and Task 1 revert endpoint.

- [ ] Add a failing browser journey for editing a text attachment, saving, replacing the same attachment, reverting once, and downloading the restored bytes.
- [ ] Run `npm run test:file -- test/ui/ui-webhooks.test.ts` and verify the new journey fails at the missing controls.
- [ ] Add an expandable inline textarea with Save and Cancel. Decode UTF-8 strictly and reject binary content. Encode saves without changing Unicode or line endings. Include the opened version ID for conflict detection.
- [ ] Add Replace using a single-file picker and retain the existing resource ID, kind, description and usage. Show one-step Revert only when a predecessor exists. Keep errors visible and unsaved text intact on failure.
- [ ] Test binary replacement, empty text, Unicode, cancel, stale save and stale rollback. Verify pagination still fits its container.
- [ ] Run the browser journey and attachment API tests.

### Task 3: Workspace allocation and settings

**Files:** new `src/webhook-workspaces.ts` and `test/webhook-workspaces.test.ts`; modify `src/webhooks.ts`, `public/app/webhooks.js`, the webhook form region of `public/index.html`, and `test/webhooks.test.ts`.

**Interfaces:** `allocateWebhookWorkspace(webhookId, preserveFiles, options): Promise<string>` allocates through `mkdtemp` when false and a server-owned webhook-specific directory when true. Persist `preserveFiles` in the webhook schema and all form/update serialization paths. A workspace record identifies owner node, webhook, request and directory; callers pass its identity, not a browser-controlled path.

- [ ] Write failing tests for unique fresh paths, webhook-specific preserved paths, invalid IDs, symlink rejection, setting round-trip and legacy migration.
- [ ] Run `npm run test:file -- test/webhook-workspaces.test.ts test/webhooks.test.ts`.
- [ ] Implement allocation and setting persistence. Add visible “Preserve files between runs” with a concise explanation of each mode.
- [ ] Stage pinned attachment copies into the selected workspace, keeping immutable stored versions untouched. Track staged versions so unchanged inputs do not overwrite generated modifications in preservation mode; changed attachments replace their own staged copies only. Detect filename collisions explicitly.
- [ ] Test preservation of generated files, new attachment staging, updated input staging, and cross-webhook isolation.
- [ ] Run workspace and webhook tests.

### Task 4: Execute in the selected workspace

**Files:** `src/server/webhooks.ts`, `src/server/conversation-prompt.ts`, `src/server/chat-socket.ts`, `src/server/harness-chat.ts`, queue persistence modules identified from the existing prompt queue, assistant automation integration, `test/webhook-delivery.test.ts`, focused harness queue tests.

**Interfaces:** A trusted webhook workspace identity travels with the queued prompt and is resolved server-side at execution time. Attachment placement and resource instructions use workspace copies. Existing project IDs, secrets, title binding, history visibility and webhook memory access remain unchanged.

- [ ] Write failing execution tests that report the runtime's actual cwd and create a file there, rather than asserting prompt text. Cover new conversation, existing conversation and assistant targets.
- [ ] Inspect the queue/runtime transition code before choosing the smallest per-turn integration. A websocket connection's initial `cwd` alone cannot satisfy existing sessions and assistant targets. Persist the workspace identity with the queue item and switch or recreate the harness runtime only at the execution boundary, never during another turn.
- [ ] Implement actual runtime cwd selection, queue recovery and attachment placement in that directory. Bind newly created webhook conversations to their run directory for later reopening. Never expose an unvalidated arbitrary-path socket parameter.
- [ ] Test two fresh runs, preserved sequential runs, two different webhooks, an already-connected UI, a busy target conversation, retries after queue persistence, and missing directories with explicit errors.
- [ ] Run `npm run test:file -- test/webhook-delivery.test.ts test/webhook-workspaces.test.ts test/harness-chat.test.ts test/harness-wire.test.ts` plus focused queue and assistant tests touched by implementation.

### Task 5: Verify and review

- [ ] Run all webhook tests through `npm run test:file --` with explicit file paths.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run `npm run test:file -- test/ui/ui-webhooks.test.ts test/ui/ui-project-webhooks.test.ts` in the documented disposable harness.
- [ ] Review the final diff for accidental unrelated changes and server authorization regressions. Record any environmental or pre-existing failures separately.
- [ ] Commit only task-owned hunks using a private git index; do not sweep shared staged changes into a commit.
