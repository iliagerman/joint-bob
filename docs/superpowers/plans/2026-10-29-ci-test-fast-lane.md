# CI test fast lane implementation plan

> **For agentic workers:** use this plan task-by-task with test-driven development.

**Goal:** Shorten ordinary `main` validation while keeping the full suite on scheduled runs and before publishing.

**Architecture:** Divide test files deterministically across four independent GitHub Actions workers. Ordinary main pushes run all files with a smaller file-sync fuzz sample; scheduled and publishable runs use the existing full sample. Cache npm downloads in test workers.

**Tech Stack:** GitHub Actions, Node.js test runner, npm.

**Spec:** User request in conversation: split and optimize CI tests, commit, push, monitor, and fix issues found.

## Global constraints

- Do not delete test coverage; retain the full randomized seed counts in nightly and publishable runs.
- Preserve test file failure reruns within each shard.
- Existing unrelated working-tree edits must remain untouched.
- Full validation must gate a package release.

## Review focus

- Sharding must cover every test file exactly once and reject invalid shard settings.
- The fast seed count must apply to all file-sync property suites without changing their full defaults.
- Nightly runs must not publish a release.
- Release jobs must wait for full-suite shards.
- Failures must still be rerun only for affected files.

---

### Task 1: Deterministic test sharding

**Files:** `scripts/ci-test.mjs`, new `test/ci-test-sharding.test.ts`.

- Add validated 1-based `TEST_SHARD_INDEX` and `TEST_SHARD_COUNT` selection.
- Add a list-only mode so tests can verify shard coverage without running the suite.
- Test deterministic, exhaustive, non-overlapping shards and invalid settings.
- Preserve the existing retry behavior per selected shard.

### Task 2: Fast and exhaustive workflow lanes

**Files:** `.github/workflows/release.yml`, `TESTING.md`.

- Run four shards with fail-fast disabled and shard-specific concurrency groups.
- Cache npm downloads.
- Use a smaller `FILE_SYNC_SEEDS` value for ordinary main pushes.
- Run full defaults on scheduled/manual runs and before publishing.
- Keep the release job blocked on all applicable test shards; schedule must never publish.

### Task 3: Verify, commit, push, monitor

- Run focused sharding tests, typecheck/build, and the full test suite where runtime permits.
- Commit only task files, push `main`, and monitor every shard and release-gate result.
- Fix failures caused by this change before reporting completion.
