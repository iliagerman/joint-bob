# Test Results

## Build status

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | Exit 0; no TypeScript errors |
| `npm run build` | PASS | Exit 0; `tsc` completed |
| `npm test` | PASS | 273 passed, 0 failed, 0 skipped |
| Production dependency audit | PASS | Public npm audit endpoint: 0 vulnerabilities |

The first audit attempt against the configured private npm proxy returned HTTP 400 because that proxy's audit endpoint produced invalid output. Re-running the same lockfile against `https://registry.npmjs.org` passed.

## Focused regression results

| Area | Tests | Passed | Failed |
|---|---:|---:|---:|
| Canonical transcript recovery and discovery | 17 | 17 | 0 |
| Ownership, replication, real two-node race, transfer, restart | 4 | 4 | 0 |
| Streaming paint and queued follow-up | 10 | 10 | 0 |
| Review activity watermarks | 3 | 3 | 0 |
| Syncthing managed-ignore reconciliation | 12 | 12 | 0 |
| Recent-session canonicalization and quick keys | 9 | 9 | 0 |

Focused results overlap the 273-test full suite and are not added to its total.

## Operational verification

- Local `beecomm` Syncthing folder was rescanned and returned `synced`, zero remaining files, zero remaining bytes, and `Safe to start work`.
- The canonical Beecomm Pi transcript contains 788 events and still contains the Wolt analysis, test, deployment, and latest `here?` markers.
- The canonical transcript's synchronized directory contains zero conflict copies for that session ID. Older copies were moved to Joint Bob temporary recovery storage, not deleted directly.
- Local installed service health: `ok`, release `e92797a4a9ea189dd68557dfa4b36915b1a218e6`.
- Homeserver installed service health: `ok`, release `c36f094a352b2e2411dc5ff7092fc9a09426077d`.
- Loop-back 1 changes are uncommitted and therefore are not yet deployed to either installed service.

## Coverage and failures

No line-coverage threshold applies to Minimal bugfix scope. Requirement-driven targeted regressions and the full green suite are the quality floor. No build or test failure remains.

## Loop-Back Log

### Loop-back 1 — 2026-08-28T16:58:55Z

- **Diagnosis:** Homeserver preferences contain two stale `.sync-conflict-*` recent-session paths beside the canonical path, so one logical conversation renders three times. The dialog also exposes only `1`-`9`, and its global shortcut requires the less-direct `Ctrl/Cmd+Shift+K` chord.
- **Root-cause stage:** Code Generation.
- **Planned fix:** Canonicalize and deduplicate recent-session paths at the preferences boundary, keep client insertion canonical, change the opener to `Ctrl/Cmd+K`, and map `1`-`9` then `0` to the top ten rows. Add targeted persistence and UI regressions.
- **Estimated impact:** Low effort; zero financial cost; low risk, limited to recent-session preference cleanup and keyboard handling.
- **Result:** PASS. Preference storage self-heals exact and conflict-path duplicates; client identity is canonical; `Ctrl/Cmd+K` toggles the dialog; `1`-`9` then `0` address ten rows; focused tests pass 9/9 and the full suite passes 273/273.
