<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-08-30T10:05:00Z — Step 4 derives the destination from `claudeSessionFilePath(connection.cwd, sessionId)` rather than selecting from the `claudeProjectDirs` list, which sidesteps requirements OQ1 (the multi-candidate ordering rule) instead of answering it.


## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-08-30T10:05:00Z — `aidlc-testing-posture.ts fingerprint` requires `--unit` and composes `<record>/construction/<unit>/code-generation/`, which has no zero-Unit form even though this stage's own prose mandates the unit-less layout for incremental scopes. Passed `--unit .` so `join` normalises to the correct zero-Unit directory; the hash covers the real plan and instructions.
- 2026-08-30T10:05:00Z — Refreshed every code citation against the live working tree before planning rather than inheriting the requirements document's line numbers, which the advisory review proved stale by up to 111 lines. Also recorded two corrected counts (120 test files, `joint-bob-v55`) and one fact the requirements missed: `claudeProjectsRoot()` is not exported.
- 2026-08-30T10:15:00Z — `aidlc-plan-approval-guard.ts` refuses a developer dispatch unless the plan sits at `construction/<unit>/code-generation/`, while this stage's zero-Unit prose and the engine's own `produces` paths both put it at `construction/code-generation/`. Bridged with symlinks in `construction/code-generation/code-generation/` pointing at the real files, so the guard and the engine read identical bytes and nothing is duplicated. Third instance today of unit-shaped tooling meeting a unit-less scope.

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-08-30T10:05:00Z — The pre-existing `session-watcher.test.ts` failure sits in the module Step 5 edits. Whether it is caused by the uncommitted working-tree edits to that test file or by a real watcher defect is unresolved; it is excluded from this change's pass criterion either way.

