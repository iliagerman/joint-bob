<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

- 2026-08-30T20:25:19Z — excluded `.claude/` and `aidlc/` from the product code scan; they are the AI-DLC framework harness and its workspace records, not this project's application code, so treating them as product would distort the component inventory and tech-stack artifacts.

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

- 2026-08-30T20:53:31Z — the code scan results were truncated when returned as chat text, so the scanning agent wrote the full 1,464-line results to a scratchpad file and the synthesising agent read that file instead. Passing large scan results between pipeline links as a file path rather than as return text avoids silent truncation of the only input the next link gets.

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

- 2026-08-30T20:53:31Z — recorded the scan as `kind: partial` rather than full: `src/server.ts` (4,972 lines) and `public/app.js` (5,854 lines) were read in named ranges covering the routes, schemas and UI this intent touches, not end to end. Reading both in full would have cost a large amount of context for handler bodies unrelated to secrets, and an honest partial marker keeps the freshness guard truthful for the next run.

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
