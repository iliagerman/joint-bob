# Build and Test Summary — Scoped Secrets

Consolidates the build, the test execution, the security review and the coverage gate for the
scoped-secrets change. Inputs read for this stage: the stage-level
`<record>/construction/code-generation/code-generation-plan.md`,
`unit-test-instructions.md` and `code-summary.md`.

## Overall status

| Dimension | Status |
|---|---|
| Build (`npm run build`, `npx tsc --noEmit`) | **Green** — compiles, type-checks clean |
| Tests (446 total) | **Green** — 446 pass, 0 fail, 0 skipped |
| Requirement coverage | **Pass** — 55/55 requirement IDs covered, every target file present |
| Security review | **Pass with one gap** — six checks pass; `npm audit` cannot run in this environment |
| Deployment readiness | **Ready with manual verification outstanding** |

## Test type inventory

| Type | Generated here | Why |
|---|---|---|
| Unit / backend integration | No — owned by Code Generation | 21 tests across four files, using real SQLite in a temp dir |
| Integration | Documented, not generated | Minimal strategy generates none; the two real cross-component boundaries (migration, node-to-node replication) are documented instead |
| Performance | Not applicable | No requirement in this change is a performance target |
| Security | Documented and executed | The change rewrites the product's credential model, so security is the subject matter |

## Coverage expectations

No coverage tooling exists in this repository and none was added, so line coverage is
unmeasured by design. The obligation the Minimal strategy sets is requirement coverage: one
verifiable test per requirement at the narrowest effective level, with the pre-existing suite
staying green. Both are met.

## Readiness assessment

- **Build-ready** — yes. Compiles clean on Node 22 with no new dependency.
- **Test-ready** — yes. The scoped command runs in about a fifth of a second; the whole suite
  in about 65 seconds.
- **Deployment-ready** — yes for a single node, *after* the manual checks below. Not yet
  proven on a real cluster.

## Known limitations and outstanding items

1. **Four things no automated test reaches** (listed in `integration-test-instructions.md`): a
   real `git push` through the generated `GIT_ASKPASS` helper; two paired nodes exchanging a
   replicating account and the receiver overwriting it; an older peer receiving the 410 stub
   at `POST /api/cluster/github/events`; and the migration running against a node that holds
   real credential groups. Back up `~/.joint-bob/node.db` before that last one.
2. **`npm audit` cannot run here** — the configured private registry does not implement the
   audit endpoint. No dependency was added by this change, so this is a standing environment
   gap rather than a finding against it.
3. **One wire field keeps its old name.** `ProjectRecord.type` is the payload key paired nodes
   exchange; renaming it would break a peer on an older build, so `POST /api/projects` still
   takes `{ type }` while everything a person reads says workspace.
4. **The frontend is verified by string assertions, not rendering.** `public/app.js` is 5,854
   lines of untypechecked JavaScript; the `*-ui.test.ts` files pin its text, which catches
   deletion and renaming but proves nothing about behaviour. The UI needs a human look.
