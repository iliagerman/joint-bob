# Integration Test Instructions — Scoped Secrets

The active Test Strategy is **Minimal**, under which this stage normally generates no
additional instruction files. Two boundaries in this change are genuinely cross-component,
so they are documented here rather than left implicit: the one-time migration off GitHub
credential groups, and node-to-node secret replication.

## What is already covered

The tests written at Code Generation are integration tests in everything but name. They use a
real SQLite database in a temporary directory rather than mocks, so they already exercise the
store → secrets → environment path end to end:

| Boundary | Covered by |
|---|---|
| Workspace schema rename against the previous build's DDL | `test/workspace-schema.test.ts` |
| GitHub groups → secret accounts, resolved token unchanged | `test/secrets-migration.test.ts` |
| Three-tier resolution, cleanup, re-keying, environment contract | `test/secrets.test.ts` |
| Replication outbox gating on the per-account flag | `test/secret-replication.test.ts` |
| HTTP surface shape | `test/secrets-api.test.ts` |

Run them together:

```bash
node --import tsx --test test/secrets.test.ts test/secrets-migration.test.ts test/workspace-schema.test.ts test/secrets-ui.test.ts
```

## Boundaries that automated tests do not reach

These need a manual pass before the change is trusted on a real cluster, because no test
stands up a second node or a real GitHub remote:

1. **A real `git push`.** Attach a `github` secret account holding a valid `GH_TOKEN` at
   workspace level, start an agent in a project under that workspace, and push. This exercises
   the generated `GIT_ASKPASS` helper, which no unit test can validate against a real remote.
2. **Two paired nodes.** Mark an account to replicate, confirm it arrives on the peer, then
   overwrite it locally on the peer and confirm the local version wins (FR7.4).
3. **A node still on the old build.** Point it at `POST /api/cluster/github/events` and
   confirm it receives a clean 410 rather than a partial write (NFR7).
4. **Upgrade on a node with real credential groups.** The migration is covered by tests
   against a reconstructed schema, but a real node's data is the only true rehearsal. Back up
   `~/.joint-bob/node.db` first.

## Test data

Never use a real token. The suite uses obvious fakes (`ghp_test_alpha`, `ghp_test_beta`) so a
leaked fixture is unmistakably not a credential.
