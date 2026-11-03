# Scheduled auto-reply implementation plan

**Goal:** Configure auto-reply on scheduled tasks, and keep all auto-reply runs active until explicit stop criteria, manual Stop, or the configured response limit.

**Architecture:** Store the existing auto-responder configuration with each schedule. Apply it when a queued scheduled prompt actually starts, not while another turn owns the conversation. Existing conversation queue remains the single dispatcher. Persist retry status and reopen active responders after restart without replaying uncertain prompts.

**Tech stack:** TypeScript, Zod, SQLite, browser JavaScript, isolated Node/Playwright tests.

## Constraints and decisions
- Preserve authorization, budgets, browser takeover, ownership and Guardian restrictions. A restriction waits visibly rather than disabling the responder.
- Transient failures and unusable decisions retry with capped backoff, without consuming response allowance.
- Empty stop criteria means no model-selected stop. No implicit stagnation/completion rules.
- Manual Stop and disabling cancel retries immediately.
- Preserve all unrelated edits in this shared checkout. No branches or worktrees.
- Schedule history remains running throughout auto-reply, preventing overlapping invocations.

## Tasks
- [x] Add regression tests for explicit-only stop rules, transient/unusable decisions, schedule persistence and executor lifecycle; run and observe failure.
- [x] Implement persistent retry state, bounded backoff, failed-turn recovery, and unattended restart recovery in the shared responder flow. Test manual cancellation and response limits.
- [x] Add schedule config schema/validation, apply configuration at prompt dispatch, and keep executor open until responder stops.
- [x] Add inline scheduled-task controls for harness/model/reasoning/profile, instructions, stop criteria, limit and tool checks; cover save/reopen using isolated browser tests.
- [x] Run focused suites, typecheck and build. Inspect final diff for unrelated changes.

## Verification
`npm run test:file -- test/auto-respond.test.ts test/cron-executor.test.ts test/cron.test.ts test/cron-api.test.ts test/harness-cron-schema.test.ts`
`npm run test:file -- test/ui/ui-cron.test.ts test/ui/ui-auto-respond.test.ts`
`npm run typecheck`
`npm run build`

## Ledger
- User approved direct implementation and automatic retry/resume after failures/restarts. Mockups declined.
- Verified 46 focused server/unit tests and 7 isolated browser tests, plus typecheck/build and diff whitespace check.
- Added regressions for manual Stop during retry, failed/unacknowledged turn recovery without replay, stuck prompt timeouts, unattended scheduled restart with preserved allowance, and two scheduled drivers sharing one conversation.
- Independent reviewer launch failed before reviewing because its configured model was unsupported by its account. Reviewed the lifecycle and authorization paths directly instead.
- Ruling: queued schedules wait behind the active scheduled driver, without resetting its allowance or cancelling its decision. Otherwise one schedule replaces another and the original run never settles.
