# User-owned provider profile access implementation plan

**Goal:** Resolve interactive profiles per acting user and permit node-wide shared profiles only in automation, with current-profile or explicit-profile dropdowns.

**Architecture:** Keep credentials node-local. Store sharing on profile metadata, user-scoped selections, and automation creator/profile assignments. Authorize again at execution. Never resolve another user's interactive profile or silently fall back after an explicit assignment fails.

**Approved requirements:** Conversation in this session. Shared profiles are automation-only, including for their owner. Automation defaults to the creator's current applicable profile; explicit assignments remain pinned. Only owners manage credentials and sharing.

- [x] Core access: migration, owner-only management, separate interactive/automation listings and access checks, actor-based resolution and automation execution context. Unit/API tests.
- [x] Schedules and webhooks: persist creator and nullable explicit profile ID, validate at save and run, carry context into queued execution, add dropdowns. Focused tests.
- [x] Automated replies: persist creator and assignment, enforce execution context, add dropdown, focused tests.
- [x] Verify typecheck and focused tests; document results and limitations. No commit requested. Preserve unrelated modifications.

## Implementation and verification

- Interactive dispatch uses its persisted author and explicitly exits inherited automation context. Queue editing is author-only, automation-bound prompts cannot be edited interactively, and merging across authors/automation assignments is refused.
- Execution-affecting schedule/webhook updates require their original creator, including inherited/null profile assignments. Server-side HTTP tests cover forged creator IDs and unauthorized updates.
- Claude refresh authority moved to one service-private SDK store. Legacy native credentials migrate under a serialized gate. Project OS runtimes receive access-only tokens and disposable credential-free configs, never refresh credentials or the profile owner's tool permissions. The earlier cross-runtime refusal guard was superseded by broker tests.
- Focused backend runs passed profile ownership/sharing, API, creator/default resolution, credential refresh/migration, login cancellation, automation persistence/queues, cron API/execution, webhook delivery and auto-reply tests. A queued-attachment fixture initially failed the new author boundary; corrected the fixture to carry its actual author, then all 26 queued-engine tests passed with PWA/source checks.
- Three isolated browser journeys passed: profile creation/scoping/sharing, schedule/webhook dropdown default/explicit/clear/reopen, and auto-reply dropdown.
- Final targeted run after strict non-admin fallback enforcement: 21 tests passed. `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Full suite and live provider OAuth were not run. No commit, push, or deployment performed. Unrelated existing changes preserved.
