# Deployment Execution — Pre-Deployment Checks and Questions

**Stage**: deployment-execution · **Intent**: `260830-scoped-secrets` · **Depth**: Minimal

## Pre-deployment check results

Run before asking anything, against the real workspace.

| Check | Result |
|---|---|
| Build (`npm run build`) | **Pass** |
| Type check (`npx tsc --noEmit`) | **Pass** — exit 0 |
| Tests (`npm test`) | **Pass** — 446/446 |
| Requirement coverage | **Pass** — 55/55 IDs, every target file exists |
| Database migration required? | **Yes** — one-way, marker-gated (`secrets_migrations['github-groups-v1']`), tested by `test/secrets-migration.test.ts` |
| Migration tested? | **Yes** against a reconstructed schema; **not** against a real node's data |
| Target environments identified? | **Yes** — two installed nodes (`local`, `homeserver`) per `Justfile` |
| Dependent services healthy? | Not applicable — no external service dependency; each node is self-contained |
| Code committed? | **No** — 45 changed paths in the working tree, nothing committed |
| Version bumped / CHANGELOG written? | **No** — required by `scripts/hooks/pre-push` before any push |

## A conflict between the approved strategy and the actual tooling

The approved deployment strategy is **one node first, verify, then the second**. The push hook
does not work that way: `scripts/hooks/pre-push` launches
`scripts/wait-for-main-and-deploy.sh`, which calls `deploy-installed-nodes.sh` with **no target
argument** — it deploys to **both** nodes as soon as the remote confirms the commit.

`Justfile` does expose per-node recipes (`just update-local`, `just update-homeserver`), so
one-at-a-time is fully supported — but only when the operator drives it, not when a push does.

There is also a hard prerequisite: `deploy-installed-nodes.sh` deploys `git rev-parse HEAD`, a
**committed** commit. Nothing can be deployed while these 45 changed paths sit uncommitted.

## Q1. How far should this stage actually go?

- A. **Stop before anything leaves this machine.** Nothing is committed, pushed, deployed or
  published. The deployment log records the change as ready-to-ship with the runbook, and the
  rollout is yours to drive.
- B. **Prepare the release locally, then stop.** Bump `package.json`, write the `CHANGELOG.md`
  entry (both required by the push hook anyway), commit — but do not push, deploy or publish.
- C. **Prepare and commit, then deploy to the local Mac node only** (`just update-local`), so
  the one check that matters — a real `git push` from an agent session — can actually run.
  Still no push to the remote, no publish, no second node.
- X. Other (please specify)

[Answer]: X. Do all of it — commit, push, and deploy to both the homeserver and this Mac.

## Q2. If the release is prepared, what version number?

Current version is `0.2.0`. This change removes a public subsystem, renames API routes, and
migrates data one way.

- A. **`0.3.0`** — a minor bump. Matches how the project has versioned so far (still `0.x`,
  where breaking changes are expected within the minor).
- B. **`1.0.0`** — signal the credential model is now settled.
- C. **`0.2.1`** — a patch bump.
- X. Other (please specify)

[Answer]: A

---

## Consolidated Summary Confirmation

- Q1 — Go all the way: bump the version, write the changelog entry, commit, push, and deploy to both the homeserver and this Mac.
- Q2 — Version `0.3.0`.
- This supersedes the one-node-first sequencing approved at Deployment Pipeline: the push hook deploys to both nodes automatically, and both nodes are wanted.
- No npm publish. Publishing is triggered by pushing a `v*` tag, and no tag will be pushed unless asked for separately.
- Before the push, an extra copy of this Mac's `~/.joint-bob/node.db` is taken as `~/joint-bob-pre-scoped-secrets.db` at mode `0600`, on top of the backup each deploy already takes. The homeserver relies on the deploy's own automatic backup.
- The push is the irreversible step: the pre-push hook confirms the commit on the remote and then deploys to both nodes in the background, running the one-way credential migration on each.
- Commits go directly to `main`, with no new branch.

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
