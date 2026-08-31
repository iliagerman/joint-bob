# Deployment Pipeline — Clarifying Questions

**Stage**: deployment-pipeline · **Intent**: `260830-scoped-secrets` · **Depth**: Minimal

This is a brownfield project with a real delivery path already in place: a tag-triggered
`.github/workflows/release.yml` that publishes to npm, and an opt-in `scripts/hooks/pre-push`
gate that deploys to both installed nodes after the remote confirms the exact commit, taking a
mode-`0600` SQLite backup before replacing each installed copy.

What makes this release different from an ordinary one: it runs a **one-way credential
migration** that converts GitHub credential groups into secret accounts and then drops nine
tables. That changes the rollback maths.

---

## Q1. How should this release reach the two nodes?

- A. **One node first, verify, then the second.** Deploy to one node, confirm a real `git push`
  still authenticates and the migrated accounts look right, then deploy the second.
- B. **Both at once**, as `just update` does today — the deploy already backs up each node's
  database before replacing the installed copy.
- C. **One node, then pause for a day** of real use before the second.
- X. Other (please specify)

[Answer]: A

## Q2. What is the rollback plan, given the migration is one-way?

Rolling the code back after the migration has run leaves the old build looking for nine tables
that no longer exist. The deploy already takes a database backup immediately before replacing
each installed copy.

- A. **Restore the pre-deploy database backup and reinstall the previous version.** The backup
  the deploy already takes is the rollback artifact; document the exact restore steps.
- B. **Forward-fix only.** Do not roll back; fix and re-release. Credentials are already
  converted, so going back loses any account created after the upgrade.
- C. **Both, in order**: attempt forward-fix first, restore the backup only if the node cannot
  authenticate at all.
- X. Other (please specify)

[Answer]: A

## Q3. Should this change also add CI on push, or ship on the existing path?

Today nothing runs the test suite on `main`; the only enforcement is a git hook each clone must
install by hand. This change is a good moment to fix that, or a bad moment to widen scope.

- A. **Ship on the existing path.** Keep this release focused; record the CI gap as a separate
  piece of work.
- B. **Add a push/PR workflow now** that runs `npm run typecheck`, `npm test` and
  `npm run build`, so nothing reaches `main` unverified again.
- X. Other (please specify)

[Answer]: A

## Q4. How long should the old peer endpoint keep answering?

`POST /api/cluster/github/events` stays as a stub returning 410 so a node still on the old
build gets a clean refusal instead of a half-applied write.

- A. **Remove it once both nodes are upgraded** — a follow-up task after this rollout.
- B. **Keep it for one release**, then remove on the next version bump.
- C. **Keep it indefinitely**; it costs nothing.
- X. Other (please specify)

[Answer]: A

---

## Consolidated Summary Confirmation

- Q1 — Roll out to one node first, verify a real `git push` still authenticates and the migrated accounts look right, then deploy the second node.
- Q2 — Rollback is: restore the mode-`0600` database backup the deploy already takes immediately before replacing the installed copy, then reinstall the previous version. The runbook documents the exact restore steps.
- Q3 — Ship on the existing path (tag-triggered release workflow plus the opt-in pre-push deploy hook). The missing CI-on-push gate is recorded as separate work, not added here.
- Q4 — The `POST /api/cluster/github/events` 410 stub is removed as a follow-up task once both nodes are upgraded.

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
