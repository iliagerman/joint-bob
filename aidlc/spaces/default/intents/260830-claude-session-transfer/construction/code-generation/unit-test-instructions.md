# Unit Test Instructions — Claude Conversation Ownership Takeover

**Test Strategy:** Minimal · **Scope floor:** `bugfix` — a targeted regression at the narrowest level that reproduces the defect, with the existing suite kept green.

## Framework and configuration

The project uses Node's built-in test runner. There is no Jest, Vitest, Mocha, or Playwright, and there is nothing to install or configure — the runner is already present and was verified against the baseline before planning.

- Runner: `node:test` with `node:assert/strict`
- TypeScript is loaded at execution time through `tsx` (`--import tsx`); tests are not compiled. `tsconfig.json` sets `include: ["src/**/*.ts"]`, so `test/` sits outside the compiled program.
- Test files live flat in `test/` and are named `<feature>.test.ts`.
- No coverage tooling is configured and none is added — the Minimal strategy sets no coverage floor.

## The exact command to run this work's tests

Scoped to this change only. Do not substitute a bare `npm test` here; that runs all 120 files and is reserved for the final regression comparison in Step 14.

```bash
node --import tsx --test \
  test/session-paths.test.ts \
  test/claude-session-paths-local.test.ts \
  test/claude-takeover-mesh-api.test.ts \
  test/conversation-lock-ui.test.ts
```

`test/session-paths.test.ts` and `test/conversation-lock-ui.test.ts` already exist and are updated by this work. The other two are new: `claude-session-paths-local.test.ts` covers the transcript-location helpers, `claude-takeover-mesh-api.test.ts` carries the mesh regression.

Server-booting tests need one test per file — a second `startTestNode()` in the same file fails with *"Missing session cookie"*. Keep the mesh regression's cases in separate files if more than one is needed.

## Tests to write

Minimal strategy: one verifiable test per requirement at the narrowest effective level, plus a happy-path floor per component. Roughly 10-14 tests total.

### Transcript location and copying — `test/claude-session-paths-local.test.ts`

| # | Behaviour | Requirement |
|---|---|---|
| 1 | Transcript already at the locally-derived path — the helper returns that path and performs no write (file mtime and byte content unchanged) | FR3.4 |
| 2 | Transcript present only under a directory name encoded from another node's project path — it is copied to the local name and the returned path is the local one | FR3.1, FR3.2, FR3.3 |
| 3 | After that copy, the source file still exists, unmodified, byte-identical | FR3.3, NFR3 |
| 4 | No transcript anywhere under the projects root — the helper throws an error naming the session id and the directory searched, and creates no file | FR3.5 |
| 5 | The computed destination is inside the node's Claude projects root | NFR5 |

### Path derivation — `test/session-paths.test.ts` (existing, updated)

This file currently asserts that `claude:/Users/a/.claude/projects/project/session.jsonl` maps to `claude:/home/b/.claude/projects/project/session.jsonl`, preserving the sender's encoded directory name verbatim. That assertion pins the defect. Replace it with coverage of the corrected behaviour, and keep every Pi assertion in the file untouched.

| # | Behaviour | Requirement |
|---|---|---|
| 6 | The watcher's directory set honours a non-default `claude.configPath` rather than falling back to `~/.claude/projects` | FR4.1, FR4.2 |

### Mesh regression — `test/claude-takeover-mesh-api.test.ts` (new)

The targeted regression required by the `bugfix` scope floor. A unit test cannot reproduce this defect: it only appears across two nodes whose project checkouts sit at different absolute paths, which is why this rises above the Minimal unit-test default. Mirror the structure of `test/conversation-ownership-mesh-api.test.ts`.

| # | Behaviour | Requirement |
|---|---|---|
| 7 | Node A owns a Claude conversation; node B, whose project path differs, takes ownership successfully | FR1.1, FR1.2 |
| 8 | After takeover, the conversation appears in node B's `listClaudeSessions` output | FR3.1, FR3.2 |
| 9 | A turn run on node B resumes the existing transcript rather than starting a new conversation | FR3.2 |
| 10 | Takeover is refused while a turn is live on the owning node (`conversationIsActive`) | FR1.3, NFR4 |
| 11 | The dropped-acknowledgement path (`JOINT_BOB_TEST_DROP_TRANSFER_ACK_ONCE`) leaves ownership consistent | FR1.4 |
| 12 | Ownership survives a service restart | FR1.4 |

### Client gates — `test/conversation-lock-ui.test.ts` (existing, updated)

| # | Behaviour | Requirement |
|---|---|---|
| 13 | A Claude conversation owned elsewhere shows the Take ownership button and the same wording used for Pi — the "only Pi conversations can be taken over" text is gone | FR2.1, FR2.2 |
| 14 | Both transfer controls remain disabled for Claude | FR2.4 |

Also sweep the suite for existing assertions of the Claude-blocked state and update them together with the code, rather than discovering them at the end.

## Coverage targets

None. The Minimal strategy sets no line-coverage floor and the `bugfix` scope adds none. The obligations are: one test per requirement, the targeted mesh regression, and no new failures against the recorded baseline.

## Mocking and stubbing

- Do not mock the filesystem for the location helpers. Build a real temporary directory tree with `node:fs/promises` under `os.tmpdir()` and point the projects root at it. The defect is about real paths; a mocked filesystem would not have caught it.
- Do not mock the `claude` CLI subprocess. The mesh test asserts *which transcript file is resumed*, which is observable from the filesystem and the session list without running a real turn to completion.
- Mesh tests boot real servers via the existing `startTestNode()` helper, as `test/conversation-ownership-mesh-api.test.ts` does. Do not stub the peer HTTP layer — the machine-token path is part of what is under test.
- Client tests are DOM-level assertions against `public/app.js` and `public/index.html`, matching the existing style in `test/conversation-lock-ui.test.ts`. No browser, no Playwright.

## Test data management

- Each test creates its own temporary home directory and removes it in an `after` hook. Nothing is written to the developer's real `~/.claude` or `~/.joint-bob`.
- Node identities, project records, and transcripts are constructed per test; no shared fixture files.
- Transcripts are minimal hand-written `.jsonl` — enough events for `claudeSessionFacts` to read a `cwd` and a title, no more.
- The two nodes in a mesh test are deliberately given **different** absolute project paths. That difference is the defect's trigger; identical paths would make every assertion pass vacuously.
