# Code Generation Plan — Scoped Secrets

**Intent**: `260830-scoped-secrets` · **Scope**: express · **Depth**: Minimal
**Test Strategy**: Minimal · **Project type**: Brownfield
**Requirements**: `aidlc/spaces/default/intents/260830-scoped-secrets/inception/requirements-analysis/requirements.md`

This is a zero-Unit directive: one implementation iteration, artifacts under
`<record>/construction/code-generation/`, application code at the workspace root.

## Design Decisions Fixed Before Implementation

These resolve the requirements into concrete shapes so the plan steps are unambiguous.

**D1 — Workspace is the renamed `project_types`.** Table `project_types` → `workspaces`,
column `projects.project_type` → `projects.workspace_id`, and `project_types.github_group`
is dropped (FR1.1, FR2.1). Directory names under the managed home keep using the workspace
id exactly as they use the project-type id today (FR1.2), so `ensureManagedHome` and
Syncthing configuration are untouched in behaviour.

**D2 — Migration is a single marker-gated function** `ensureWorkspaceSecretsMigration()`
in a new `src/secrets-migration.ts`, following `test/project-type-migration.test.ts`'s
proven pattern and the per-module marker-table convention (C3). Marker table:
`secrets_migrations(source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)`, marker key
`github-groups-v1`. Idempotent (NFR5): a second run is a no-op.

**D3 — Scope tier values.** `secret_assignments.scope_type` becomes one of
`workspace` | `project` | `conversation`. Existing rows with `project_type` are rewritten
to `workspace` in the same migration. `conversation` scope ids are the string
`` `${engine}:${sessionId}` `` so one column carries the `(engine, sessionId)` pair that
`conversation-ownership.ts` already treats as conversation identity (FR3.2, A3).

**D4 — Resolution replaces both old shapes.** `resolved(project, conversation?)` merges
workspace → project → conversation accounts. The merge stays per-account-id for dedup, and
`genericSecretEnvironment` applies per-variable-name override in that order, most specific
last (FR4.1, FR4.2). The GitHub four-tier chain is deleted outright (FR2.4).

**D5 — GitHub is a provider, not a code path.** `githubEnvironment` moves into
`secrets.ts` as a pure function of the resolved variable map: if a resolved variable named
`GH_TOKEN` exists, export `GH_TOKEN`, `GITHUB_TOKEN` and `PI_GITHUB_TOKEN` from that one
value, generate/refresh the askpass helper, and set `GIT_ASKPASS` + `GIT_TERMINAL_PROMPT=0`
(FR5.1–FR5.5). The askpass script and `ensureLocalFiles()` move from `github-auth.ts` into
`secrets.ts` unchanged in content. A `github`-provider account's variable set is fixed to
`GH_TOKEN` — the variable-name input is not offered for that provider (FR5.1).

**D6 — Conversation attachment before a session id exists.** The new-conversation request
carries `secretAccountIds: string[]`. The server composes the spawn environment from
workspace + project + those ids directly, and once the engine reports the session id, writes
the `conversation` attachment rows for `` `${engine}:${sessionId}` `` (FR9.4). This is the
only way to satisfy FR9.4 under C1 (single-shot injection), because the id does not exist at
spawn time. Changing attachments on a live conversation writes rows but does not restart the
process (FR9.5).

**D7 — Replication is a per-account column** `replicate INTEGER NOT NULL DEFAULT 0` on
`secret_accounts` (FR7.1, FR7.5). Replicating accounts reuse the existing credential
pipeline mechanics (events / deliveries / inbox tables), renamed from `github_credential_*`
to `secret_credential_*` and carrying an encrypted account payload rather than a group.
A received account is re-encrypted with the receiving node's own key (FR7.3); the receiver
may overwrite it locally and the local version then wins (FR7.4). Node-local accounts are
never enqueued (FR7.2, NFR3).

**D8 — Same-scope variable collision (OQ1) resolves as: reject at assignment time.**
`assertNoCollision` already rejects two accounts in the same scope declaring the same
variable name; that behaviour is kept and extended to the conversation tier, so the
ambiguity cannot be created in the first place. This closes OQ1 without a new rule.

**D9 — Removal is complete, not deprecated (FR2.1, OQ3).** `src/github-auth.ts` is deleted
along with all nine `github_*` tables, after the migration has read them. The peer route
`POST /api/cluster/github/events` is kept for one release as a **rejecting stub** that
returns 410 so a peer on an older build gets a clean refusal rather than a half-applied
write (NFR7).

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run",
  "scope": "express",
  "test_strategy": "minimal",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    }
  ],
  "obligations": {
    "strategy": "minimal",
    "strategy_volume": [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect."
    ],
    "scope_floor": [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "test-after",
    "runner_step": "Verify the existing test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Verify the existing test runner/configuration and record the exact unit-scoped command.",
      "Data model / database behavior - implement.",
      "Data model / database behavior - write and run its tests after implementation.",
      "Repository / data access - implement.",
      "Repository / data access - write and run its tests after implementation.",
      "Business logic - implement.",
      "Business logic - write and run its tests after implementation.",
      "API / endpoint - implement.",
      "API / endpoint - write and run its tests after implementation.",
      "Frontend behavior - implement.",
      "Frontend behavior - write and run its tests after implementation.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:f1c5ff913eeb340ca4cc907371fe41463fa020ccc73eba0af5543c93b435fb3f",
  "contract_sha256": "sha256:d04120c3c4a1e751020f82be7855855776bc494591d88beb206ed64156683fe5"
}
```

## Implementation Steps

Ordering follows the contract's `test-after` profile: implement each applicable layer, then
write and run that layer's tests, with runner readiness verified before the first test step.

### Step 1 — Verify the test runner and record the unit-scoped command
- [x] Confirm `npm test` = `node --import tsx --test --test-concurrency=4 test/*.test.ts` still runs green (baseline, brownfield safeguard).
- [x] Record the exact scoped command in `unit-test-instructions.md`; no bare `npm test`.
- [x] Capture the baseline: total tests, passing, failing.
- Traces: NFR6

### Step 2 — Data model: workspaces (implement)
- [x] In `src/store.ts`: rename table `project_types` → `workspaces`, drop column `github_group`, rename `projects.project_type` → `projects.workspace_id`, following the rename-and-rebuild idiom already used by `ensureConversationOwnershipSchema`.
- [x] Update `seedProjectTypes` → `seedWorkspaces` (still seeds `personal`/`Personal` and `work`/`Work` only into an empty table), `projectTypeIdFromLabel` → `workspaceIdFromLabel`, `reservedProjectTypeIds` → `reservedWorkspaceIds`, `listProjectTypes`/`saveProjectType`/`deleteProjectType` → `listWorkspaces`/`saveWorkspace`/`deleteWorkspace`, `updateProjectTypeAndPath` → `updateProjectWorkspaceAndPath`.
- [x] Keep the managed-home directory name derived from the workspace id, unchanged on disk.
- Traces: FR1.1, FR1.2, FR1.3, FR1.4, FR1.5

### Step 3 — Data model: secret accounts and three-scope assignments (implement)
- [x] In `src/secrets.ts`: add `replicate INTEGER NOT NULL DEFAULT 0` to `secret_accounts` (lazy `ALTER TABLE` add, matching the existing lazy-column idiom).
- [x] Widen `SecretScopeType` to `"workspace" | "project" | "conversation"`; update `assertScope` and `canonicalScopeId` — `workspace` ids must exist in `workspaces`, `project` ids resolve through `resolveProjectId`, `conversation` ids match `` `${engine}:${sessionId}` `` with engine in `pi` | `claude`.
- [x] Add index `secret_assignments_account_id ON secret_assignments(account_id)` so account deletion and re-keying are not full scans.
- Traces: FR3.1, FR3.2, FR3.4, FR3.5, FR7.1, FR7.5

### Step 4 — Data model tests (write and run)
- [x] `test/workspace-schema.test.ts`: rebuild the exact pre-change `project_types` / `projects` DDL, insert legacy rows, run the upgrade, assert ids, labels and project membership survive (FR1.3) and no directory move is attempted (FR1.2).
- [x] Assert `secret_assignments` accepts the three new scope types and rejects an unknown one (FR3.1).
- Run: `node --import tsx --test test/workspace-schema.test.ts`
- Traces: FR1.2, FR1.3, FR3.1

### Step 5 — Migration from GitHub groups (implement)
- [x] New `src/secrets-migration.ts` exporting `ensureWorkspaceSecretsMigration(db)`, marker-gated on `secrets_migrations['github-groups-v1']`.
- [x] Read `github_accounts`, `github_project_auth`, and `project_types.github_group` BEFORE any of those tables are dropped.
- [x] For each group: create a `github`-provider secret account labelled with the group's label, holding `GH_TOKEN` = that group's token (FR6.2).
- [x] Group referenced by a project type → attachment on the corresponding workspace (FR6.3).
- [x] `github_project_auth.account` → attachment on that project (FR6.4).
- [x] `github_project_auth.token` (per-project override) → its own project-scoped account, attached to that project (FR6.5).
- [x] Default group's account → attached to every workspace that resolves no token of its own after the above (FR6.6).
- [x] Leave each node's own local rows to its own run; no cross-node coordination (FR6.7).
- Traces: FR6.1–FR6.7

### Step 6 — Migration tests (write and run)
- [x] `test/secrets-migration.test.ts`, following `test/project-type-migration.test.ts`: rebuild the exact nine-table `github_*` schema, seed a default group, a second group on a project type, a project-assigned group, and a per-project token override; run the migration; assert the resolved token per project is byte-identical before and after (FR6.8).
- [x] Run the migration twice and assert the second run changes nothing (NFR5).
- Run: `node --import tsx --test test/secrets-migration.test.ts`
- Traces: FR6.8, NFR5

### Step 7 — Business logic: three-tier resolution and the environment contract (implement)
- [x] Rewrite `resolved()` to merge workspace → project → conversation (FR4.1–FR4.3).
- [x] Rewrite `genericSecretEnvironment` / `agentEnvironment(projectId, conversation?)` so the most specific scope wins per variable name, and drop the `github-auth.ts` import — `secrets.ts` gains zero provider special-casing (FR2.3).
- [x] Move `ensureLocalFiles()` and the askpass script from `github-auth.ts` into `secrets.ts`; derive `GH_TOKEN` / `GITHUB_TOKEN` / `PI_GITHUB_TOKEN` / `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT` from the single resolved `GH_TOKEN` (FR5.2–FR5.4); emit none of them when no token resolves (FR5.5).
- [x] Keep `assertNoCollision` and extend it to the conversation tier (D8, FR4.4).
- [x] Enforce inertness: an account with no attachment contributes nothing (FR3.3).
- Traces: FR2.3, FR2.4, FR3.3, FR4.1–FR4.4, FR5.1–FR5.5

### Step 8 — Business logic: lifecycle cleanup and re-keying (implement)
- [x] Add `rekeySecretAssignments(db, aliasId, projectId)` and call it from `rekeyProjectState` in `src/store.ts:249` (FR8.1).
- [x] Delete project-scoped attachments in `removeProject` (FR8.2).
- [x] Delete workspace-scoped attachments in `deleteWorkspace` (FR8.3).
- [x] Delete all attachments in `deleteSecretAccount` (FR8.4).
- [x] Ignore dangling attachments during resolution instead of failing (FR8.5).
- Traces: FR8.1–FR8.5

### Step 9 — Business logic: per-account replication (implement)
- [x] Rename `github_credential_events` / `_deliveries` / `_inbox` to `secret_credential_*` and carry an encrypted secret-account payload; reuse the existing enqueue / deliver / receive / retry mechanics verbatim, including `Math.min(300, 2 ** Math.min(attempts, 8))`.
- [x] Only accounts with `replicate = 1` are ever enqueued (FR7.2, NFR3).
- [x] Re-encrypt a received account with the receiving node's own key (FR7.3); a local overwrite wins afterwards (FR7.4).
- Traces: FR7.1–FR7.5, NFR1, NFR3

### Step 10 — Business logic tests (write and run)
- [x] Extend `test/secrets.test.ts` (same temp-dir + cache-busting-import harness): conversation beats project beats workspace per variable name; a variable defined at one scope only still resolves; an unattached account contributes nothing; a dangling attachment is ignored; `GH_TOKEN` produces all four GitHub variables plus the askpass path; no token produces none of them; a node-local account enqueues nothing; deleting a project / workspace / account removes its attachments; an alias merge re-keys them.
- Run: `node --import tsx --test test/secrets.test.ts test/secrets-migration.test.ts test/workspace-schema.test.ts`
- Traces: FR3.3, FR4.1–FR4.3, FR5.2, FR5.5, FR7.2, FR8.1–FR8.5, NFR3, NFR4

### Step 11 — API layer (implement)
- [x] Delete routes `GET/POST/PUT/DELETE /api/github-auth*`, `POST /api/github-auth/sync`, and `GET/PUT /api/projects/:projectId/github-auth` (FR2.1).
- [x] Rename `/api/project-types` → `/api/workspaces` (GET, PUT, DELETE) and drop `githubGroup` from its payload (FR1.1).
- [x] Widen `secretScopeParamsSchema` to the three scope types; add `replicate` to `secretAccountSchema` (FR3.1, FR7.1).
- [x] Add the secret-account replication sync endpoint replacing `POST /api/github-auth/sync` (FR7.1).
- [x] Replace `POST /api/cluster/github/events` with a 410-returning stub, and add the peer inbox route for secret-credential events (D9, NFR7).
- [x] Accept `secretAccountIds` on the new-conversation request and persist conversation attachments once the session id is known (FR9.4, D6).
- [x] Delete `src/github-auth.ts` and its nine tables after the migration has run (FR2.1).
- [x] Verify every response still carries metadata only — no secret value (FR9.7, NFR2).
- Traces: FR1.1, FR2.1, FR3.1, FR7.1, FR9.4, FR9.7, NFR2, NFR7

### Step 12 — API tests (write and run)
- [x] Assert `GET /api/secrets` and the scope endpoints return metadata only, never a value (NFR2, FR9.7).
- [x] Assert the three scope types round-trip through `GET/PUT /api/secrets/scopes/:scopeType/:scopeId` (FR3.1).
- Run: `node --import tsx --test test/secrets.test.ts`
- Traces: FR3.1, FR9.7, NFR2

### Step 13 — Frontend (implement)
- [x] `public/index.html`: remove `githubGroupDialog` and `githubSyncDialog`; rename the Projects settings section to Workspaces; add attachment pickers for workspace, project and conversation; add the secret-account replication toggle (FR2.2, FR9.1–FR9.3, FR9.6, FR7.1).
- [x] `public/app.js`: remove `renderProjectTypes`'s group picker and the per-project "GitHub access" override; rename project-type wording and calls to `/api/workspaces`; add the account picker used at all three levels; add `secretAccountIds` to the new-conversation dialog (FR9.4).
- [x] Give every new interactive element a `data-testid` following the existing pattern (`workspace-secrets-button`, `project-secrets-button`, `conversation-secrets-button`, `secret-account-replicate-toggle`).
- Traces: FR1.1, FR2.2, FR7.1, FR9.1–FR9.6

### Step 14 — Frontend tests (write and run)
- [x] Extend `test/secrets-ui.test.ts` in the existing string-assertion style: the two GitHub dialogs are gone, the workspace wording is present, the three attachment `data-testid`s exist, the replicate toggle exists, and the new-conversation dialog references `secretAccountIds`.
- Run: `node --import tsx --test test/secrets-ui.test.ts`
- Traces: FR2.2, FR9.1–FR9.4, FR9.6

### Step 15 — Full suite and static checks
- [x] Run the whole suite: `npm test`. Compare against the Step 1 baseline; zero new failures (NFR6).
- [x] Run the type-checker and linter the repo already configures; no new errors.
- Traces: NFR6

### Step 16 — Documentation and traceability
- [x] Update `README.md` and `AGENTS.md` where they describe GitHub credential groups or project types.
- [x] Write `code-summary.md`, `source-manifest.json` and `traceability.json`.
- Traces: FR1.1, FR2.1

## Requirement Coverage Map

| Requirement group | Steps |
|---|---|
| FR1 Workspaces replace project types | 2, 4, 11, 13, 16 |
| FR2 GitHub groups removed | 7, 11, 13, 16 |
| FR3 Three attachment scopes | 3, 4, 7, 11, 12 |
| FR4 Most-specific-wins resolution | 7, 10 |
| FR5 git push environment contract | 7, 10 |
| FR6 Migration | 5, 6 |
| FR7 Per-account replication | 3, 9, 10, 11, 13 |
| FR8 Attachment lifecycle cleanup | 8, 10 |
| FR9 User interface | 11, 13, 14 |
| NFR1–NFR7 | 1, 6, 9, 10, 12, 15 |

## Risks

- **Step 2 is the widest blast radius**: `project_type` appears across `store.ts`, `server.ts`, `secrets.ts`, `github-auth.ts`, `managed-home.ts` and `public/app.js`. The rename must be complete in one pass or the build breaks in the middle.
- **Step 11 deletes a module other modules import.** `secrets.ts:6` imports `github-auth.ts`; that edge must be cut in Step 7 before the delete in Step 11.
- **Step 5 must run before Step 11's table drops**, or the credentials are gone before they are converted.
