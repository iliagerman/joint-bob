# Requirements Analysis — Clarifying Questions

**Stage:** requirements-analysis
**Intent:** 260830-claude-session-transfer
**Depth:** Minimal
**Mode:** self-guided, then switched to guided after the questions proved unclear

Grounded in the code knowledge base at `aidlc/spaces/default/codekb/pi-mobile-web/`
(`business-overview.md`, `architecture.md`, `code-structure.md`) and in the initial
description recorded in `aidlc-state.md`.

---

## Q1 — Which local directory should hold a received Claude transcript?

`claudeProjectDirs(project, root)` (`src/session-paths.ts:49`) returns **several**
candidate directories — one encoded from each `sessionCwd` of the project, plus one
per parent directory. A received transcript has to land in exactly one of them.

- A. The first entry — the encoded form of the project's primary local path
- B. Prefer a candidate directory that already contains transcripts for this project; fall back to the first entry
- C. Place a copy in every candidate directory
- D. Ask the user at transfer time which local project path to bind the conversation to
- X. Other (please specify)

[Answer]: A

---

## Q2 — Which Claude projects root should the fix resolve against?

Two roots coexist today. `src/session-paths.ts` defaults to `~/.claude/projects`;
`src/claude-service.ts` computes a settings-aware `claudeProjectsRoot()` honouring
`settings.claude.sessionPath` / `configPath`. `src/watcher.ts:33` already calls
`claudeProjectDirs(project)` with **no** root, so a node with a non-default
`claude.configPath` watches the wrong directories (debt item 9).

- A. Use the settings-aware `claudeProjectsRoot()` everywhere, passing it into every `claudeProjectDirs` call site — this also fixes the latent `watcher.ts` bug
- B. Use the settings-aware root only in the receive/transfer path; leave `watcher.ts` unchanged for now
- C. Keep the `~/.claude/projects` default; treat non-default `configPath` as unsupported for transfer
- X. Other (please specify)

[Answer]: A

---

## Q3 — What should `receive` do when the transcript is not already at the locally-derived path?

Because Syncthing mirrors `~/.claude` wholesale (`CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude"`,
`src/syncthing.ts:41`), the file usually exists on the destination under the *sender's*
encoded directory name. The fix has to get it to the *local* name.

- A. Copy it from the sender-derived path to the locally-derived path, leaving the original in place
- B. Move it — copy, then relocate the sender-derived copy to a temporary location rather than deleting it
- C. Create a hard link or symlink instead of a second copy
- D. Do not place anything; fail the receive with a clear error when the transcript is not already at the local path
- X. Other (please specify)

[Answer]: A

---

## Q4 — Is forced takeover of a Claude conversation in scope for this change?

There are three client gates. Two govern **transfer** (`public/app.js:2172-2174`
and `:2844-2846`/`:2863-2864`/`:4104`). The third governs **take ownership**
(`public/app.js:4438`), which additionally needs the server guard in
`takeLocalSessionOwnership` (`src/server.ts:2469`) lifted and its two hardcoded
`"pi"` literals parameterised.

- A. Yes — remove all three gates and make `takeLocalSessionOwnership` engine-aware
- B. No — ship transfer only; leave take-ownership Pi-only and keep that gate
- C. Yes for the server, but keep the take-ownership button hidden until a follow-up change
- X. Other (please specify)

[Answer]: X. Other — "we no longer need transfer, the code is copiued eitehr way, ownershop is something needs to be taken over" (verbatim). Syncthing already replicates the transcript to every node, so a push-style transfer step is unnecessary; the operation that matters is taking ownership.

---

## Q5 — What regression coverage should this change carry?

The active Test Strategy is **Minimal**. `test/session-paths.test.ts` currently
*pins the broken behaviour* — it asserts the sender's encoded directory name is
preserved verbatim — so it must change either way.

- A. Update `test/session-paths.test.ts` plus one new mesh test proving a Claude conversation transfers and is then listed and resumable on a destination whose checkout is at a different absolute path
- B. Update `test/session-paths.test.ts` only
- C. Full mesh coverage mirroring `test/conversation-ownership-mesh-api.test.ts` for Claude, including the dropped-acknowledgement and restart cases
- X. Other (please specify)

[Answer]: C

---

## Follow-up F1 — What happens to the existing transfer feature?

Raised because the Q4 answer says a push-style transfer is unnecessary. Transfer
(`POST /api/cluster/sessions/transfer` -> `.../receive`, `src/server.ts:2445`/`:2668`)
exists and works today for Pi conversations.

- A. Leave transfer exactly as it is (Pi only); build only take-ownership for Claude
- B. Enable transfer for Claude as well, but treat take-ownership as the primary path
- C. Remove the transfer feature entirely, for both engines
- X. Other (please specify)

[Answer]: A. Leave transfer exactly as it is (Pi only); build only take-ownership for Claude. The human's position is that push-style transfer is redundant for both engines ("i don't think we need it at all", "why is the transfer required?"), so removing it for BOTH engines is recorded as a follow-up rather than folded into this bugfix.

---

## Follow-up F2 — When does the transcript get placed under the receiving node's own folder name?

Raised because dropping the `receive` step removes the moment at which the Q3
answer ("copy it there") was going to happen. Syncthing delivers the file under
the *sender's* encoded directory name; `listClaudeSessions` (`src/claude-service.ts:177`)
only looks in directories derived from the local node's own project paths, so the
conversation stays invisible until something places it correctly.

- A. At take-ownership — the node seizing the conversation copies it into its own folder name at that moment
- B. At listing time — the node notices foreign-named directories holding this project's conversations and copies them in when it lists sessions
- C. Continuously — a background reconciler keeps locally-derived folder names populated
- X. Other (please specify)

[Answer]: X. Other — right before running a turn. The node about to spawn `claude --resume` ensures the transcript sits at its own locally-derived path first. One trigger, at the exact point of need, independent of how ownership was acquired.

---

## Additional facts established during the interview

- **Per-node managed home.** Each node has its own `settings.projects.homePath`
  (`src/managed-home.ts`); a managed project lives at
  `<homePath>/<type folder>/<name>`. The relative portion is identical on every
  node and only the home prefix differs, so absolute project paths DO differ
  across nodes and the folder-name defect is real for this deployment.
- **A fourth UI gate the code scan missed.** `public/app.js:2795`
  (`const takeable = state.engine === "pi" && !state.activeTaskId;`) in
  `renderConversationLock()` hides `conversationLockTakeButton` and substitutes the
  message "only Pi conversations can be taken over." The reverse-engineering store
  listed three gates; there are four.
- **The intended user flow already exists.** Switching the `Runs on` selector
  (`public/app.js:4222`) on a plain conversation only changes which node the browser
  addresses; ownership does not move, the composer is disabled
  (`setComposerEnabled`, `public/app.js:2776`) and the lock banner already offers a
  Take ownership button. Only the engine gates, the server guard and the transcript
  path stand between that flow and a working Claude takeover.

---

## Follow-up F3 — Which of the four gates does this change lift?

Raised by the conductor: the first consolidated summary listed all four gates as
lift targets, which contradicts the F1 answer that push-style transfer is not built
for Claude. Gates 1 and 2 are the transfer buttons; gates 3 and 4 are the take-ownership
buttons.

- A. Only the two take-ownership gates — `public/app.js:2795` (lock banner) and `:4438` (session panel)
- B. All four, giving Claude the transfer buttons as well
- C. The two take-ownership gates, and additionally disable the transfer buttons for Pi
- X. Other (please specify)

[Answer]: A — verbatim answer "3,4 ". Gates 1 and 2 (`public/app.js:2172-2174` row menu, `:2844-2846`/`:2863-2864`/`:4104` toolbar) stay blocked for Claude.

---

> Note: an earlier confirmation was answered `Looks correct` against a summary that
> listed all four gates as lift targets. That summary contained the contradiction
> resolved in F3 above, so it was superseded and re-presented below.

## Consolidated Summary Confirmation

- The goal is **take ownership** of a Claude conversation from any node, not a push-style transfer. Syncthing already replicates the transcript to every node; what is missing is moving the single-writer lock and making the transcript findable locally.
- Exactly **two** engine gates are lifted: `public/app.js:2795` (the lock-banner Take ownership button and its "only Pi conversations can be taken over" message) and `public/app.js:4438` (the session-panel Take ownership button).
- The two transfer gates — `public/app.js:2172-2174` and `:2844-2846`/`:2863-2864`/`:4104` — **remain blocked for Claude**. Claude gets no push-transfer button.
- `takeLocalSessionOwnership` (`src/server.ts:2469`) stops throwing for `claude:` paths and stops hardcoding `"pi"` in its `conversationIsActive` and `takeConversationOwnership` calls.
- A Claude transcript belongs in the directory derived from **this node's own** project path — the first entry of `claudeProjectDirs` — consistent with the per-node managed home at `settings.projects.homePath`.
- The settings-aware `claudeProjectsRoot()` becomes the single root passed into every `claudeProjectDirs` call site, which also repairs the latent `src/watcher.ts:33` defect where a non-default `claude.configPath` watches the wrong directories.
- When the transcript is not already at the locally-derived path it is **copied** there; the original is left untouched.
- That copy happens **immediately before a turn runs**, before spawning `claude --resume`.
- The existing push-style transfer is **left exactly as it is** for Pi. Removing it for both engines is recorded as a separate follow-up, not part of this change.
- Test coverage is **full mesh coverage** mirroring `test/conversation-ownership-mesh-api.test.ts` for Claude; `test/session-paths.test.ts` currently pins the defective behaviour and must be updated.
- Pi-only conflict recovery (`src/server.ts:2700`) stays out of scope.

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
