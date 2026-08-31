# Smoke Test Results — Scoped Secrets

Post-deployment smoke checks against both installed nodes on version `0.3.1`, commit
`1a75ae9`. Inputs: the approved `cd-config.md` and `deployment-strategy.md`, and the
pre-deployment suite recorded in `<record>/construction/build-and-test/test-results.md`
(446 passing).

**Verdict: pass on everything reachable from a shell.** Four checks need a human at the
keyboard and are listed as outstanding.

## Automated smoke checks

| # | Check | Method | This Mac | homeserver |
|---|---|---|---|---|
| 1 | Service answers | `GET /api/health` | **200** | **200** |
| 2 | Correct build installed | `package.json` version + `.joint-bob-release` commit | 0.3.1 / `1a75ae9` | 0.3.1 / `1a75ae9` |
| 3 | Removed module really gone | `dist/` listing | `github-auth.js` absent | absent |
| 4 | New modules shipped | `dist/` listing | `secrets-migration.js`, `secret-replication.js` present | present |
| 5 | Migration ran exactly once | marker row in `secrets_migrations` | present | present |
| 6 | Workspaces exist with their projects | query | 2 workspaces, 5 + 4 projects | identical |
| 7 | Credentials converted | query | 1 `github` account, 2 workspace attachments | identical |
| 8 | Old schema removed | `sqlite_master` query | 0 `github_*`, 0 `project_types` | 0 / 0 |
| 9 | Replication default is node-local | `replicate` column | `0` | `0` |
| 10 | No secret value exposed during verification | queries selected labels and counts only, never `variables_encrypted` | held | held |

## Pre-deployment suite (for reference)

Run before the release and unchanged by it:

| Suite | Total | Pass | Fail |
|---|---|---|---|
| Scoped to this change | 21 | 21 | 0 |
| Whole project | 446 | 446 | 0 |

The suite was re-run after the installer fix and stayed at 446 passing — one test
(`installer sources persisted state…`) was updated because it pinned the position of the
removed cleanup call.

## Outstanding — human checks

Nothing here is a known failure; these are checks a shell cannot perform.

1. **A real `git push` from an agent session.** The single most important check: it is the only
   proof that the generated `GIT_ASKPASS` helper works against a real remote, and it is exactly
   what this change rewrote.
2. **`gh` and `git push` as one identity** (FR5.2).
3. **The secrets UI** — Workspaces wording, both GitHub dialogs gone, the three attachment
   pickers present, and no token value in any network response (NFR2, FR9.1–FR9.7).
4. **Replication between nodes** — mark an account to replicate, confirm arrival, overwrite it
   locally on the peer, confirm the local copy wins (FR7.1–FR7.4).

The frontend is worth a real look rather than a glance: `public/app.js` is 5,854 lines of
untypechecked JavaScript whose tests assert on source *text*, not on rendering. They prove the
old dialogs were deleted and the new test ids exist; they cannot prove anything renders.

## A note on the failed first deployment

The first deploy of this change failed on both nodes (`ERR_MODULE_NOT_FOUND` — the installer
still called into the deleted module) and rolled back cleanly, leaving both nodes on 0.2.0 with
their credentials untouched. That rollback was verified before any fix was applied. Full detail
is in `deployment-log.md`; the useful lesson is in this stage's `memory.md`.
