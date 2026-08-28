# Code generation plan

## Scope and current state

Zero-Unit brownfield bugfix. Ponytail rung: minimum custom code using Node.js filesystem, SQLite, `AbortSignal`, the existing replication loop, Pi SDK, WebSocket transport, and Node test runner. No dependency or test configuration change is planned.

Already present and preserved:

- `src/session-paths.ts`, `src/pi-service.ts`, `src/claude-service.ts`, `test/pi-session-discovery.test.ts`, and untracked `test/claude-sync-conflict.test.ts` contain an uncommitted partial fix that hides `.sync-conflict-*` files. This prevents duplicate rows but does not select, validate, restore, or relocate the newest coherent Pi transcript. The implementation will extend or replace only this partial behavior.
- `src/syncthing.ts` and `test/syncthing.test.ts` in `HEAD` already migrate `__pycache__/` to `(?d)__pycache__/` while retaining user rules. This satisfies the code portion of FR5, FR5.1, and FR5.2. The existing working-tree timeout addition in `src/syncthing.ts` is unrelated and will remain untouched.
- Pi and Claude already emit `textDelta`; Pi already requests native `followUp`. The missing work is guaranteed pre-final browser paint, a serialized Claude follow-up queue, explicit queue/error behavior, and runtime regressions.
- Review persistence already stores activity and review watermarks, but the browser sends paths without click-time `updatedAt` values and the SQL update can advance `reviewed_at` through newer server activity.
- Other modified files for attachments, tasks, recent conversations, board UI, service-worker notifications, prior intents, and code knowledge are unrelated. They will not be reverted, reformatted, or claimed by this iteration.

`requirements.md` ends with a `NOT-READY` review. Part 2 must not guess about the two critical gaps. Before source edits, the recovery selector needs an approved measurable coherence rule that prevents a newer truncated transcript from replacing a fuller canonical transcript. Ownership also needs approved membership, timeout, retry, restart, and lost-acknowledgement semantics. The smallest durable defaults proposed by this plan are: a replacement candidate must preserve every canonical event identity in order, and transfer state is epoch-idempotent with destination `owned` as the only commit boundary. If those defaults are not approved with this plan, return to Requirements Analysis.

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run",
  "scope": "bugfix",
  "test_strategy": "minimal",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    }
  ],
  "obligations": {
    "strategy": "minimal",
    "strategy_volume": [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect."
    ],
    "scope_floor": [
      "Include a targeted regression for the bug or vulnerability.",
      "Keep the existing test suite green."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "test-after",
    "runner_step": "Verify the existing test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Verify the existing test runner/configuration and record the exact unit-scoped command.",
      "Data model / database behavior - implement.",
      "Data model / database behavior - write and run its tests after implementation.",
      "Repository / data access - implement.",
      "Repository / data access - write and run its tests after implementation.",
      "Business logic - implement.",
      "Business logic - write and run its tests after implementation.",
      "API / endpoint - implement.",
      "API / endpoint - write and run its tests after implementation.",
      "Frontend behavior - implement.",
      "Frontend behavior - write and run its tests after implementation.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:ee85052f599aa0596a4d7afe86f4d1d36a0005ee7d07141ef240fc95ebca5f75",
  "contract_sha256": "sha256:e6f35030de628cbc331ec78aaf90bce7956a721aed1eb48abeaf04d3cc1d5342"
}
```

## Numbered implementation steps

- [x] **Step 1. Confirm boundaries and preserve the working tree.** Recheck `git diff` before Part 2, record the related baseline paths, adopt the coherence and transfer-state rules stated above, and leave unrelated changes untouched. No scaffold, dependency, generated client, migration framework, or new test configuration is needed. **Traceability:** FR1.2-FR1.5, FR2.2-FR2.5, NFR3, NFR5.
- [x] **Step 2. Verify the existing narrow test runner.** Confirm `node --import tsx --test <exact files>` works using the commands in `unit-test-instructions.md` before the first new test is written. Keep `package.json` and `tsconfig.json` unchanged unless the runner proves insufficient. **Traceability:** NFR7, NFR8.
- [x] **Step 3. Implement conversation-ownership persistence and replication.** Add one focused SQLite module, using the existing `node.db`, `BEGIN IMMEDIATE`, and replication outbox conventions. Store engine, session ID, owner node ID, epoch, and `owned`/`transferring`; reject same-epoch conflicting owners; apply only higher epochs; expose explicit claim, begin-transfer, and destination-commit operations. Extend `src/replication.ts` only for the new validated entity type. Emit structured diagnostics without transcript content or credentials. **Traceability:** FR2, FR2.1, FR2.2, FR2.5, NFR2, NFR5, NFR6.
- [x] **Step 4. Write and run ownership repository tests after Step 3.** Add narrow tests for epoch monotonicity, persistence after module/process restart, stale updates, same-epoch split-brain blocking, idempotent transfer retry, and structured diagnostics. Run the ownership unit command. **Traceability:** FR2.1, FR2.5, NFR2, NFR6, NFR7.
- [x] **Step 5. Implement canonical Pi transcript recovery.** Replace hide-only handling with one-directory grouping that parses only groups containing conflict candidates. Derive the canonical session ID from both filename forms; validate nonblank JSON lines, Pi header/version/ID, ordering timestamps, and Pi `SessionManager` loadability. Require a replacement candidate to preserve canonical event identities in order, rank coherent candidates by latest event timestamp, canonical-path tie-break, then lexical absolute path. Copy the winner to a same-directory temporary file and atomically rename it over canonical; move non-selected conflicts to a Joint Bob directory under `os.tmpdir()` only after replacement succeeds. Return only canonical paths to listing, review, watch, load, and resume flows. Report explicit structured recovery failures and leave all files in place when no candidate is valid. Preserve Claude's current duplicate filtering. **Traceability:** FR1, FR1.1-FR1.6, NFR2-NFR6.
- [x] **Step 6. Write and run transcript recovery tests after Step 5.** Upgrade the present Pi duplicate test into behavior tests for canonical selection, conflict winner replacement, canonical tie-break, lexical tie-break, malformed JSON, wrong header/ID, invalid timestamps, Pi load failure, truncated-newest rejection, complete Wolt/test/deployment preservation, temporary relocation, failure preservation, canonical-only listing/resume/watch behavior, and 500/1,000-path scaling. Keep the separate Claude listing regression. Run the discovery command. **Traceability:** FR1-FR1.6, NFR2-NFR4, NFR6, NFR7.
- [x] **Step 7. Enforce ownership at every execution boundary and transfer API.** Before Pi or Claude can create, resume, prompt, or mutate a transcript, require local `owned` state at the highest epoch. Give new Pi and Claude sessions a known session ID, persist epoch 1 before the first transcript-writing turn, and return HTTP/WebSocket conflict errors naming the owner and transfer action for non-owners. Extend the existing transfer routes into a fail-closed, epoch-idempotent source `transferring` and destination `owned` handshake. Poll every fixed cluster member from one captured membership snapshot with the existing peer timeout style; unavailable peers fail the claim. Lost destination acknowledgement is resolved by querying the destination's committed epoch, never by granting both nodes. **Traceability:** FR2-FR2.5, NFR1, NFR2, NFR5, NFR6.
- [x] **Step 8. Write and run ownership API and two-node regressions after Step 7.** Add a process-isolated two-node test that starts from the former divergent-writer scenario, submits concurrent continuation attempts, proves only one engine invocation/transcript mutation occurs, confirms an actionable conflict, performs explicit transfer, verifies restart ownership, and asserts no `.sync-conflict-*` file appears. Add Pi and Claude listing/resume and transfer API cases at the same boundary. Run the ownership mesh command. **Traceability:** FR2.2-FR2.5, NFR1, NFR2, NFR6, NFR7.
- [x] **Step 9. Implement stream visibility and queues.** Render the first nonempty assistant delta synchronously before frame batching so a final event cannot overtake the first paint; keep later deltas coalesced and final Markdown deduplicated. Keep Pi's native `followUp`, send immediate queued acknowledgement/status, and add a one-at-a-time FIFO Claude prompt queue that starts exactly once after the active turn. Abort remains immediate. Active-turn commands that cannot queue return explicit errors. **Traceability:** FR3, FR3.1, FR3.2, NFR5.
- [x] **Step 10. Write and run streaming tests after Step 9.** Extend the existing render/runtime fixture to prove first nonempty Pi and Claude text is visible before finalization, final text is neither duplicated nor dropped, a second prompt is immediately acknowledged and runs once in order, abort bypasses the queue, and unsupported active-turn commands fail without queue mutation. Run the streaming command. **Traceability:** FR3-FR3.2, NFR7.
- [x] **Step 11. Implement click-watermark review behavior.** Change the single and bulk browser payloads to submit `{ sessionPath, updatedAt }` captured from the displayed rows. Validate those objects at the API boundary. In one SQLite transaction, advance `reviewed_at` only through each submitted watermark while retaining the maximum server-observed `last_activity_at`; use the same repository operation for single and bulk review. **Traceability:** FR4, FR4.1, FR4.2, NFR2, NFR5.
- [x] **Step 12. Write and run review tests after Step 11.** Extend repository and API tests for single and bulk happy paths, activity before/equal to click becoming reviewed, activity after click remaining `needs_review`, stale/missing session rejection, and the reported mark-all rollback race. Run the review command. **Traceability:** FR4-FR4.2, NFR7.
- [x] **Step 13. Verify the already-present Syncthing fix.** Do not rewrite `src/syncthing.ts`. Run its narrow test to prove obsolete `__pycache__/` removal, exact `(?d)__pycache__/` insertion, preservation of user rules, and no delete-allowed prefix on credentials, environment files, logs, source, or arbitrary ignores. Record the operational beecomm rescan/status check for Build and Test rather than hard-coding a node-specific folder. **Traceability:** FR5-FR5.3, NFR5, NFR7.
- [x] **Step 14. Update the frontend shell cache only if Step 9 changes shell assets.** If a new or modified frontend module enters `APP_SHELL`, bump `CACHE_NAME` in `public/sw.js` and verify every listed asset exists. Do not disturb the unrelated notification-tag edit already present. **Traceability:** FR3, NFR7.
- [x] **Step 15. Run focused checks and prepare handoff artifacts.** Run every exact file-scoped command from `unit-test-instructions.md`. Then, before delivery in Build and Test, run `npm run typecheck`, `npm test`, and `npm run build`, plus the two production-node deployment checks selected by the user. Create `code-summary.md`, `source-manifest.json`, and `traceability.json` from actual Part 2 writes only, excluding pre-existing unrelated changes. **Traceability:** all FRs, NFR1-NFR8.

## Completion-gate repair status

- [x] Listing and read-only open are non-mutating; explicit Pi recovery requires an all-peer recovery fence, no open local session, and immediate canonical revalidation.
- [x] Claims use all-captured-member compare-and-set responses and exact-state commit; stale epochs reject and same-epoch owner conflicts persist a write-blocking fence.
- [x] Pi and Claude transfers require a replicated source fence, authenticated source binding, destination idempotency, and lost-acknowledgement reconciliation.
- [x] Ownership is required at every transcript mutation and agent/task invocation while non-owner listing and open remain read-only.
- [x] The ownership mesh regression starts two isolated servers and exercises real HTTP and WebSocket claim, prompt, transfer, lost-acknowledgement, and restart paths through a stubbed engine boundary.

## Requirement coverage map

- **FR1, FR1.1-FR1.6:** Steps 5-6.
- **FR2, FR2.1-FR2.5:** Steps 3-4 and 7-8.
- **FR3, FR3.1-FR3.2:** Steps 9-10 and conditional Step 14.
- **FR4, FR4.1-FR4.2:** Steps 11-12.
- **FR5, FR5.1-FR5.3:** Step 13.
- **NFR1:** Step 8.
- **NFR2:** Steps 3-8 and 11-12.
- **NFR3-NFR4:** Steps 5-6.
- **NFR5:** Steps 1, 3, 5, 7, 9, 11, and 13.
- **NFR6:** Steps 3-8.
- **NFR7:** Steps 2, 4, 6, 8, 10, 12-14.
- **NFR8:** Steps 2 and 15.

## Planned source and test surface

Expected application paths: `src/conversation-ownership.ts` as the one justified new module; focused edits to `src/replication.ts`, `src/session-paths.ts`, `src/pi-service.ts`, `src/claude-service.ts`, `src/conversation-reviews.ts`, `src/server.ts`, `src/watcher.ts`, and `public/app.js`; conditional `public/sw.js` edit only for cache correctness. `src/syncthing.ts` needs no intent-related code edit.

Expected tests: extend `test/pi-session-discovery.test.ts`, `test/claude-sync-conflict.test.ts`, `test/conversation-review-api.test.ts`, `test/conversation-status-indicators.test.ts`, `test/streaming-render-performance.test.ts`, `test/claude-session-reattach.test.ts`, and `test/syncthing.test.ts`; add only the narrow ownership and WebSocket process tests named in `unit-test-instructions.md` when existing files cannot reproduce those boundaries.
