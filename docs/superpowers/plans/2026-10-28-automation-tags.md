# Workspace automation tags implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign workspace-managed or manual tags to automations and browse their immutable execution history and statistics across authorized nodes.

**Architecture:** Separate the managed catalog, automation assignments, and immutable execution snapshots. Persist execution lifecycle at the queue/harness boundary. Use signed, authorized push/catch-up for workspace catalogs and project-scoped execution records, with paginated SQL reporting.

**Tech Stack:** Existing TypeScript, SQLite, Zod, Express, vanilla JavaScript and isolated Node/Playwright tests. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-28-automation-tags-design.md`. User requirements are distinguished there from implementation decisions requiring approval.

## Global constraints

- Managed tags are scoped to a workspace and shared between nodes.
- Manual tags never create catalog entries. Catalog creation is explicit.
- Tag edits affect future executions only; snapshot at claim/acceptance, not after a queue wait.
- Preserve existing uncommitted work in this checkout; stage only this feature's hunks.
- No new branches, worktrees, polling loops, dependencies, or production-data tests.
- Tags: 80 characters, 20 distinct assignments, 500 managed tags per workspace.
- Pagination adapts to available height; Settings owns management and browsing.
- Execution totals never include inaccessible projects or unrelated conversation turns.

## Review focus

- Shared workspace IDs can be remapped on peers; identical labels/IDs on unrelated owners must not merge. Task 2 tests this.
- A webhook sender disconnects after start; failed executions must not appear as successful deliveries. Task 3 tests this.
- A managed tag can be renamed/deleted while a run waits; the accepted snapshot must survive. Tasks 1 and 3 test this.
- One conversation can hold several automation runs and manual turns; statistics must not multiply costs or count unrelated usage. Task 4 tests this.
- A peer may be old, offline, revoked, or reconnect with stale data; catalog sync must not break other replication or resurrect deleted tags. Task 2 tests this.

## Task 1: Workspace catalog and automation assignments

**Files:** Create `src/automation-tags.ts`, `src/server/routes/automation-tags.ts`, `test/automation-tags.test.ts`, `test/automation-tags-api.test.ts`. Modify `src/cron.ts`, `src/webhooks.ts`, `src/server/routes/cron.ts`, `src/server/routes/webhooks.ts`, `src/server.ts`.

**Interfaces:** Export `automationTagAssignmentSchema` with `{ managedTagIds: string[], manualTags: string[] }`, defaulting both arrays to empty. Export `TagSnapshot` as `{ key: string; name: string; managedTagId: string | null }` and `snapshotAutomationTags(db, workspaceId, assignments): TagSnapshot[]`. Export `ensureAutomationTagSchema(db): void`. Catalog rows include ID, canonical workspace owner/ID, name, normalized key, updated timestamp/origin and tombstone.

Routes: `GET /api/workspaces/:workspaceId/automation-tags`, `POST` on the same path with `{name}`, `PATCH /api/workspaces/:workspaceId/automation-tags/:id` with `{name}`, and `DELETE` on the ID path. Return catalog IDs and canonical workspace identity; authorize before every read/write. Reject managed IDs from another workspace. Explicit catalog creation is independent of saving an automation.

- [ ] Write tests asserting normalization/deduplication, limits, defaults for old tasks/webhooks, duplicate-name rejection, workspace access checks, manual assignment leaving catalog count unchanged, and immutable snapshots after rename/delete.
- [ ] Run `npm run test:file -- test/automation-tags.test.ts test/automation-tags-api.test.ts`; confirm failure before implementation.
- [ ] Implement catalog migration/store/routes and optional automation assignment persistence. Include assignments in cron transfer and webhook API serialization. Retired assignments are visible but cannot be saved as active references; dispatch omits retired tags.
- [ ] Rerun focused tests plus `test/cron.test.ts test/webhooks.test.ts test/cron-api.test.ts`; confirm pass.
- [ ] Inspect and stage only feature hunks; commit `feat: add workspace automation tags`.

## Task 2: Authorized cross-node tag synchronization

**Files:** Create `src/server/automation-tag-sync.ts`, `test/automation-tag-sync.test.ts`. Modify `src/server.ts`, `src/server/routes/cluster-v2.ts`, and the new catalog routes. Reuse workspace identity mappings from `src/store.ts` and selection rules from `src/workspace-sharing.ts`/`src/server/shared-workspaces.ts` without exposing the catalog through globally scoped replication.

**Interfaces:** Export `registerAutomationTagSyncRoutes(): void`, `syncAutomationTags(): Promise<void>`, and `announceAutomationTagChanges(workspaceId: string): Promise<void>`. Signed `/api/cluster/v2/automation-tags/pull` and `/changed` requests carry canonical workspace owner/ID and revision cursor. `pull` returns authorized versioned catalog rows, including tombstones. Both routes validate the authenticated node against the workspace sharing policy. Merge with deterministic timestamp/origin ordering and unique normalized names; report concurrent duplicate-name conflicts rather than silently dropping an entry.

- [ ] Add two-node tests for create/rename/delete, empty workspaces, twin and cluster-mapped workspace IDs, unauthorized project-only peers, revoked/blocklisted peers, duplicate delivery, stale tombstones and offline catch-up.
- [ ] Add a mixed-version peer fixture returning unsupported endpoint; assert unrelated sync still succeeds and compatibility status is surfaced.
- [ ] Run `npm run test:file -- test/automation-tag-sync.test.ts`; confirm failure.
- [ ] Implement push-on-change and one-time startup/join/reconnect catch-up using existing signed peer transport. Do not register new unknown events in legacy replication batches.
- [ ] Rerun tests, inspect network assertions for no periodic polling, and commit `feat: sync workspace tag catalogs`.

## Task 3: Immutable execution records and lifecycle

**Files:** Create `src/automation-executions.ts`, `src/server/automation-execution-sync.ts`, `test/automation-executions.test.ts`, `test/automation-execution-lifecycle.test.ts`. Modify `src/cron.ts`, `src/server/cron.ts`, `src/server/webhooks.ts`, `src/server/conversation-prompt.ts`, `src/prompt-queue.ts`, `src/server/harness-chat.ts`, and startup/join registration in `src/server.ts` and `src/server/routes/cluster-v2.ts`.

**Interfaces:** Export `AutomationExecution` containing the fields and statuses specified in the design, `ensureAutomationExecutionSchema(db): void`, `createAutomationExecution(db, execution): void`, `transitionAutomationExecution(db, id, transition): void`, and `reconcileAutomationExecutions(db): void`. Transition input includes revision, queue/turn/session linkage, lifecycle timestamps, status and error. Snapshot fields are write-once. Duplicate identical creates are no-ops; conflicting creates fail.

Signed `/api/cluster/v2/automation-executions/pull` and `/changed` mirror catalog transport but authorize each record by project sharing and ownership, not workspace catalog visibility. Add request/queue IDs to execution records at durable enqueue, then transition by request ID at actual start/completion/failure/cancellation. No changes to webhook response timing. Do not let clients forge another automation's execution metadata.

- [ ] Test a claimed scheduled run and accepted webhook retaining old tags after an edit while queued; failed preparation; two sources sharing a conversation; sender socket closing after start; actual completion/failure; cancellation; restart with pending versus interrupted execution; idempotent repeated events; terminal-state regression rejection.
- [ ] Test execution visibility and catch-up across two authorized nodes, source deletion retaining records, and unauthorized workspace peers seeing no project history.
- [ ] Run `npm run test:file -- test/automation-executions.test.ts test/automation-execution-lifecycle.test.ts`; confirm failure.
- [ ] Implement durable records and lifecycle hooks. Record accepted runs before asynchronous preparation. Integrate existing cron recovery without pretending interrupted runs succeeded or rerunning them for telemetry.
- [ ] Run new tests plus `test/cron-executor.test.ts test/webhook-delivery.test.ts test/queued-engines.test.ts`; confirm pass and commit `feat: track tagged automation executions`.

## Task 4: Filtered history and statistics

**Files:** Create `src/automation-execution-report.ts`, `src/server/routes/automation-executions.ts`, `test/automation-execution-report.test.ts`, `test/automation-executions-api.test.ts`. Modify `src/server.ts`. Reuse usage schema and existing pricing computation from `src/usage-ledger.ts` rather than inventing pricing.

**Interfaces:** Export `queryAutomationExecutions(db, filters, accessibleProjectIds): { rows: AutomationExecution[]; total: number; statistics: ExecutionStatistics; trend: DailyExecutionCount[]; tags: TagSummary[] }`. Filters: canonical workspace identity, optional normalized tag key, source kind/ID, status, from/to, timezone, page and pageSize. HTTP `GET /api/workspaces/:workspaceId/automation-executions` validates limits and date/timezone inputs and resolves accessible project IDs server-side.

`ExecutionStatistics` contains distinct execution/conversation counts, status counts, success rate, mean completed duration, attributable token/cost totals and missing/partial coverage. Use request/turn joins scoped by project and conversation. Deduplicate before aggregating multitag matches. Build parameterized SQL with indexes on workspace/date, source/date, normalized tags/execution and request/turn linkage. All totals cover the filtered dataset, not the page.

- [ ] Test pagination, exact statuses/success-rate denominator, running duration exclusion, timezone day boundaries, empty/invalid ranges, manual/historical tag lookup, duplicate tags, two runs plus manual usage in one conversation, null request IDs/pricing, and inaccessible project exclusion from rows and aggregates.
- [ ] Run `npm run test:file -- test/automation-execution-report.test.ts test/automation-executions-api.test.ts`; confirm failure.
- [ ] Implement bounded reporting queries and API. Missing attribution remains unknown rather than zero or whole-conversation cost.
- [ ] Run tests including a large synthetic dataset and inspect query plans for indexed date/tag filtering; commit `feat: report tagged execution history`.

## Task 5: Tag pickers and Settings history

**Files:** Create `public/app/automation-tag-picker.js`, `public/app/automation-tags.js`, `public/app/automation-executions.js`, `test/ui/ui-automation-tags.test.ts`. Modify `public/app/cron.js`, `public/app/webhooks.js`, `public/app/settings.js`, `public/index.html`, `public/styles.css`, `public/sw.js`, and corresponding cache-version assertions.

**Interfaces:** `createAutomationTagPicker(container, {workspaceId, value, onChange})` returns `{ setWorkspace(workspaceId), setValue(assignments), getValue(), destroy() }`. Use separate controls for selecting managed tags, adding manual text and explicit catalog creation. `loadAutomationTags()` loads Settings → Tags for the selected workspace. The execution view uses Task 4's API and existing conversation navigation.

- [ ] Add an isolated UI journey creating a managed tag in Settings, selecting it on both automation forms, adding a manual tag without catalog mutation, explicit inline catalog creation, changing workspace without stale selections, and editing assignments.
- [ ] Add a seeded execution journey asserting counts/trend, source and date filtering, conversation navigation, manual/retired-tag history, empty/error states, and fitted pagination at desktop and narrow sizes. Assert text is escaped and all controls have test IDs.
- [ ] Run `npm run test:file -- test/ui/ui-automation-tags.test.ts`; confirm failure using disposable profiles/servers and cleanup.
- [ ] Implement pickers and Settings tabs/views using `createFittedList` from `public/app/relay-ui.js`. Render daily trend accessibly, with numbers available as text. Surface save/sync errors in the active panel. Bump service-worker cache and pinned tests together.
- [ ] Rerun new journey plus `test/ui/ui-cron.test.ts`; confirm pass and commit `feat: browse automation tags and statistics`.

## Task 6: Integrated verification and review

- [ ] Re-read the spec against the implementation and confirm every requirement has a behavioral test, including authorized cross-node visibility and actual webhook completion.
- [ ] Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:ui` through the isolated harness; await results directly. Diagnose failures before claiming success and distinguish unrelated pre-existing failures.
- [ ] Request a fresh read-only review of only feature commits/diffs, emphasizing workspace authorization, immutable snapshots, execution identity and usage attribution. Do not permit reviewer changes to unrelated work.
- [ ] Fix verified findings with regression tests, rerun affected suites, inspect `git diff --check` and staged hunks, and report exact verification results.

## Plan review

The tasks cover catalog management, explicit/manual assignment, cross-node workspace scoping, immutable accepted-run snapshots, durable completion, historical browsing, trends/statistics and browser behavior. Execution storage is separate from the 25-entry webhook delivery log. All five review-focus cases have named tests above. No implementation has started. Approval is still needed for the proposed details in the design, including tag limits, rename/delete behavior and the metric definitions.
