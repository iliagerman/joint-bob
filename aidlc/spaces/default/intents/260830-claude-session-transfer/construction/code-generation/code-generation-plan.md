# Code Generation Plan — Claude Conversation Ownership Takeover

**Intent:** 260830-claude-session-transfer · **Scope:** bugfix · **Depth:** Minimal · **Test Strategy:** Minimal
**Iteration:** single, zero-Unit (this scope skips Units Generation, so there is no Unit segment)
**Upstream:** `aidlc/spaces/default/intents/260830-claude-session-transfer/inception/requirements-analysis/requirements.md`

## Line-number refresh

The requirements document's citations drifted against the working tree (advisory review finding 1, approved as-is). Every location below was re-verified by grep against the live tree immediately before this plan was written, and these are the numbers to use:

| Concern | Requirements cited | Verified now |
|---|---|---|
| Lock-banner `takeable` gate | `public/app.js:2795` | **`public/app.js:2906`** |
| Lock-banner "only Pi…" message | `public/app.js:2798-2800` | **`public/app.js:2911`** |
| Session-panel take-ownership gate | `public/app.js:4438` | **`public/app.js:4577`** |
| Row-menu transfer gate (left in place) | `public/app.js:2172-2174` | **`public/app.js:2235`** |
| Toolbar transfer gate (left in place) | `public/app.js:2844-2846`/`:4104` | **`public/app.js:2992`, `:4243`** |
| Takeover guard | `src/server.ts:2469` | **`src/server.ts:2469`** (function), throw at **`:2474`** |
| `runClaudeTurn` | `src/server.ts:3921` | **`src/server.ts:3933`** |
| Pi-only conflict recovery (out of scope) | `src/server.ts:2700` | **`src/server.ts:2707`** |

Two corrections to the requirements' factual claims, also from the advisory review: the suite is **120** test files (not 115), and `public/sw.js` currently pins **`joint-bob-v55`** (not `v52`), asserted by roughly seven tests.

One fact the requirements did not capture: **`claudeProjectsRoot()` is not exported** (`src/claude-service.ts:64`). FR4.2 requires `src/watcher.ts` to use it, so it must be exported first.

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run",
  "scope": "bugfix",
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
      "Include a targeted regression for the bug or vulnerability.",
      "Keep the existing test suite green."
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
  "input_sha256": "sha256:ee85052f599aa0596a4d7afe86f4d1d36a0005ee7d07141ef240fc95ebca5f75",
  "contract_sha256": "sha256:e6f35030de628cbc331ec78aaf90bce7956a721aed1eb48abeaf04d3cc1d5342"
}
```

## Test baseline (brownfield safeguard, captured before any change)

`npm test` on the unmodified working tree, 2026-08-30:

| Metric | Value |
|---|---|
| Tests | 343 |
| Pass | 342 |
| **Fail** | **1** |
| Duration | ~60s |

The single pre-existing failure is `test/session-watcher.test.ts` — *"shared flat Pi session watcher does not keep the process alive"*, `error: 'child process did not exit after constructing SessionWatcher'` at `test/session-watcher.test.ts:54`.

**This matters for Step 5.** That failure is in the watcher, and Step 5 modifies `src/watcher.ts:33`. It is failing *before* any change here, and `test/session-watcher.test.ts` already carries uncommitted edits in the working tree. Post-change, the pass criterion is therefore **342 pass / 1 fail or better, with no new failures** — not a green suite. If that test still fails afterwards it is not evidence this change broke it; if it starts passing, that is incidental. Any *second* failure is a regression.

## Implementation Steps

Ordering follows the contract's `test-after` profile: implement each applicable testable layer, then write and run that layer's tests. The Data model and Repository layers are genuinely inapplicable — the ownership table's `CHECK(engine IN ('pi','claude'))` constraint already admits Claude and no schema or data-access change is required.

- [x] **Step 1 — Runner readiness.** Verify the existing test runner executes the unit-scoped command recorded in `unit-test-instructions.md`. Record the pre-change baseline (pass/fail counts) from the full suite. No production change. *(contract `runner_step`; NFR1)*

- [x] **Step 2 — Business logic: export the settings-aware root.** Export `claudeProjectsRoot` from `src/claude-service.ts:64`. *(FR4.1)*

- [x] **Step 3 — Business logic: locate a Claude transcript by session id.** Add a helper that, given a projects root and a session id, finds `<sessionId>.jsonl` anywhere under that root — including under a directory name encoded from another node's project path. Return `null` when absent. *(FR3.3, FR3.5)*

- [x] **Step 4 — Business logic: ensure the transcript sits at the local path.** Add a helper that computes the locally-correct path with the existing `claudeSessionFilePath(cwd, sessionId)` (`src/claude-service.ts:70`, which already composes `claudeProjectDir(cwd, claudeProjectsRoot())`), returns immediately when the file is already there, otherwise copies the located transcript to it and returns the local path. The source file is never deleted, moved, renamed, or truncated; an existing destination is never overwritten. Throw a named error when nothing is found. *(FR3.1, FR3.2, FR3.3, FR3.4, FR3.5, NFR3, NFR5)*

- [x] **Step 5 — Business logic: one projects root everywhere.** Pass the exported `claudeProjectsRoot()` into `claudeProjectDirs` at `src/watcher.ts:33`, which today omits the argument and silently falls back to `~/.claude/projects`. *(FR4.1, FR4.2)*

- [x] **Step 6 — Business logic tests.** Write and run tests for Steps 2-5: local path already correct is a no-op; transcript under a foreign directory name is copied to the local name with the original left in place; nothing found raises the named error; the watcher's directory set honours a non-default `claude.configPath`. Update `test/session-paths.test.ts`, which currently pins the sender-path-trusting behaviour. *(NFR1, NFR3)*

- [x] **Step 7 — API layer: engine-aware takeover.** In `takeLocalSessionOwnership` (`src/server.ts:2469`): delete the `claude:` refusal at `:2474`, derive the engine from the session path prefix exactly as `transferLocalSession` (`:2445`) does, and pass that engine to `conversationIsActive(project.id, <engine>, …)` and `takeConversationOwnership(<engine>, …)` in place of the two `"pi"` literals. Leave every other precondition — the peer probe, the active-turn check, the epoch bump, the peer fan-out — untouched. *(FR1.1, FR1.2, FR1.3, FR1.4, NFR4)*

- [x] **Step 8 — API layer: ensure the transcript before resuming.** Call the Step 4 helper in `runClaudeTurn` (`src/server.ts:3933`) before the `claude` process is spawned, using `connection.cwd` and `connection.claude.sessionId`. A failure surfaces as a turn error naming the session and the directory searched; it must not silently start a new conversation. *(FR3.2, FR3.5)*

- [x] **Step 9 — API layer tests.** Write and run the targeted regression: a two-node mesh test in which a Claude conversation is created on node A whose project path differs from node B's, taken over from node B, then resumed on B — asserting the conversation appears in B's session list and that the turn resumes the existing transcript rather than starting a new one. Cover the dropped-acknowledgement path (`JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE`) and a service restart, mirroring `test/conversation-ownership-mesh-api.test.ts`. *(NFR2 — the `bugfix` scope floor's targeted regression, at the narrowest level that reproduces the defect)*

- [x] **Step 10 — Frontend: lift the two take-ownership gates.** At `public/app.js:2906` drop `state.engine === "pi"` from `takeable`, keeping `!state.activeTaskId`. At `:2911` the Claude branch of the lock message disappears with it, so a Claude conversation gets the same "…until you take ownership" wording as Pi. At `:4577` make `sessionTakeOwnershipButton.hidden` depend on `state.activeTaskId` alone. *(FR2.1, FR2.2, FR2.3)*

- [x] **Step 11 — Frontend: leave the two transfer gates alone.** `public/app.js:2235`, `:2992` and `:4243` are not touched. Claude gains no push-transfer button. This step is a deliberate no-op, listed so its omission is visible rather than accidental. *(FR2.4)*

- [x] **Step 12 — Frontend tests.** Write and run DOM-level tests: with a Claude conversation owned elsewhere the lock banner shows a Take ownership button and the Pi wording; the session-panel button is visible for Claude; and both transfer controls remain disabled for Claude. Check `test/conversation-lock-ui.test.ts` and its neighbours for existing assertions of the Claude-blocked state and update them. *(NFR1, NFR2)*

- [x] **Step 13 — Build configuration.** `public/app.js` is part of the PWA shell, so bump `CACHE_NAME` in `public/sw.js` from `joint-bob-v55` to `joint-bob-v56` per `AGENTS.md`, and update every test asserting the old value (roughly seven files). *(C4)*

- [x] **Step 14 — Documentation and traceability.** Add inline comments only where the reason is not evident from the code — chiefly why the local path is re-derived rather than trusted. Write `code-summary.md`, `source-manifest.json` and `traceability.json`. Run `npm run typecheck`, then `npm test`, and compare against the Step 1 baseline. *(NFR1, NFR6)*

## Traceability — plan step to requirement

| Requirement | Steps |
|---|---|
| FR1.1, FR1.2, FR1.3, FR1.4 | 7, 9 |
| FR2.1, FR2.2, FR2.3 | 10, 12 |
| FR2.4 | 11, 12 |
| FR3.1, FR3.2, FR3.4 | 4, 8, 6, 9 |
| FR3.3, FR3.5 | 3, 4, 8, 6 |
| FR4.1 | 2, 5, 6 |
| FR4.2 | 5, 6 |
| NFR1 | 1, 6, 12, 14 |
| NFR2 | 9, 12 |
| NFR3 | 4, 6 |
| NFR4 | 7 |
| NFR5 | 4 |
| NFR6 | 14 |

## Constraints carried into execution

- Application code goes to the workspace root. Nothing under the record directory.
- Modify files in place. Never create `*_modified` duplicates.
- The repository root holds gitignored **stale duplicates** — `app.js`, `index.html`, `server.ts`, `styles.css`, `sw.js`. Every edit targets `src/` or `public/`. Editing a root-level copy is the single most likely mistake in this repository.
- `src/server.ts` is 4,712 lines. Changes to it stay surgical; the file is not restructured.
- No new `@ts-ignore`, `@ts-expect-error`, or `as unknown as`. `tsc --noEmit` must stay clean.
- Interactive UI elements carry `data-testid`. The two take-ownership buttons already have theirs (`conversation-lock-take-button`, `session-take-ownership-button`); no new interactive elements are added.
- Open questions inherited from requirements, to be decided during execution and recorded in `code-summary.md`: **OQ1** — the ordering rule when `claudeProjectDirs` returns several candidates (Step 4 sidesteps it by deriving directly from `connection.cwd` rather than picking from the list; confirm that holds); **OQ2** — whether the Step 4 copy should be atomic (temp name then `rename`) rather than a plain copy.
