# Code Quality Assessment

## Assessment Scope

The scan deeply covered all 29 backend TypeScript modules, core browser JavaScript/HTML, operations and infrastructure code, package/configuration files, and tests tied to conversations, reviews, Syncthing, startup, distribution, and node sync. The remaining 88-file test inventory, styles, shell assets, generated output, dependencies, and workflow history received shallow or targeted review.

No coverage instrumentation exists, so the scan cannot claim line, branch, or function coverage percentages.

## Validation Baseline

Validation recorded on `2026-08-27`:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 246 passed, 0 failed, 0 skipped |
| `npm run build` | Passed |
| `terraform fmt -check -recursive` | Passed |
| `terraform validate` | Passed |
| `terraform test` | 1 run passed, 0 failed |
| Public-registry `npm audit --omit=dev` | 0 production vulnerabilities across 279 records |

The configured npm proxy audit endpoint returned HTTP 400; the explicit public-registry run succeeded. This is environment evidence, not an application defect.

## Strengths

- Strict TypeScript backend with no product-source suppression directives found.
- Zod validation at HTTP and WebSocket trust boundaries.
- Scrypt password hashing, secure cookie attributes, login rate limiting, CSRF checks, and strict WebSocket origin validation.
- Timing-safe machine-token checks and AES-256-GCM encrypted secrets with node-local mode-`0600` key material.
- Explicit SQLite transactions protect many multi-table operations.
- Process-isolated multi-node tests cover replication, migrations, ownership, handoff races, and filesystem boundaries.
- Installer rollback, checksums, npm provenance, encrypted EC2 storage, IMDSv2, and `/32` smoke ingress are tested or configured.
- README, `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`, service templates, and deployment guidance are substantial.
- No TODO/FIXME/HACK markers were found in product source; debt is visible in structure and behavior instead of hidden markers.

## Testing Assessment

### Strong Coverage Areas

Authentication/CSRF/WebSockets, SQLite migration and convergence, cluster mesh behavior, task ownership/handoff, Syncthing fake API behavior, installer rollback, project/session path mapping, startup readiness, and public package assets have meaningful automated checks.

### Active Bug Gaps

1. **Streaming:** no behavioral test proves that a connected browser visibly renders an assistant delta before `assistantFinal`/`agent_end`, or that steering can be queued in the same turn. Existing tests inspect source structure and final flush behavior.
2. **Review state:** no regression covers transcript activity changing after prior state synchronization but before `reviewed-all`; the existing route test avoids the race by listing first.
3. **Syncthing:** no regression migrates the old managed Python-cache rule to exact delete-allowed semantics while preserving user and sensitive rules.

Bugfix policy requires these targeted regressions and the full existing suite green.

### General Gaps

- No measured coverage thresholds or reports.
- No real-browser E2E runner; many UI tests assert strings/regular expressions rather than runtime DOM behavior.
- No load, soak, or fault-injection suite.
- Terraform tests do not run in the tagged release workflow.
- No PR or ordinary `main`-push hosted CI gate.

## Maintainability

| Signal | Evidence | Consequence |
|---|---|---|
| Oversized backend composition root | `src/server.ts`: 3,719 lines | High collision and cross-domain regression risk |
| Oversized frontend composition root | `public/app.js`: 4,057 lines | Stream, UI state, transport, and rendering changes interact |
| Other large modules | `store.ts` 695; `cluster.ts` 592; `tasks.ts` 560; `github-auth.ts` 555 | Functions exceed preferred 50-line project guideline |
| Distributed schema setup | Many modules create/alter one SQLite database | Migration order and ownership are hard to audit |
| Multiple DB handles | Module-local cached `DatabaseSync` instances | Transaction ownership and startup behavior are cross-cutting |
| Duplicated crypto helpers | Cluster, settings, push, GitHub credentials | Security fixes can drift |
| Handwritten contracts | TypeScript server ↔ untyped browser JavaScript | Enum/event/schema drift is easy |
| Dual lockfiles | `package-lock.json`, `npm-shrinkwrap.json` | Manual synchronization burden |
| Compatibility aliases | Old env names, paths, identities | Upgrade support expands core-path branches and tests |

Minimal refactoring is preferable during the active bugfix. Extract only seams needed to test the observed behavior.

## Tooling and Delivery

No ESLint, Prettier, Biome, ShellCheck, Markdown lint, or repository formatter configuration exists. TypeScript strict mode is the general static gate; Terraform follows `terraform fmt`. Follow existing style rather than introducing a formatter as part of unrelated fixes.

`.github/workflows/release.yml` validates only `v*` tags: install, typecheck, tests, build, package smoke checks, checksums, GitHub release, and provenance-enabled npm publication. Local pre-push automation deploys exact `main` commits to installed nodes but is not centralized CI.

## Security and Privacy Concerns

1. Project file download checks lexical containment, then follows symlinks via `stat`/`createReadStream`; an in-project symlink may escape the project.
2. Generic HTTP 500 responses expose many internal `Error.message` values.
3. Claude bypasses permission prompts and Pi safeguards can be disabled, increasing the impact of stolen browser sessions or public exposure.
4. Peer URLs allow general valid URLs; private HTTPS is documented but not enforced, preserving SSRF and token-exposure risk under unsafe administrator configuration.
5. There is no API rate limiting beyond login attempts.
6. Review rows are per-user behavioral data and should not be replicated without a privacy requirement.
7. Syncthing `(?d)` grants destructive behavior. It must remain restricted to proven generated caches and never apply to credentials, environment files, source, logs, or arbitrary user rules.

No formal regulatory/compliance scope is documented. These findings are not a compliance certification.

## Technical Debt Priorities

| Priority | Item | Testable completion signal |
|---|---|---|
| P0 | Fix three active defects without broad refactoring | Three targeted regressions plus typecheck, 246+ tests, build, Terraform checks green |
| P1 | Realpath/lstat project-file boundary | Symlink escape regression fails closed |
| P1 | Sanitized unexpected errors | Integration test proves internal paths/messages are not returned |
| P1 | PR/main CI | Hosted workflow runs typecheck, tests, build; Terraform checks when relevant |
| P2 | Ordered SQLite migration ledger | Deterministic schema version and migration tests across upgrades |
| P2 | Browser/server contract seam | Runtime or generated contract catches event/enum drift |
| P2 | Real-browser stream/UI tests | Browser test observes intermediate paint, steering, mobile interactions |

## Overall Assessment

Core authentication, transactions, multi-node convergence, handoff, and delivery controls are serious and currently green. Change safety is reduced by two oversized composition files, shared-schema coupling, untyped browser contracts, source-regex UI tests, and missing PR CI/coverage. The active fixes should be narrow, boundary-tested, and traceable to the three observed failure modes.
