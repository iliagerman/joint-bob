# Cross-Unit Traceability — Scoped Secrets

Stage-level coverage gate for Build and Test. This is **not** the Construction phase boundary
check; it verifies that every requirement enumerated in
`<record>/inception/requirements-analysis/requirements.md` is claimed by a code-generation
traceability entry with status `OK`, and that the file each entry names actually exists.

## Verdict

**PASS.** 55 requirement IDs enumerated, 55 covered with status `OK`, 0 uncovered,
0 entries pointing at a file that does not exist, 0 entries claiming a requirement that was
never stated.

This workflow ran the `express` scope, so User Stories was skipped and no `AC` IDs exist to
enumerate. Units Generation was skipped too, so there is one stage-level
`traceability.json` at `<record>/construction/code-generation/` rather than one per unit.

## Per-requirement coverage

| ID | Status | Owning stage / Unit | Target file | Target exists |
|---|---|---|---|---|
| `FR1.1` | OK | code-generation (stage-level) | `src/store.ts` | yes |
| `FR1.2` | OK | code-generation (stage-level) | `test/workspace-schema.test.ts` | yes |
| `FR1.3` | OK | code-generation (stage-level) | `test/workspace-schema.test.ts` | yes |
| `FR1.4` | OK | code-generation (stage-level) | `src/store.ts` | yes |
| `FR1.5` | OK | code-generation (stage-level) | `test/workspaces.test.ts` | yes |
| `FR2.1` | OK | code-generation (stage-level) | `src/store.ts` | yes |
| `FR2.2` | OK | code-generation (stage-level) | `public/index.html` | yes |
| `FR2.3` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR2.4` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR3.1` | OK | code-generation (stage-level) | `test/workspace-schema.test.ts` | yes |
| `FR3.2` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR3.3` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR3.4` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR3.5` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR4.1` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR4.2` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR4.3` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR4.4` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR5.1` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR5.2` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR5.3` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR5.4` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR5.5` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR6.1` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.2` | OK | code-generation (stage-level) | `test/secrets-migration.test.ts` | yes |
| `FR6.3` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.4` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.5` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.6` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.7` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR6.8` | OK | code-generation (stage-level) | `test/secrets-migration.test.ts` | yes |
| `FR7.1` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR7.2` | OK | code-generation (stage-level) | `test/secret-replication.test.ts` | yes |
| `FR7.3` | OK | code-generation (stage-level) | `test/secret-replication.test.ts` | yes |
| `FR7.4` | OK | code-generation (stage-level) | `test/secret-replication.test.ts` | yes |
| `FR7.5` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR8.1` | OK | code-generation (stage-level) | `src/secrets-migration.ts` | yes |
| `FR8.2` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR8.3` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR8.4` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR8.5` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `FR9.1` | OK | code-generation (stage-level) | `public/app.js` | yes |
| `FR9.2` | OK | code-generation (stage-level) | `public/app.js` | yes |
| `FR9.3` | OK | code-generation (stage-level) | `public/app.js` | yes |
| `FR9.4` | OK | code-generation (stage-level) | `public/index.html` | yes |
| `FR9.5` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `FR9.6` | OK | code-generation (stage-level) | `public/app.js` | yes |
| `FR9.7` | OK | code-generation (stage-level) | `test/secrets-api.test.ts` | yes |
| `NFR1` | OK | code-generation (stage-level) | `src/secrets.ts` | yes |
| `NFR2` | OK | code-generation (stage-level) | `test/secrets-api.test.ts` | yes |
| `NFR3` | OK | code-generation (stage-level) | `test/secret-replication.test.ts` | yes |
| `NFR4` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `NFR5` | OK | code-generation (stage-level) | `test/secrets-migration.test.ts` | yes |
| `NFR6` | OK | code-generation (stage-level) | `test/secrets.test.ts` | yes |
| `NFR7` | OK | code-generation (stage-level) | `src/secret-replication.ts` | yes |

## Uncovered elements

None.

## Caveat worth carrying forward

Traceability proves that a requirement has an owner in the code, not that the code is correct.
Correctness rests on the 446 passing tests recorded in `test-results.md` and on the four
manual checks in `integration-test-instructions.md` that no automated test can reach.
