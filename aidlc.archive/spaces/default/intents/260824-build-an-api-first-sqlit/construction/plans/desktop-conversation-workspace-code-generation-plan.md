# Desktop Conversation Workspace Code Generation Plan

## Unit Context
Single existing browser/server unit. Session discovery already uses filesystem watchers and project WebSockets.

## Steps
- [x] Step 1: Add tests covering the new conversation search contract, full-width desktop content, protected project metadata, and immediate external-refresh eligibility.
- [x] Step 2: Add `sessionSearchInput` markup/state wiring and compose it with existing chat status filtering.
- [x] Step 3: Update project-card spacing and desktop chat/composer layout in `public/styles.css`.
- [x] Step 4: Initialize opened Pi sessions without a false recent-local-write timestamp in `src/server.ts`.
- [x] Step 5: Bump `public/sw.js` cache version.
- [x] Step 6: Run project tests, JavaScript syntax validation, TypeScript typecheck, and build; record results.

## Files
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `public/sw.js`
- Modify: `src/server.ts`
- Create: `test/desktop-conversation-workspace.test.ts`

## Approval
User's direct implementation request authorizes this bounded plan; no unresolved product decision remains.
