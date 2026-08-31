# Code Generation — Questions

**Stage**: code-generation · **Intent**: `260830-scoped-secrets` · zero-Unit iteration

## Plan Approval

Covers `code-generation-plan.md` (including its embedded Testing Contract) and
`unit-test-instructions.md` in this directory.

**Plan shape**: 9 fixed design decisions (D1–D9), 16 implementation steps in the contract's
test-after order, a requirement coverage map, and 3 named risks.

**Testing**: Node's built-in runner with `tsx`, roughly 18 requirement-driven tests across
two new files (`test/workspace-schema.test.ts`, `test/secrets-migration.test.ts`) and two
extended ones (`test/secrets.test.ts`, `test/secrets-ui.test.ts`). Scoped command:
`node --import tsx --test test/secrets.test.ts test/secrets-migration.test.ts test/workspace-schema.test.ts test/secrets-ui.test.ts`.

**Notable decisions the plan makes on your behalf**:

- D6 — the new-conversation request carries `secretAccountIds`, and the conversation
  attachment rows are written once the engine reports a session id. This is the only way to
  honour "set secrets in the create dialog" given that the environment is composed once at
  spawn.
- D8 — the open question about two accounts colliding on one variable name in the same scope
  is closed by keeping today's behaviour: the assignment is rejected, so the collision cannot
  be created.
- D9 — `src/github-auth.ts` and its nine tables are deleted outright, but the peer route
  `POST /api/cluster/github/events` stays for one release as a 410 stub so an older paired
  node gets a clean refusal instead of a half-applied write.

**Options**:

- Approve Plan — proceed to code generation
- Request Changes — revise the plan

[Approval Fingerprint]: sha256:c77beb490469ca9727b2db615cc89c5bf4337f919a45463f21d76fa0b8c56ae3

[Answer]: Approve Plan
