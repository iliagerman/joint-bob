# Requirements — Claude Conversation Ownership Takeover

**Intent:** 260830-claude-session-transfer
**Scope:** bugfix · **Depth:** Minimal · **Test Strategy:** Minimal
**Stage:** requirements-analysis (inception)

## Sources

Upstream artifacts declared by this stage's `consumes` contract:

- `aidlc/spaces/default/codekb/pi-mobile-web/business-overview.md` — the product's premise that a conversation is not pinned to a machine, and the statement that half the supported engines currently violate it.
- `aidlc/spaces/default/codekb/pi-mobile-web/architecture.md` — the ownership-transfer and takeover interaction diagrams, and the located analysis of why the Claude path breaks.
- `aidlc/spaces/default/codekb/pi-mobile-web/code-structure.md` — the intent-area code map giving exact file and line locations for every gate and helper named below.
- `intent-statement` and `scope-document` — **absent by scope design**. The `bugfix` scope skips the entire Ideation phase (stages 1.1-1.7), so no intent statement or scope document exists for this intent. The verbatim initial description in `aidlc-state.md` → `## Project Information` → `**Project**` serves as the intent record.
- `team-practices` — **absent by scope design**. The `bugfix` scope skips `practices-discovery` (2.2), so `aidlc/spaces/default/memory/team.md` is unpopulated. The applicable practice layers are `org.md` (test-after methodology; `bugfix` adds a targeted regression for the specific bug and requires the existing suite to remain green) and `project.md` (three recorded corrections, one of which — never delete recovery data when resolving synchronized transcripts — directly shapes NFR3).

Human answers are recorded in `requirements-analysis-questions.md` in this directory (five original questions, three follow-ups, and a corrected consolidated summary confirmation).

## Intent Analysis

**What the user is trying to achieve.** Joint Bob's premise is that a coding-agent conversation belongs to the user, not to the machine that started it. That premise holds for Pi conversations and fails for Claude ones. The user wants to sit at any node, open a Claude conversation another node currently owns, and simply continue it.

**How the user wants to get there — and what changed during the interview.** The initial description framed this as enabling *transfer*: a push handover initiated from the owning node. The interview established that this framing is wrong for this deployment. Syncthing already replicates `~/.claude` wholesale to every node (`CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude"`, `src/syncthing.ts:41`), so no file needs sending. The user's actual workflow is: switch the **Runs on** selector to the target node, and claim the conversation there. That is *take ownership*, a pull operation that works even when the previous owner is asleep or unreachable.

The interview also confirmed the flow is almost entirely built already. Switching `Runs on` on a plain conversation (`public/app.js:4222`) changes which node the browser addresses; the composer is then disabled (`setComposerEnabled`, `public/app.js:2776`) and a lock banner appears offering a **Take ownership** button. For Pi that button works. For Claude it is hidden and the banner reads *"Open it there to continue — only Pi conversations can be taken over."*

**What actually blocks it.** Three things, and only three: two UI gates that hide the Take ownership control for Claude, one server guard that refuses Claude, and one genuine correctness defect in where a Claude transcript is expected to live on the claiming node.

**Why the path defect exists.** `claudeProjectDir` (`src/session-paths.ts:43`) derives a transcript's directory name by mangling the project's absolute path (`cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-")`). Each node runs its own managed home (`settings.projects.homePath`, `src/managed-home.ts`), under which a project sits at `<homePath>/<type folder>/<name>`. The relative portion is identical everywhere; the home prefix is not. So the same project yields a different encoded directory name on every node, and Syncthing — which copies paths verbatim and never renames — delivers the transcript under the *originating* node's name.

## Functional Requirements

### FR1 — Claude conversations can be claimed from any node

**FR1.1** `takeLocalSessionOwnership` (`src/server.ts:2469`) shall accept session paths with the `claude:` prefix. It shall no longer throw `TaskWorktreeError("Only Pi conversations can be taken over")` for such paths.

**FR1.2** `takeLocalSessionOwnership` shall derive the engine from the session path prefix — the same mechanism `transferLocalSession` (`src/server.ts:2445`) already uses — and pass that derived engine to `conversationIsActive(project.id, <engine>, …)` and `takeConversationOwnership(<engine>, …)` in place of the two hardcoded `"pi"` literals.

**FR1.3** The existing takeover preconditions shall be preserved unchanged for Claude: the ownership probe against the recorded owner with its 3-second timeout, the local-activity check, and the epoch bump. `conversationIsActive` and `conversationSessionIsOpen` (`src/server.ts:2428`, `:2434`) already handle `engine === "claude"` correctly via `activeClaudeConnections` and require no change.

**FR1.4** A takeover that succeeds shall record a replication event and emit `sessionsChanged` over `/ws` to both nodes, identically to the Pi path.

### FR2 — The Take ownership control is available for Claude

**FR2.1** `renderConversationLock` (`public/app.js:2795`) shall compute `takeable` without requiring `state.engine === "pi"`. The `!state.activeTaskId` condition is retained.

**FR2.2** When a Claude conversation is owned elsewhere and is takeable, the lock banner (`public/app.js:2798-2800`) shall show the same "…until you take ownership" wording used for Pi, and shall show the `conversationLockTakeButton` (`public/index.html:201`). The message *"Open it there to continue — only Pi conversations can be taken over"* shall no longer appear for Claude conversations.

**FR2.3** The session-panel `sessionTakeOwnershipButton` (`public/index.html:518`, gated at `public/app.js:4438`) shall be visible for Claude conversations under the same conditions as for Pi — that is, `hidden` shall depend on `state.activeTaskId` alone.

**FR2.4** The two push-transfer gates shall remain in place for Claude and are explicitly **not** lifted by this change: the conversation row menu entry (`public/app.js:2172-2174`) and the chat-toolbar transfer control (`public/app.js:2844-2846`, `:2863-2864`, `:4104`). Claude gains no push-transfer button.

### FR3 — A claimed Claude transcript is findable and resumable on the claiming node

**FR3.1** The claiming node shall determine the local directory for a Claude transcript from **its own** project record — the first entry of `claudeProjectDirs(project, claudeProjectsRoot())` (`src/session-paths.ts:49`), which encodes the project's local absolute path. The sender-encoded directory name carried in the session path shall not be trusted for this purpose.

**FR3.2** Immediately before a Claude turn is run — that is, before `runClaudeTurn` (`src/server.ts:3921`) spawns `claude` with `--resume <sessionId>` and `cwd: connection.cwd` — the node shall ensure the transcript file exists at the local directory from FR3.1.

**FR3.3** When the transcript is absent from that local directory, the node shall **copy** it there from the path where it is available. The source file shall be left in place and shall not be deleted, moved, or modified.

**FR3.4** When the transcript is already present at the local directory, FR3.2 shall be a no-op — no copy, no overwrite, no modification of the existing file.

**FR3.5** When no readable transcript can be located for the session, the turn shall fail with an error naming the session and the directory that was searched. It shall not silently start a new conversation.

### FR4 — One Claude projects root, honoured everywhere

**FR4.1** Every call site of `claudeProjectDirs` shall pass an explicit projects root resolved by the settings-aware `claudeProjectsRoot()` (`src/claude-service.ts`), which honours `settings.claude.sessionPath` and `settings.claude.configPath`.

**FR4.2** `sessionWatchDirs` (`src/watcher.ts:33`), which today calls `claudeProjectDirs(project)` with no root and therefore falls back to the `~/.claude/projects` default, shall pass the settings-aware root. This repairs an existing defect in which a node with a non-default `claude.configPath` watches directories that `listClaudeSessions` does not read.

## Non-Functional Requirements

**NFR1 — No regression in the existing suite.** The full suite (`npm test`, 115 files) shall pass after the change. `test/session-paths.test.ts` currently asserts that `claude:/Users/a/.claude/projects/project/session.jsonl` maps to `claude:/home/b/.claude/projects/project/session.jsonl` — it pins the defective path-trusting behaviour and shall be updated to assert the corrected behaviour rather than deleted.

**NFR2 — Mesh-level regression coverage.** A mesh test mirroring the structure of `test/conversation-ownership-mesh-api.test.ts` shall cover Claude takeover across two real nodes whose project checkouts sit at different absolute paths, including the dropped-acknowledgement case (`JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE`) and the service-restart case. Pass criterion: after takeover on the second node, the conversation appears in that node's `listClaudeSessions` output and a subsequent turn resumes the existing transcript rather than starting a new one.

**NFR3 — No destruction of transcript data.** No code path introduced by this change shall delete, truncate, overwrite, or rename an existing transcript file. This follows the recorded project correction of 2026-08-28: obsolete copies are relocated to temporary storage, never deleted, and divergent event streams are never merged.

**NFR4 — Single-writer safety preserved.** Takeover shall remain fenced by the existing epoch mechanism in `src/conversation-ownership.ts`. No change shall create a window in which two nodes may append to the same Claude transcript.

**NFR5 — Path containment preserved.** Every path computed by this change shall remain inside the node's own Claude projects root. The existing guards (`resolveClaudeSessionPath`, `requirePathInsideHome`) shall continue to apply to the copy destination.

**NFR6 — Type safety.** `npm run typecheck` (`tsc --noEmit`, `strict: true`) shall pass with no new `@ts-ignore`, `@ts-expect-error`, or `as unknown as` assertions introduced.

## Constraints

- **C1** — The repository has no linter and no PR/push CI. `.github/workflows/release.yml` runs only on `v*` tags, so `typecheck`, `test`, and `build` must be run locally before delivery, as `AGENTS.md` requires.
- **C2** — Every file to be edited lives under `src/` and `public/`. The repository root carries gitignored stale duplicates (`app.js`, `index.html`, `server.ts`, `styles.css`, `sw.js`) that a naive grep or file-open will match. They must not be edited.
- **C3** — `src/server.ts` is 4,712 lines. Changes to it must be surgical; the file is not to be restructured as part of this bugfix.
- **C4** — Any change to the PWA shell requires bumping `CACHE_NAME` in `public/sw.js` per `AGENTS.md`. Two existing UI tests pin the current value `joint-bob-v52` and must be updated together with any bump.
- **C5** — The single datastore is `node:sqlite` against `~/.joint-bob/node.db`, with no migration framework. The ownership table's `CHECK(engine IN ('pi', 'claude'))` constraint already admits Claude, so no schema change is required.
- **C6** — Trunk-based development: a short-lived branch off `main`, squash-merged back.

## Assumptions

- **A1** — The project record on the claiming node carries that node's own absolute project path in `project.path`, so `claudeProjectDirs(project, …)[0]` yields the correct local directory. Rationale: the managed home model (`src/managed-home.ts`) computes `<homePath>/<type folder>/<name>` per node, and `sessionCwds` (`src/session-paths.ts:33`) resolves `project.path` first. *Confirmed by the human: "we have a working folder home folder on each node, the paths should be relative to it."*
- **A2** — Syncthing has delivered the transcript to the claiming node before a turn is attempted. Rationale: `~/.claude` is replicated wholesale, and `public/app.js:4377-4380` already counts down a grace period for exactly this reason. FR3.5 covers the case where it has not.
- **A3** — A copied transcript under a second directory name will not produce a duplicate entry in any node's session list. Rationale: `listClaudeSessions` (`src/claude-service.ts:177-187`) filters on the transcript's own recorded `cwd` against the local `sessionCwds`, so only directories the local node derives are read. **Unvalidated** — must be verified by the NFR2 mesh test.
- **A4** — The `!state.activeTaskId` condition on both Take ownership controls is orthogonal to engine and is retained unchanged for Claude.

## Out of Scope

- **Push-style transfer for Claude.** The two transfer gates stay in place (FR2.4). The server-side transfer path (`transferLocalSession`, `POST /api/cluster/sessions/receive`) is already engine-agnostic and is left untouched.
- **Removing push transfer for Pi.** The human's position is that push transfer is redundant for both engines now that Syncthing replicates transcripts. Deleting it — the button, the two endpoints, and its Pi mesh tests — is recorded as a **follow-up piece of work** with its own review, deliberately excluded from this bugfix.
- **Pi-only conflict recovery.** `POST /api/projects/:projectId/sessions/recover` (`src/server.ts:2700`) throws *"Only Pi transcripts support conflict recovery"*. Claude sync-conflict recovery is a separate limitation and is not addressed here.
- **The wider technical-debt register** in `code-quality-assessment.md` — the size of `src/server.ts` and `public/app.js`, the absent linter and PR CI, the 99 SQLite boundary casts, the incomplete `pi-mobile-web` rebrand, the two overlapping task-handoff mechanisms, and the hardcoded `localNodeId: "local"` in `recoveryDiagnostic`. Only debt item 9 (the Claude projects root mismatch) is in scope, via FR4.

## Open Questions

- **OQ1** — When a project is registered at several locations on the claiming node, `claudeProjectDirs` returns several candidates and FR3.1 selects the first. Whether `sessionCwds` ordering is stable and always places the node's primary path first is unverified; if it is not, FR3.1 needs an explicit ordering rule. For Domain Design or Code Generation.
- **OQ2** — Whether the copy in FR3.3 should be atomic (write to a temporary name, then `rename`) to survive a crash mid-copy, or whether a partial file is acceptable given Syncthing will re-deliver. For Code Generation.
- **OQ3** — Whether lifting the gates changes any of the existing UI tests that assert the Claude-blocked state (`test/conversation-lock-ui.test.ts` and neighbours). To be established by running the suite before changing code, per the brownfield test-baseline safeguard.

## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-product-lead-agent
**Date:** 2026-08-30T12:46:17Z
**Iteration:** 1

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Major | FR2.1–FR2.4, all `public/app.js:NNNN` citations | The `public/app.js` line numbers this document treats as the primary spec for FR2 are stale against the current working tree. Verified: the `takeable` line cited as `public/app.js:2795` is actually at line 2906 — an 111-line drift — and the lock-message text cited as `:2798-2800` is at `:2911`. `git status` confirms `public/app.js`, `src/server.ts`, `public/index.html`, `public/styles.css`, and `public/manifest.webmanifest` are all modified in the working tree relative to whatever commit the codekb (and this requirements doc) was built from. `src/server.ts` citations drift by a smaller but still real amount (`runClaudeTurn` cited at `:3921` is actually at `:3933`; the conflict-recovery guard cited at `:2700` is actually at `:2707`). Since FR2's entire spec content beyond narrative is "at this line, change this condition," a developer opening the cited line finds unrelated code. The semantic content (which condition, which message) is still correct and independently locatable by grep, so this is confusing/rework-inducing rather than blocking. | Before hand-off, re-run the code-structure scan against the actual current working tree (or note explicitly that these files carry uncommitted drift and the line numbers are approximate), and refresh every `public/app.js` and `src/server.ts` citation in FR1–FR4. |
| 2 | Major | NFR1, C4 | Two related factual claims used as pass/fail criteria are already wrong today, before any code changes: (a) NFR1 states "The full suite (`npm test`, 115 files) shall pass" — the repo currently has 120 test files (`ls test/*.test.ts \| wc -l` → 120; 5 are untracked new test files not yet reflected in the codekb). A pass criterion phrased as an exact file count will read as failed on day one for a reason unrelated to this bugfix. (b) C4 states "Two existing UI tests pin the current value `joint-bob-v52`" — the actual current value in `public/sw.js` is `joint-bob-v55`, and at least seven tests (`chat-controls-ui`, `conversation-lock-ui`, `project-grouping-ui`, `review-notifications`, `update-session-recovery`, `secrets-ui`, `transcript-formatting`) assert that exact string, plus several more that assert the value via regex. A developer following C4 literally would update the wrong two files and miss the rest, then be surprised the suite still fails. | Reword NFR1's pass criterion to "the full suite shall pass with no new failures" (drop the fixed file count, or state it as "as of writing, N files" with a caveat that the count may drift). Recompute C4 against the current `public/sw.js` value and the current full list of tests asserting it. |
| 3 | Minor | Open Questions (OQ1, OQ2) | OQ1 and OQ2 are routed "For Domain Design" — but this intent is `bugfix` scope at `Minimal` depth, which typically skips a standalone Domain Design stage (as it already skipped Ideation and Practices Discovery per the Sources section). If Domain Design does not run for this scope, these two open questions have no stage to land in and may get silently resolved during Code Generation with no recorded decision. | Either confirm Domain Design runs for this scope/depth, or re-route OQ1/OQ2 to "For Code Generation" explicitly and require the coder to record the choice made (candidate-ordering rule, atomic-vs-partial copy) inline in code comments or the stage's own decision log. |

### Summary

The requirements are unusually well-grounded — every FR/NFR carries an exact code citation, the Q&A trail cleanly resolves the transfer-vs-takeover redirection and the four-gate contradiction (F3), A3 is honestly labeled unvalidated, and the Out-of-Scope section closes real boundaries (push-transfer removal, Pi conflict recovery, the wider tech-debt register). The blocker is that the document's load-bearing precision — exact line numbers and exact counts used as the spec itself — is already measurably stale against the current working tree (confirmed via direct grep against `public/app.js`, `src/server.ts`, and `public/sw.js`), which undercuts the "developer can act without guessing" bar this level of citation-heavy spec is trying to hit. A quick refresh pass against the live tree before hand-off resolves both Major findings.
