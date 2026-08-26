# Session safeguards control code generation plan

This file is the implementation source of truth for the session safeguards control unit.

## Unit context

- Existing Pi sessions are created by `createPiSession()` in `src/pi-service.ts`.
- `SharedPiSession` in `src/server.ts` owns the live runtime and connected WebSocket clients.
- `SessionManager.appendCustomEntry()` persists state without adding it to model context.
- `DefaultResourceLoader.extensionsOverride` can remove the permission-gate extension for one runtime.
- The browser receives authoritative session state through `SessionStatus`.

## Steps

- [x] Step 1: Inspect Pi SDK session, resource loader, extension, and custom-entry APIs.
- [x] Step 2: Define requirements, safety boundary, execution sequence, and rollback.
- [x] Step 3: Add focused failing tests for default state, persistence, extension selection, WebSocket contract, and toolbar accessibility.
- [x] Step 4: Implement session metadata parsing and guard-extension filtering in `src/pi-service.ts`.
- [x] Step 5: Implement safe in-place runtime replacement and WebSocket command handling in `src/server.ts` and `src/types.ts`.
- [x] Step 6: Implement the Pi-only toolbar control, warning, state rendering, and disabled states in `public/index.html`, `public/app.js`, and `public/styles.css`.
- [x] Step 7: Bump the PWA cache in `public/sw.js`.
- [x] Step 8: Run the focused test, full test suite, typecheck, build, JavaScript syntax check, and diff check.
- [x] Step 9: Record build and test results and update AI-DLC state.
- [x] Step 10: Add a failing Pi CLI extension test for command registration, persistence, confirmation, and enforcement.
- [x] Step 11: Add `/safeguards on|off|status` to `~/.pi/agent/extensions/safe-guard.ts` using the shared custom entry.
- [x] Step 12: Restore CLI state on session start and tree navigation, and render footer status.
- [x] Step 13: Verify the extension with the focused harness, strict TypeScript, and an actual Pi print-mode command.

## Explicit exclusions

- Do not disable authentication, CSRF, WebSocket authorization, task isolation, or Git branch restrictions.
- Do not apply unsafe mode to Claude sessions.
- Do not add a global unsafe default.
- Do not expose an LLM-callable tool that can disable safeguards.
- Do not allow non-interactive disabling without confirmation.
- Do not add dependencies.
