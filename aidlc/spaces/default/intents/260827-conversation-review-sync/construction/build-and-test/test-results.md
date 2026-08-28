# Test Results

## Build status

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | Exit 0; no TypeScript errors |
| `npm run build` | PASS | Exit 0; `tsc` completed |
| `npm test` | PASS | 272 passed, 0 failed, 0 skipped |
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

Focused results overlap the 272-test full suite and are not added to its total.

## Operational verification

- Local `beecomm` Syncthing folder was rescanned and returned `synced`, zero remaining files, zero remaining bytes, and `Safe to start work`.
- The canonical Beecomm Pi transcript contains 788 events and still contains the Wolt analysis, test, deployment, and latest `here?` markers.
- The canonical transcript's synchronized directory contains zero conflict copies for that session ID. Older copies were moved to Joint Bob temporary recovery storage, not deleted directly.
- Local installed service health: `ok`, release `e92797a4a9ea189dd68557dfa4b36915b1a218e6`.
- Homeserver installed service health: `ok`, same release.
- Current implementation changes are uncommitted and therefore are not yet deployed to either installed service.

## Coverage and failures

No line-coverage threshold applies to Minimal bugfix scope. Requirement-driven targeted regressions and the full green suite are the quality floor. No build or test failure remains.

## Loop-Back Log

No Build-and-Test loop-back was required.
