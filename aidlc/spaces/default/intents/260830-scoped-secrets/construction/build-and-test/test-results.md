# Test Results — Scoped Secrets

**Run at**: 2026-08-31T04:45:03Z · **Node**: v22.23.2 · **npm**: 10.9.8
**Commands executed by this stage**, from `build-instructions.md` and the stage-level
`<record>/construction/code-generation/unit-test-instructions.md`.

## Build

| Step | Command | Result |
|---|---|---|
| Compile | `npm run build` (= `tsc`) | **Success** — no diagnostics |
| Type check | `npx tsc --noEmit` | **Success** — exit 0, no output |
| Lint | — | **Not applicable** — the repository configures no linter |

## Tests

The stage-level unit-test instructions carry one scoped command; there are no per-unit
instruction files (zero-Unit `express` scope), so it ran once.

| Suite | Command | Total | Pass | Fail | Skip |
|---|---|---|---|---|---|
| Scoped (this change) | `node --import tsx --test test/secrets.test.ts test/secrets-migration.test.ts test/workspace-schema.test.ts test/secrets-ui.test.ts` | 21 | 21 | 0 | 0 |
| Whole project | `npm test` | 446 | 446 | 0 | 0 |

**Failure details**: none. No test failed, errored, was cancelled, or was skipped.

**Coverage report**: none produced. The repository configures no coverage tooling (no c8, nyc,
or `--experimental-test-coverage`), and the Minimal strategy sets no coverage floor. The
obligation met here is requirement coverage, verified in
`cross-unit-traceability.md`, not line coverage.

## Suite size before and after

| | Tests | Pass | Fail |
|---|---|---|---|
| Baseline, before any change | 450 | 450 | 0 |
| After this change | 446 | 446 | 0 |

The total falls by four, and that is the correct outcome. FR2.1 required the GitHub
credential group model be removed in full; four test files describing that model
(`github-account-groups`, `github-auth-mesh-api`, `github-auth-sync`, `github-sync-api`)
were deleted with the feature — roughly 19 tests — while 15 new tests were added across
`workspace-schema`, `secrets-migration`, `secret-replication`, `secrets-api` and the
extended `secrets` / `secrets-ui` files. Every test describing behaviour that survives the
change passes.

## Security checks

Recorded in full in `security-test-instructions.md`. Summary: six checks pass (no secret
value in any HTTP response, node-local accounts never enqueued, received material re-encrypted
with the local key, no hardcoded credential, encryption unchanged, file permissions unchanged).
One check could not run: `npm audit` fails because this repository resolves packages through
a private registry that does not implement the audit endpoint. That is an environment
limitation, not a finding about this change, which adds no dependency.

## Outstanding

Nothing blocking. Four things automated tests cannot reach are listed in
`integration-test-instructions.md` and need a manual pass before this runs on a real cluster:
a real `git push`, two paired nodes exchanging an account, an older peer receiving the 410
stub, and an upgrade against a node holding real credential groups.
