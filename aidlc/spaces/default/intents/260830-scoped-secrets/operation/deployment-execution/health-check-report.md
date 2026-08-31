# Health Check Report — Scoped Secrets

Post-deployment validation of both installed nodes, run after the successful deploy of commit
`1a75ae9` (version `0.3.1`). Checks are drawn from the promotion gate in
`deployment-strategy.md` and the pre-deployment evidence in `cd-config.md`.

## Node health

| Check | This Mac | homeserver |
|---|---|---|
| Installed version | `0.3.1` | `0.3.1` |
| Release marker commit | `1a75ae9f52a3ae3711e91ef03c0ec353513c6808` | `1a75ae9f52a3ae3711e91ef03c0ec353513c6808` |
| Service state | running | `active` |
| `GET /api/health` | **200** (port 8790) | **200** (port 8787) |
| `dist/github-auth.js` present | **No** — correctly removed | **No** — correctly removed |
| `dist/secrets-migration.js` present | Yes | Yes |
| `dist/secret-replication.js` present | Yes | Yes |

Both nodes returned a healthy status endpoint. The `curl: (7) Failed to connect` lines in the
deploy log are from the restart window before the service came back up; the endpoint answers
200 on both nodes now.

## Data state after migration

| Check | This Mac | homeserver |
|---|---|---|
| Migration marker `github-groups-v1` | Present, `2026-08-31T06:31:15Z` | Present |
| Workspaces | `personal` (Personal), `work` (Work) | identical |
| Projects per workspace | personal: 5, work: 4 | identical |
| Secret accounts | 1 — label `personal`, provider `github`, `replicate = 0` | identical |
| Attachments | workspace `personal`, workspace `work` | identical |
| `github_*` tables remaining | 0 | 0 |
| `project_types` table remaining | 0 | 0 |

**Both nodes are byte-for-byte equivalent in shape.** The single migrated account is attached at
workspace scope to both workspaces, which is the faithful translation of the old default group
(assumption A1): every project that resolved a token before resolves the same token now.

`replicate = 0` is correct — FR7.5 defaults migrated and new accounts to node-local, and each
node converted its own copy in place (FR6.7).

No secret value was read or printed during this verification; only labels, providers, scope
types and counts were queried.

## Requirements this validates in a real environment

| ID | Requirement | Evidence |
|---|---|---|
| FR1.3 | Existing rows survive the rename with identity intact | Both workspaces present with the same ids, labels and project counts |
| FR2.1 | GitHub group model removed in full | `github-auth.js` absent from both installs; 0 `github_*` tables |
| FR6.1 | Migration runs once per node, marker-gated | Marker row present on both |
| FR6.6 | Default group's account attached to every workspace without its own token | Two workspace attachments from one account |
| FR7.5 | Replication defaults to node-local | `replicate = 0` |
| NFR5 | Migration safety | Both nodes converted with no data loss; the failed first attempt rolled back cleanly |

## Still unverified — needs a human at the keyboard

These cannot be checked from a shell, and one of them is the check the whole change rests on:

1. **A real `git push` from an agent session.** This is the load-bearing one. It exercises the
   generated `GIT_ASKPASS` helper against a real remote, and no automated test or database query
   can stand in for it. Open a project under either workspace, start an agent, and push.
2. **`gh` and `git push` resolving the same identity** (FR5.2) — run `gh auth status` inside an
   agent session and compare with the push identity.
3. **The secrets UI** — confirm the settings page says Workspaces, the two GitHub dialogs are
   gone, and no network response carries a token value (NFR2).
4. **Node-to-node replication** — mark an account to replicate and confirm it arrives, then
   overwrite it locally on the peer and confirm the local version wins (FR7.4).

## Rollback readiness

Unchanged and available: `~/joint-bob-pre-scoped-secrets.db` on this Mac (taken pre-deploy at
mode `0600`), plus the automatic backup each deploy takes on both nodes. The procedure is in
`<record>/operation/deployment-pipeline/rollback-runbook.md`. Note that the previous version to
reinstall is **0.2.0**, and that restoring means restoring the database too — the old build
cannot read a migrated one.
