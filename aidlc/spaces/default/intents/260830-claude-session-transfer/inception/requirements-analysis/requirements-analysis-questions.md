# Requirements Analysis — Clarifying Questions

**Stage:** requirements-analysis
**Intent:** 260830-claude-session-transfer
**Depth:** Minimal
**Mode:** self-guided (I'll edit the file)

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

[Answer]:No sure I understand it, need simpler explanatoin

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

[Answer]:No sure I understand it, need simpler explanatoin

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

[Answer]:No sure I understand it, need simpler explanatoin

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

[Answer]:No sure I understand it, need simpler explanatoin

---

## Q5 — What regression coverage should this change carry?

The active Test Strategy is **Minimal**. `test/session-paths.test.ts` currently
*pins the broken behaviour* — it asserts the sender's encoded directory name is
preserved verbatim — so it must change either way.

- A. Update `test/session-paths.test.ts` plus one new mesh test proving a Claude conversation transfers and is then listed and resumable on a destination whose checkout is at a different absolute path
- B. Update `test/session-paths.test.ts` only
- C. Full mesh coverage mirroring `test/conversation-ownership-mesh-api.test.ts` for Claude, including the dropped-acknowledgement and restart cases
- X. Other (please specify)

[Answer]:full
