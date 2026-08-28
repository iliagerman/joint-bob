# Security Test Instructions

## Security focus

The security perspective focuses on the new machine-to-machine ownership boundary: bearer credentials must resolve to one persisted peer identity, asserted source IDs must match that identity, non-owners must not invoke either engine, and diagnostics must omit transcripts and credentials. This validates the security-sensitive portions of `construction/code-generation/code-summary.md`.

## Commands

```bash
node --import tsx --test test/conversation-ownership.test.ts test/replication.test.ts test/conversation-ownership-mesh-api.test.ts
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

Expected results:

- Spoofed Pi and Claude source identities are rejected.
- Concurrent non-owner prompts produce no engine invocation or transcript mutation.
- Same-epoch ownership conflict persists a write-blocking fence.
- Production dependency audit reports no high-or-greater vulnerability.

## Data handling

Use only generated node IDs, temporary bearer tokens, temporary databases, and stub transcripts. Assertions may inspect event names and IDs but must not print credentials or transcript bodies.
