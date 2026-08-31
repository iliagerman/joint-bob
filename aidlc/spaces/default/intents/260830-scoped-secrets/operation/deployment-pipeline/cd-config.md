# CD Configuration — Scoped Secrets

## What the pipeline already is

No new pipeline is introduced by this change. The decision at Q3 was to ship on the existing
path and record the CI gap separately, so this document describes the real delivery mechanism
and the two places this release plugs into it.

The declared upstream inputs for this stage — `ci-config`, `quality-gates`,
`infrastructure-specification` and `cicd-pipeline` — do not exist in this workflow, because the
`express` scope skips CI Pipeline and Infrastructure Design. Rather than invent them, this
configuration is written against the pipeline that is actually in the repository.

### Stage 1 — the local gate (`scripts/hooks/pre-push`)

Opt-in per clone via `./scripts/install-git-hooks.sh`. This is currently the **only** automated
verification in the project.

1. Resolves `node` from four fallback locations, because GUI Git clients run hooks with a bare
   `PATH`.
2. If the pushed commits touch `src/`, `public/` or `bin/` without a `package.json` version bump
   and a matching `CHANGELOG.md` section, it calls `scripts/changelog-gate.mjs` to write both
   files into the working tree and **refuses the push**.
3. On a passing gate: records the push, waits for the remote to confirm the exact commit, then
   deploys to both installed nodes.
4. Each deploy takes a mode-`0600` SQLite backup **before** replacing the installed copy, then
   verifies the reported release.

**This release changes how step 3 is used.** The hook deploys to both nodes; the strategy for
this release is one node at a time. See the runbook — the operator drives the second node
deliberately, after the promotion gate passes.

### Stage 2 — the release workflow (`.github/workflows/release.yml`)

Triggered **only** on a `v*` tag push. Permissions `contents: write`, `id-token: write`.

```
npm ci
  → npm run typecheck
  → npm test
  → npm run build
  → npm pack + verify package/bin/joint-bob.mjs exists
  → verify .joint-bob-release carries commit=$GITHUB_SHA
  → sha256sum
  → softprops/action-gh-release@v2
  → npm publish --provenance --access public
```

This workflow is the quality gate that actually blocks a bad release: it runs the full suite
before publishing, and refuses to publish if typecheck, tests or build fail.

## Quality gates for this release

| Gate | Criterion | Where enforced | Status |
|---|---|---|---|
| Type check | `npx tsc --noEmit` exit 0 | Release workflow + local | **Pass** |
| Tests | 446/446 passing | Release workflow + local | **Pass** |
| Build | `npm run build` clean | Release workflow + local | **Pass** |
| Requirement coverage | 55/55 IDs covered | `cross-unit-traceability.md` | **Pass** |
| Changelog + version bump | `package.json` bump with matching `CHANGELOG.md` section | Pre-push hook | **Required before push** |
| Node-1 promotion gate | The seven checks in `deployment-strategy.md` | Manual | **Required before node 2** |
| Dependency audit | No Critical/High CVEs | — | **Cannot run** — the configured private registry has no audit endpoint |

## Release checklist for this change

1. Bump `package.json` and add the matching `CHANGELOG.md` section. The pre-push hook will
   refuse the push otherwise, and this change touches `src/` and `public/`.
   The entry must call out the one-way credential migration explicitly — an operator reading
   the changelog should learn about it before upgrading, not after.
2. Push. The hook runs the gate and confirms the exact commit on the remote.
3. Tag `vX.Y.Z` and push the tag; the release workflow runs the full suite and publishes.
4. Upgrade node 1. Run the promotion gate from `deployment-strategy.md`.
5. Upgrade node 2 only after every check passes.

## Known operational flake

`npm ci` on the remote node occasionally fails with `ENOTEMPTY` during `just update`. It is a
transient npm filesystem race, not a code fault: retry the update, and the node rolls back
safely on its own. Do not treat a single `ENOTEMPTY` as a failed release.

## Notifications

None are automated. The product is single-user and self-hosted, so the operator is the release
manager, the deployer, and the only affected user. Adding release notifications would be
ceremony with no audience.

## Recorded follow-ups

Neither is part of this release; both are real and should not be lost:

1. Remove the `POST /api/cluster/github/events` 410 stub once both nodes run the new build.
2. Add a CI-on-push workflow running `npm run typecheck`, `npm test` and `npm run build`, so
   `main` is verified by something other than a hook each clone installs by hand.
