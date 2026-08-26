# Conversation status indicators code generation plan

This file is the execution checklist for the conversation-status-indicators unit.

## Unit context

- **Requirement**: Track Running, Needs review, and Reviewed for every conversation.
- **Persistence**: Signed-in account, project, and session path.
- **Dependencies**: Existing SQLite node database, session list API, WebSocket events, push service, and browser platform APIs.

## Steps

- [x] Step 1: Add failing persistence, API contract, and UI contract tests.
- [x] Step 2: Add SQLite-backed conversation review state transitions.
- [x] Step 3: Add review status to session responses and a validated mark-reviewed endpoint.
- [x] Step 4: Add completion sound preference persistence and API validation.
- [x] Step 5: Render status dots, labels, filter counts, and automatic reviewed-on-open behavior.
- [x] Step 6: Add notification settings, selectable in-app sounds, and sound preview.
- [x] Step 7: Bump the PWA cache and verify typecheck, build, focused tests, full tests, and browser-facing contracts.
- [x] Step 8: Record build and test results.
