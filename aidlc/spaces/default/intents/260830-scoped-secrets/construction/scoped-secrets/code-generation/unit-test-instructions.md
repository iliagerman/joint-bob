# Unit Test Instructions — Scoped Secrets

**Test strategy**: Minimal · **Scope floor**: `express` adds no extra new-test floor; the
existing suite must stay green.

## Framework and commands

The repository uses Node's built-in runner with `tsx` transpilation. There is no Jest,
Vitest, Mocha, Playwright or Testing Library, and no coverage tooling — do not introduce
any.

The **exact scoped command** for this change (the only command Build and Test should run
for it):

```bash
node --import tsx --test test/secrets.test.ts test/secrets-migration.test.ts test/workspace-schema.test.ts test/secrets-ui.test.ts
```

Per-file commands used during implementation:

```bash
node --import tsx --test test/workspace-schema.test.ts
node --import tsx --test test/secrets-migration.test.ts
node --import tsx --test test/secrets.test.ts
node --import tsx --test test/secrets-ui.test.ts
```

The whole-suite baseline command (Step 1 and Step 15 only):

```bash
npm test
```

This command is verified runnable before the first test step; the repository is brownfield
and the runner already exists, so no bootstrap is required.

## Test scope — one test per requirement, happy-path floor per component

| File | Covers | Approx. tests |
|---|---|---|
| `test/workspace-schema.test.ts` (new) | FR1.2, FR1.3, FR3.1 — the workspaces rename preserves rows and touches no directories; the three scope types are accepted | 3 |
| `test/secrets-migration.test.ts` (new) | FR6.8, NFR5 — every project resolves the same token before and after; running twice changes nothing | 3 |
| `test/secrets.test.ts` (extend) | FR3.3, FR4.1–FR4.3, FR5.2, FR5.5, FR7.2, FR8.1–FR8.5, NFR3, NFR4 — resolution order, inertness, the GitHub variable set, cleanup, re-keying, no egress for node-local accounts | 8 |
| `test/secrets-ui.test.ts` (extend) | FR2.2, FR9.1–FR9.4, FR9.6 — the GitHub dialogs are gone, workspace wording present, the three attachment controls and the replicate toggle exist | 4 |

Total: roughly 18 tests, at the requirement-driven Minimal volume.

## Harness pattern to follow

Backend tests use the existing pattern from `test/secrets.test.ts:8-16` — create a temp dir,
point `PI_WEB_DATA_DIR` at it, hand-build the schema the module expects, then dynamically
re-import the module with a cache-busting query string so it builds a fresh
`DatabaseSync` handle. Restore the env var and remove the dir in a `finally`.

Migration tests follow `test/project-type-migration.test.ts` — reconstruct the **exact**
`CREATE TABLE` statements the previous build shipped (all nine `github_*` tables and the
pre-rename `project_types` / `projects` shape), insert legacy rows, run the upgrade, assert
the outcome.

Frontend tests follow the existing `*-ui.test.ts` shape: read `public/index.html` and
`public/app.js` as strings and assert on `data-testid` values and API call sites. These are
change-detectors on an untypechecked file, not behavioural tests — keep them that way rather
than introducing a DOM.

## Mocking and test data

- No mocking library. Use real SQLite in a temp directory, as the existing tests do.
- Never write a real credential into a test. Use obvious fakes (`ghp_test_alpha`,
  `ghp_test_beta`) so a leaked fixture is unmistakably not a secret.
- Peer replication is exercised by asserting on the outbox rows a call produces, not by
  standing up a second node.

## Coverage target

No coverage tooling exists in this repository and none is added. The obligation is
requirement coverage: every requirement listed in the table above has at least one test, and
the pre-existing suite finishes with zero new failures against the Step 1 baseline.
