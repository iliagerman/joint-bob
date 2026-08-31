# Deployment Log — Scoped Secrets

Executed against the approved `cd-config.md` and `deployment-strategy.md`, with the
pre-deployment evidence from `<record>/construction/build-and-test/test-results.md`. No
`environment-inventory` artifact exists — Environment Provisioning is SKIP under the `express`
scope — so the target inventory came from the workspace's own `Justfile` and
`scripts/deploy-installed-nodes.sh`, as the stage requires when that input is absent.

**Outcome: deployed successfully to both nodes, after one failed attempt and one fix.**

## Timeline

| # | Step | Result |
|---|---|---|
| 1 | Extra database backup on this Mac → `~/joint-bob-pre-scoped-secrets.db`, mode `0600` | Done — 1,040,384 bytes |
| 2 | Version bump `0.2.0` → `0.3.0`, `CHANGELOG.md` section written | Done |
| 3 | Commit `53cb819` on `main` | Done — 89 paths |
| 4 | Push attempt 1 | **Refused** — HTTP 403 |
| 5 | `gh auth switch --user iliagerman` (human-approved) | Done |
| 6 | Push attempt 2 | Pushed `c3e9b05..53cb819` |
| 7 | Automatic deploy to both nodes | **Failed** — `ERR_MODULE_NOT_FOUND` |
| 8 | Fix `scripts/install-service.sh`, update the installer-ordering test | Done |
| 9 | Full suite re-run | 446 pass, 0 fail |
| 10 | Push attempt 3 | **Blocked by the changelog gate**, which wrote a `0.3.1` bump |
| 11 | Amend commit to `1a75ae9` with the gate's bump, push | Pushed `53cb819..1a75ae9` |
| 12 | Automatic deploy to both nodes | **Success** — "Deployed 1a75ae9… to all installed copies." |
| 13 | Post-deploy verification on both nodes | Pass — see `health-check-report.md` |

## The two failures, in detail

### Push refused with 403 — wrong git identity

```
remote: Permission to iliagerman/joint-bob.git denied to germanilia.
fatal: unable to access 'https://github.com/iliagerman/joint-bob.git/': The requested URL returned error: 403
```

`gh` held two authenticated accounts and the **active** one was `germanilia`, while the
repository belongs to `iliagerman`. This is the same class of problem the change itself fixes —
the wrong identity being picked up silently — one layer below the application. Resolved by
switching the active account with the human's explicit approval. Note this is a **global**
change to the machine's `gh` state, not a repo-local one.

### Install failed — a reference to the deleted module survived

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/ilia/.local/share/joint-bob/app/dist/github-auth.js'
Error: Installation failed with status 1
```

`scripts/install-service.sh:162` imported `dist/github-auth.js` to call
`cleanupLegacyGitHubCredentialFiles()`. The code scan read `scripts/` only by filename, so this
one reference outside `src/` was missed at Code Generation and no test caught it: the installer
is exercised by a **string-ordering** test, not by running it.

**The deploy's safety worked exactly as designed.** The installer failed, rolled back, and both
nodes stayed on 0.2.0 with `github-auth.js` intact and their services active. Verified before
fixing anything — no migration had run on either node.

The cleanup call was dropped rather than ported: nothing reads the legacy `github-auth.json`
path now that the module is gone, and neither node has such a file (checked on both). One test
pinned the position of that call in the installer; it now pins the surrounding order without it.

## Database migration

Ran automatically on first start of the new build on each node, marker-gated and one way.

| Node | Marker | Result |
|---|---|---|
| This Mac | `github-groups-v1` @ `2026-08-31T06:31:15Z` | Applied |
| homeserver | `github-groups-v1` | Applied |

Both nodes produced an **identical** result: two workspaces (`personal`, `work`) carrying 5 and
4 projects, one `github`-provider secret account labelled `personal` with `replicate = 0`,
attached at workspace scope to **both** workspaces. That is exactly assumption **A1** — the old
default group's account attaches to every workspace that resolves no token of its own — so
every project authenticates with the token it used before.

All nine `github_*` tables and `project_types` are gone from both databases.

## What was deliberately not done

- **No npm publish.** Publishing is triggered by pushing a `v*` tag; no tag was pushed.
- **No one-node-first sequencing.** The strategy approved at Deployment Pipeline called for it,
  but the human asked for both nodes, and the push hook deploys to both automatically. Recorded
  here as a deliberate supersede, not an oversight.
