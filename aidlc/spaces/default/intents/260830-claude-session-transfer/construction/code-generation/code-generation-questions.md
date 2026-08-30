# Code Generation — Questions

**Stage:** code-generation · **Iteration:** single, zero-Unit
**Intent:** 260830-claude-session-transfer

---

## Plan Approval

Covers `code-generation-plan.md` (including its embedded `## Testing Contract` and the pre-change test baseline) and `unit-test-instructions.md`, both final as of this fingerprint.

**Plan:** 14 steps, `test-after` ordering — implement each applicable layer, then write and run that layer's tests. Data-model and repository layers are omitted as genuinely inapplicable: the ownership table's `CHECK(engine IN ('pi','claude'))` already admits Claude.

**Tests:** roughly 14 tests across four files — two existing and updated (`session-paths.test.ts`, `conversation-lock-ui.test.ts`), two new (`claude-session-paths-local.test.ts`, `claude-takeover-mesh-api.test.ts`). The mesh test is the `bugfix` scope floor's targeted regression; it rises above the Minimal unit-test default because the defect only reproduces across two nodes with different absolute project paths.

**Baseline:** 343 tests, 342 pass, 1 fail before any change. The pre-existing failure is `test/session-watcher.test.ts` — *"shared flat Pi session watcher does not keep the process alive"* — in the same watcher that Step 5 modifies. The post-change criterion is therefore no NEW failures, not a green suite.

[Approval Fingerprint]: sha256:7cc0842207349a39ce07588a8ca8aad9d3896a93a9e935058341a2b9eeda2854

- Approve Plan
- Request Changes

[Answer]: Approve Plan
