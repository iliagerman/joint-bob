# Machine Quality Analytics Implementation Plan

> **For agentic workers:** Implementation executed inline after the user explicitly requested continuation through completion.

**Goal:** Default-off local-machine collection of reply-quality judgments, reasons and lessons with historical backfill and paginated drill-down.

**Architecture:** Local SQLite tables and one persistent serial worker. Existing local conversation change events trigger scans; no new network sync. No-tools, no-session-persistence Claude generates bounded explanations; Jev validates outcomes, privacy and categories in batched questions. Admin-only Settings dashboard filters by existing project visibility.

**Tech Stack:** TypeScript, node:sqlite, Express, vanilla browser JS, existing Claude and Jev integration boundaries.

**Spec:** docs/superpowers/specs/2026-11-08-machine-quality-analytics-design.md

## Global constraints

- One machine-local switch, default off; production collection is not enabled by this implementation.
- No transcript archive, additional sharing, remote transcript requests or shared-rule writes.
- Preserve concurrent checkout changes; no pull/stash/reset/branches.
- Use source dates and distinguish unknown/inferred judgments from human conversation ratings.

## Tasks

- [x] Local store and deterministic observations: `src/quality-analytics.ts`, `test/quality-analytics.test.ts`. Default-off, resumable jobs, revision deduplication, coverage, source-date trends, access-scoped queries and pagination.
- [x] Worker and model boundaries: `src/server/quality-{collector,service,models,claude}.ts`, focused tests. Serial local-only inventory, >50 conversations, cancellation, persistent resume, long evidence windows, feedback changes, source rechecks, privacy judgments and native Claude no-session-persistence.
- [x] API and Settings dashboard: `src/server/routes/quality-analytics.ts`, `public/app/quality-analytics.js`, Settings integration. Admin-only toggle, filters, evaluator cohorts, issue drill-down, accepted-rule before/after association and bounded pages.
- [x] Documentation and verification: `docs/quality-analytics.md`; typecheck/build, focused tests, browser checks, live synthetic Claude/Jev checks and independent model review.

## Review record

A fresh no-tools/no-persistence Claude review identified important issues with removed ratings, deterministic malformed replies blocking later replies, unnecessary unchanged-history rereads, private generated explanations and macOS multi-user temp-directory traversal. These were addressed with regressions and focused checks. Additional checks cover changing evidence during inference, filtered lesson result limits, and all-reply denominators for before/after comparisons.

Ruling: collector scans are serialized; change events queue a later scan rather than directly enqueueing a running job. A regression demonstrates appended replies are handled without another external event. Changed evidence also explicitly schedules a rescan.

Ruling: per-reply malformed generated analysis remains visible as failed coverage and does not fabricate an unknown/success observation; later replies continue. Provider/configuration failures remain retryable conversation errors.

Ruling: aggregation retains locally derived lessons but never automatically installs shared rules, because the user's switch must not alter another machine's behavior.

## Verification evidence

- Red-to-green regressions were run for the store/worker and the filtered lesson limit.
- Focused real-server and browser tests exercise local opt-in, default-off, queueing, settings/filters and mobile width.
- Admin-gate and session-listing regression tests passed alongside feature tests.
- Live **synthetic-only** checks succeeded with `claude-opus-5-5` and `jev-1.14.0`, including the privacy judgment. No historical production backfill was launched.
- An audit of recently modified native Claude log/transcript files found zero copies of the synthetic verification prompt.
- Typecheck and build passed; no service restart or production deployment was performed.
