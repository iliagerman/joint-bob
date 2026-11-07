# Kiro V3 adapter implementation plan

> Execute inline with executing-plans and test-driven-development. User explicitly asked to make the adaptation after discussing the migration.

**Goal:** New Joint Bob Kiro conversations use CLI V3 without breaking existing V2 conversations, account isolation, or Guardian.

**Architecture:** Persist the native engine on Joint Bob's own alias transcript. Missing engine on existing records means V2. Keep V2 protocol handling for those conversations; use a separate V3 protocol module for launch inputs, negotiated extensions, configuration, updates and compaction. Do not read or write native V3 session files. Preserve the existing node-local login and account-profile selection.

**Specification:** User's request to support the new CLI. Implementation choice: retain V2 for old sessions instead of silently converting their native storage. No new login/provider UI or credentials migration in this change.

## Constraints

- Main checkout only; preserve other sessions' edits.
- CLI V3 launch contains only `acp --agent-engine=v3`, no V2 agent/model/effort/trust flags.
- Custom agent selected via `_meta.kiro.modeId`; verify it was selected, never silently use a bundled agent that inherits machine resources.
- Generate current profile format with `permissions`, not `allowedTools`; suppress Powers and inherited resources under strict isolation.
- Send client inputs on new and load. Native Kiro owns its sessions; Joint Bob retains only its own transcript and opaque native session ID.
- Honor only advertised optional methods and supplied permission options. Unknown notifications and metadata remain forward compatible.
- No login changes, model prompts, or paid operations in native control-only probes.

## Tasks

- [ ] 1. Add failing storage/profile tests for engine persistence, legacy defaults, and V3 strict profiles. Implement minimal generation-aware storage and profile output; rerun tests.
- [ ] 2. Add a strict synthetic V3 ACP fixture. Assert flags, session inputs, model/effort configuration, no fallback from custom mode, replay filtering, turn completion, permission isolation and advertised compaction. Implement V3 protocol handling and runtime selection; rerun V3 and legacy tests.
- [ ] 3. Verify profile-aware native launching, auth failures, cancellation, MCP governance/error reporting, and unsupported extension handling. Update V2-specific fixture tests to explicitly create existing V2 sessions instead of asserting V2 behavior for new sessions.
- [ ] 4. Run focused Kiro/Guardian/harness tests, typecheck, build and broader tests. Review changes, report any unavailable live validation and authentication limitations. No deployment claim without deployment verification.

## Native contract evidence

Read official ACP migration and complete custom-agent configuration reference through designated browser. Real CLI 3.0.0, disposable KIRO_HOME and cwd, current CLI-owned login, no prompt: initialize advertises standard load/list/fork plus `_kiro/session/compact`, context/export/history and other typed extensions. Creating `jb-probe` via `_meta.kiro.modeId` returns modes.currentModeId `jb-probe`. Config options include mode and autopilot; current account returned no model/effort options, and governance-disabled notification. Therefore never assume model/effort options exist or authorize an automatic account fallback.
