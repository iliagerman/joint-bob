# Desktop Conversation Workspace and Live Sync Requirements

## Intent Analysis
- **User request**: Make desktop chat use available space, add conversation search, remove project-card overlap, and keep open synced sessions current.
- **Request type**: UI enhancement and live-refresh bug fix.
- **Scope**: Browser shell plus existing filesystem/WebSocket refresh path.
- **Complexity**: Moderate.

## Functional Requirements
1. Desktop assistant, thinking, and tool content uses the available chat width instead of a narrow fixed column.
2. Desktop composer supports long prompts with a larger useful editing height.
3. Conversation search filters the selected project's conversations by title and available session metadata, while composing with status filters.
4. Project names and paths never sit beneath project action buttons.
5. Session files changed by Mac/homeserver synchronization refresh the conversation list and any open idle transcript without manual reload.
6. Existing mobile navigation and chat behavior remain unchanged.

## Non-Functional Requirements
- Use existing HTML, CSS, JavaScript, filesystem watcher, and WebSocket architecture; no dependency.
- Preserve accessible labels and stable `data-testid` values for new controls.
- Keep local agent streams uninterrupted; external reload suppression applies only to proven recent local writes.
- Update the PWA cache version for changed shell assets.

## Acceptance Criteria
- Conversation search is visible and keyboard-usable in the conversation panel.
- Search and status filters work together and expose a clear no-match state.
- At desktop width, assistant/tool output can span the chat viewport.
- Project action controls reserve their own title space; project path stays unobstructed.
- Opening a session does not create a blind grace period that ignores an immediate synced file change.
- Automated tests, syntax check, typecheck, and build pass.
