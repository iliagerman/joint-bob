# Session safeguards control requirements

## Intent analysis

- Request type: user-facing feature
- Scope: Pi session runtime, WebSocket contract, chat toolbar, Pi CLI extension
- Complexity: moderate
- Risk: medium because the feature permits destructive tool calls

## Functional requirements

1. Every new Pi session starts with safeguards enabled.
2. An administrator can disable or re-enable safeguards for the active Pi session from the chat toolbar.
3. The disabled state persists in that Pi session's JSONL history and survives reconnects and process restarts.
4. Changing the state reloads the Pi runtime for that session so the permission-gate extension is absent when safeguards are disabled and restored when safeguards are enabled.
5. The control is unavailable while the Pi session is busy and hidden for Claude sessions.
6. Disabling safeguards requires one explicit browser confirmation that names the resulting risk.
7. The current state is included in Pi session status messages so every connected client renders the same value.
8. Pi CLI users can run `/safeguards on`, `/safeguards off`, or `/safeguards status` for the active session.
9. CLI and web controls share the same `joint-bob:safeguards` custom session entry.
10. CLI unsafe mode persists across `/resume` and follows the active branch after `/tree` navigation.
11. CLI disabling requires explicit interactive confirmation; the model cannot disable safeguards through a tool.

## Safety boundary

Unsafe mode disables only the `safe-guard` permission extension that confirms dangerous shell commands and protects configured paths. Application authentication, CSRF validation, WebSocket authorization, Git branch restrictions, task isolation, and other extensions remain active.

## Non-functional requirements

- No new dependency.
- Existing session transcripts and model selection remain intact across runtime reload.
- Invalid persisted safeguard metadata fails with a clear error.
- The control remains keyboard accessible and has stable `data-testid` coverage.
- PWA cache version changes with the frontend assets.
- Pi CLI shows the active state in its footer.
- Non-interactive Pi invocations cannot disable safeguards.

## Acceptance criteria

- A fresh Pi session reports safeguards enabled.
- Toggling safeguards off persists a custom session entry and removes only `safe-guard.ts` or `safe-guard.js` from that runtime.
- Toggling safeguards on restores the normal extension set.
- Toggling is rejected while agent, bash, retry, or compaction work is active.
- `/safeguards off` stops both dangerous-command confirmations and protected-path checks only for the active CLI session.
- `/safeguards on` restores those checks without restarting Pi.
- Focused tests, full tests, typecheck, build, JavaScript syntax, and diff checks pass.
