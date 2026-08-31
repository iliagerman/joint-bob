<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->

- 2026-08-30T21:56:16Z — placed the planning artifacts under `construction/scoped-secrets/code-generation/` as well as the engine's zero-Unit path `construction/code-generation/`; the plan-approval guard enumerates known units by listing directories under `construction/`, so a zero-Unit run whose artifacts sit directly in `construction/code-generation/` can never present a marker that matches a known unit and every dispatch is refused. A conductor-chosen unit name is what the guard's own comment expects for scopes that skip units-generation.

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->

- 2026-08-30T22:24:26Z — kept the cross-node wire field `ProjectRecord.type` under its old name while renaming the database column, store functions, routes and UI to workspace; renaming a payload key that paired nodes exchange would break a peer still running an older build (NFR7, C6), and the rename's value is in the code and data the team reads, not in the wire.
- 2026-08-30T22:24:26Z — the test count fell from 450 to 446 because roughly 19 tests describing the removed GitHub credential group model were deleted with the feature and 15 new ones were added; a falling count is the correct outcome when a requirement removes behaviour, and the honest check is that every test describing surviving behaviour still passes.

## Open questions
- 2026-08-30T21:56:16Z — the zero-Unit paragraph in the code-generation stage file (no synthetic Unit segment) and the plan-approval guard's directory-listing unit register disagree; worth reconciling upstream so express-scope runs do not need a duplicated artifact path.

<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
