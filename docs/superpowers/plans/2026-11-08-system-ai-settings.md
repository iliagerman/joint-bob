# System AI settings implementation plan

**Goal:** Centralize internal AI configuration, use selected machine-held credentials independently of project attachments, and replicate configuration only to twins while collection remains local.

**Architecture:** Existing settings remain their canonical source. A shared allowlist validates and replicates their changes through the signed outbox. A small system-AI record adds explicit decision credentials, internal-operation overrides and login-profile selections. Existing controls move rather than being duplicated.

**Tech stack:** TypeScript, SQLite, Zod, plain browser JavaScript/CSS, native isolated browser tests.

**Spec:** `docs/superpowers/specs/2026-11-08-system-ai-settings.md`

## Constraints and review focus

- Never expose system keys to project agents, API output, logs or replicated settings payloads.
- Reject non-twin replication and non-admin configuration writes.
- Missing/deleted selections fail visibly; do not pick arbitrarily among several credentials.
- Preserve existing choices; a model unavailable on the other twin stays selected and reports unavailable.
- No Quality enabled flag or quality records in replicated settings.
- Leave unrelated working edits alone. No branches/worktrees. Publish only the exact verified task files.

## Tasks

- [ ] Add failing secret/config tests for unattached system credentials, isolation, invalid accounts, twin settings replication and local-only collection. Implement explicit secret resolution plus validated settings replication.
- [ ] Wire feedback, cleanup and quality to system decision credentials and operation choices. Preserve project-based redaction and restricted quality execution. Add boundary tests for missing keys and caller behavior.
- [ ] Add System AI screen using existing pickers, move background/sync/dashboard/summary controls, add decision-secret and operation choices. Show shared-vs-local scope and save status. Add browser coverage for selection, persistence and phone layout.
- [ ] Verify a real paired disposable twin round-trip and unchanged collection settings. Run focused tests, typecheck/build, inspect exact release tree, push with versioned notes, and wait for green Release CI.
