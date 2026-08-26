# Session safeguards control execution plan

## Impact

- User-facing change: yes, one Pi-only toolbar control
- Structural change: small, existing Pi session runtime is re-created in place
- Data model change: append-only custom entry in the existing Pi JSONL session
- API change: WebSocket command and status field
- Infrastructure change: none
- Risk: medium

## Stage selection

- Requirements Analysis: execute at minimal depth because the request and affected guard are explicit.
- User Stories: skip. One administrator workflow and direct acceptance criteria are enough.
- Application Design: skip. Existing `pi-service`, shared-session, WebSocket, and toolbar boundaries remain.
- Units Generation: skip. One cohesive unit.
- Functional and NFR Design: skip. No new business model or infrastructure.
- Code Generation: execute test-first.
- Build and Test: execute focused and full validation.

## Change order

1. Add focused tests for persisted session state, extension filtering, socket wiring, and accessible UI.
2. Add safeguard state loading and permission-extension filtering in `src/pi-service.ts`.
3. Add in-place shared Pi runtime replacement and WebSocket command handling in `src/server.ts`.
4. Add the Pi-only toolbar control and risk confirmation in `public/index.html`, `public/app.js`, and `public/styles.css`.
5. Bump `public/sw.js` cache name.
6. Run validation and record results.

## Rollback

Revert these bounded changes. Existing custom JSONL entries are ignored by older builds and do not enter model context.
