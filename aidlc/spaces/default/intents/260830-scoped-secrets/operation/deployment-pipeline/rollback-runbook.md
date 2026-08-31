# Rollback Runbook — Scoped Secrets

## Read this first

This release runs a **one-way credential migration**. After a node has started the new build,
its database no longer contains the nine `github_*` tables the previous build reads. Reinstalling
the old version alone therefore does **not** restore a working node — it produces a node that
starts and cannot authenticate anything.

**The rollback artifact is the database backup the deploy already takes**, at mode `0600`,
immediately before the installed copy is replaced. Rolling back means restoring that file *and*
reinstalling the previous version, together, in that order.

## When to roll back

Roll back when the node cannot do authenticated work and the cause is not obvious within a few
minutes. Concretely:

| Symptom | Roll back? |
|---|---|
| `git push` fails with an authentication error from an agent session | **Yes** — this is the change's core promise |
| A project resolves a different GitHub identity than before the upgrade | **Yes** — the migration mapped something wrong |
| Workspaces are missing, or projects lost their workspace | **Yes** — the schema rename went wrong |
| A secret account is visible but its variables are empty | **Yes** — decryption is failing |
| The UI renders oddly or a button is mislabelled | No — cosmetic, fix forward |
| A single `ENOTEMPTY` during `npm ci` | No — transient npm race; retry the update |
| The second (not-yet-upgraded) node reports a 410 from the peer sync | No — that is the intended behaviour |

## Before you upgrade anything

1. Confirm the backup path and mechanism on the node you are about to upgrade, and note where
   the deploy writes it. You want to know this **before** you need it, not while a node is down.
2. Take your own copy of `~/.joint-bob/node.db` as well. The deploy's backup is automatic; a
   second copy you made yourself costs nothing and removes all doubt.
   ```bash
   cp ~/.joint-bob/node.db ~/joint-bob-pre-scoped-secrets.db
   ```
   Keep the file mode restrictive — this database holds encrypted credentials:
   ```bash
   chmod 600 ~/joint-bob-pre-scoped-secrets.db
   ```
3. Do **not** delete `~/.joint-bob/secret.key`. The backup is encrypted with it; without that
   key the backup is unreadable and the rollback is impossible.
4. Record the currently installed version so you know what to reinstall.

## Rollback procedure

Run these on the affected node, in order.

1. **Stop the service.** Use the service-management commands for the platform, as documented in
   `README.md`. Nothing else in this procedure is safe while the process holds the database.

2. **Move the migrated database aside — do not delete it.** It contains any secret account
   created since the upgrade, and it is your evidence for diagnosing what went wrong.
   ```bash
   mv ~/.joint-bob/node.db ~/joint-bob-migrated-$(date +%Y%m%d-%H%M%S).db
   ```

3. **Restore the pre-deploy backup.**
   ```bash
   cp ~/joint-bob-pre-scoped-secrets.db ~/.joint-bob/node.db
   chmod 600 ~/.joint-bob/node.db
   ```
   If you are using the deploy's own backup rather than your manual copy, restore that file to
   the same path with the same mode.

4. **Reinstall the previous version.** Install the version you recorded before the upgrade,
   using the installation method in `README.md`.

5. **Start the service** and verify: the UI loads, Settings shows project types (not workspaces
   — you are on the old build again), and a `git push` from an agent session succeeds.

6. **Leave the second node alone** if it has not been upgraded. It is your reference for what
   correct looks like.

## What you lose by rolling back

- Any secret account, attachment or credential change made after the upgrade. The restored
  backup predates all of it.
- Any project, workspace or conversation change made after the upgrade, since the whole database
  is restored, not just the credential tables.

This is why the promotion gate exists: verify node 1 quickly, before real work accumulates on
top of the migration.

## After a rollback

1. Keep the moved-aside migrated database. It is the only copy of what the migration produced,
   and diagnosing the failure without it means guessing.
2. Record what failed, precisely — which project, which identity, which error text.
3. Fix forward. The next release should carry a regression test reproducing the failure; that is
   the standing practice for every defect in this project.
4. Do not retry the upgrade on the same node until the cause is understood. A second run finds
   the marker row absent (the database was restored) and will migrate again, reproducing the same
   fault.

## What this runbook does not cover

- **Rolling back the npm-published package.** The published version stays published; the
  rollback is local to your nodes.
- **A cluster half-upgraded for a long period.** The design assumes the second node follows
  within hours. If node 1 sits upgraded and node 2 does not for days, replication between them
  is limited to what the 410 stub refuses — no credential events cross. That is safe, but it is
  not a steady state to live in.

## The two-sentence version

If node 1 goes wrong after this upgrade: stop the service, move the migrated database aside,
restore the backup, reinstall the previous version, start it. Do not touch node 2 while you do
it — until it is upgraded, it is the only intact record of what the credentials looked like
before.
