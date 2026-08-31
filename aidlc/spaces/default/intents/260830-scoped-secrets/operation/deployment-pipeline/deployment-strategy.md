# Deployment Strategy — Scoped Secrets

## Why this release is not an ordinary one

Every other Joint Bob release replaces code. This one also **converts data one way**: it turns
every GitHub credential group into a secret account and then drops nine `github_*` tables. Once
a node has run the migration, the previous build cannot read that node's database, because the
tables it expects are gone.

That single fact drives every choice below: sequence the rollout so one node is always known
good, and treat the pre-deploy database backup as a first-class release artifact rather than a
side effect.

## Strategy: sequential single-node rollout

This is a self-hosted, single-user product with two paired nodes. Blue/green, canary and rolling
updates all assume a load balancer in front of interchangeable replicas — none of that exists
here, and inventing it would be ceremony rather than safety. The honest equivalent of a canary
in this topology is: **upgrade one node, verify, then upgrade the other.**

| Aspect | Choice |
|---|---|
| Strategy | Sequential single-node rollout (node 1 → verify → node 2) |
| Traffic shifting | None — each node serves its own operator; there is no shared front door |
| Migration timing | On first start of the upgraded build, marker-gated (`secrets_migrations['github-groups-v1']`) |
| Backward compatibility | Not attempted for the database. The old build cannot read a migrated node |
| Rollback | Restore the pre-deploy database backup and reinstall the previous version (see `rollback-runbook.md`) |
| Safety net during rollout | The un-upgraded second node keeps working on its own credentials |

## Upstream inputs — what existed and what did not

This stage's declared inputs (`ci-config`, `quality-gates`, `infrastructure-specification`,
`cicd-pipeline`) **do not exist for this workflow**, and their absence is by design: the
`express` scope skips both CI Pipeline and Infrastructure Design. Nothing here was invented to
fill those gaps. The strategy is designed against evidence that does exist:

- `.github/workflows/release.yml` — the real tag-triggered release pipeline (see `cd-config.md`).
- `scripts/hooks/pre-push` — the real deploy path to the installed nodes.
- `<record>/construction/build-and-test/test-results.md` — 446 tests passing, build and type
  check green.
- `<record>/construction/build-and-test/build-and-test-summary.md` — the four manual checks no
  automated test reaches.
- `aidlc/spaces/default/codekb/joint-bob/architecture.md` — the multi-node topology.

## Environment tiers

There is no dev / staging / production ladder in this product. There are two production nodes
and an ephemeral EC2 smoke-test box. The promotion sequence is therefore:

1. **Local** — `npm run typecheck`, `npm test`, `npm run build` all green. Already done.
2. **Node 1** — upgraded, then verified against the checklist below.
3. **Node 2** — upgraded only after node 1 passes.

## Promotion gate from node 1 to node 2

Do not upgrade the second node until every one of these passes on the first. Each maps to a
requirement that only a real environment can prove:

- [ ] The node starts and serves the UI; the migration marker row exists.
- [ ] Settings shows the expected **workspaces** (`personal`, `work`) with the same projects.
- [ ] Every project that could push before still resolves a token — check one project per
      workspace (FR6.8).
- [ ] A real `git push` from an agent session succeeds, exercising the generated `GIT_ASKPASS`
      helper (FR5.3). This is the check that matters most; nothing in the test suite can prove it.
- [ ] `gh` and `git push` authenticate as the same identity (FR5.2).
- [ ] The secrets settings page shows no token values anywhere in the network responses (NFR2).
- [ ] The still-old second node receives a clean 410 from `POST /api/cluster/github/events`
      rather than a partial write (NFR7).

If any check fails, stop. Do not upgrade the second node — it is the rollback source of truth
for what the credentials looked like before.

## Feature flags

None, and none should be added. This change removes a subsystem; a flag that keeps both credential
models alive would mean maintaining the exact duality the change exists to end. The migration
marker is the only conditional, and it is one-way by intent.

## Database migration handling

- Forward-only, marker-gated, idempotent. Running the upgraded build twice converts once.
- The migration reads the `github_*` tables **before** anything drops them; that ordering is the
  whole correctness argument and is covered by `test/secrets-migration.test.ts`.
- Not backward compatible, by decision — see the rollback runbook for what to do instead.

## Post-rollout follow-ups

1. Remove the `POST /api/cluster/github/events` 410 stub once both nodes are upgraded (Q4).
2. Add a CI-on-push workflow running typecheck, test and build. Deliberately **not** in this
   release (Q3), but the gap is real: nothing currently verifies `main` except a git hook each
   clone installs by hand.

## The one check that decides this release

Of the seven promotion-gate checks above, one is load-bearing in a way the others are not: a
real `git push` from an agent session on node 1. It is the only proof that the generated
`GIT_ASKPASS` helper works against a real remote, and it is the exact capability this change
rewrites. Every automated test in the suite runs against a temporary SQLite database and cannot
reach it. If that push succeeds and the identity is the one the project used before, the change
has done its job.
