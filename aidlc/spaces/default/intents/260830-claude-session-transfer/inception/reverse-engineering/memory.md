<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-08-30T07:56:19Z — Store verdict was STALE (built by intent 260827-conversation-review-sync); human chose Full rescan, so the developer brief required whole-repo breadth rather than the intent's area.
- 2026-08-30T08:02:00Z — intents.json carries no `repos` array for this intent, so the stage ran single-repo against the workspace root (pi-mobile-web); no `--repo` flag on receipts.


## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-08-30T08:20:00Z — The full rescan still compared NARROWER against the prior store: 15 paths lost deep coverage (public/board.js, public/markdown.js, scripts/, deploy/, CONTRIBUTING.md, SECURITY.md, 9 test files). Disclosed per the 2026-08-28 project correction; recovery point commit 9ab9b04d0d3e23d2bdcfb1bcb8b84b7183b36ce1.
- 2026-08-30T08:20:00Z — The 18 component-name discards are mostly a taxonomy change (coarse role names replaced by one component per source module), not depth loss; only Kanban board UI, Markdown renderer, and Deployment and smoke infrastructure are genuine reductions.

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-08-30T08:02:00Z — Ordered the overwrite backstop inside the architect dispatch (draft timestamp, write scope-draft, compare, then write artifacts) rather than splitting it across links, because the compare needs the drafted timestamp content while the old store is still un-replaced.


## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-08-30T08:02:00Z — `claudeProjectDirs(project, root)` returns multiple candidate directories (one per sessionCwd plus each parent); the destination-directory selection rule for a received Claude transcript is unresolved and belongs to Requirements Analysis.
- 2026-08-30T08:02:00Z — Two roots for Claude projects coexist: `session-paths.ts` defaults to `~/.claude/projects` while `claude-service.ts` computes a settings-aware `claudeProjectsRoot()`; the fix must pick one deliberately.

