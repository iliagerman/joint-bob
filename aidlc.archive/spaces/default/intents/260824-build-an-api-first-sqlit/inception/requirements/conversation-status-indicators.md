# Conversation status indicators requirements

## Intent analysis

- **User request**: Make conversation state obvious in the web UI, track whether completed work was reviewed, play a configurable completion sound, and show browser notifications.
- **Request type**: User-facing enhancement
- **Scope estimate**: Browser UI, authenticated persistence, session API, and existing push notification flow
- **Complexity estimate**: Moderate

## Functional requirements

1. Every listed conversation shows one state: Running, Needs review, or Reviewed.
2. A conversation becomes Needs review when an agent finishes after the user's last review.
3. Opening a finished conversation marks its latest result Reviewed.
4. Existing conversations start Reviewed. Only later agent results create review work.
5. Review state persists in the signed-in account across browser and device changes.
6. Conversation filters show All, Running, Needs review, and Reviewed with live counts.
7. The status treatment uses a colored dot and text label on every conversation row.
8. Browser push notifications open the completed conversation when tapped.
9. Settings allow completion notifications to be enabled or disabled.
10. Settings allow an in-app completion sound to be selected or disabled and previewed.

## Non-functional requirements

- Do not add dependencies or external audio assets.
- Use the browser Notification, Service Worker, Push, and Web Audio APIs.
- Keep native notification sound under operating-system control. The selected custom sound applies while the web app is open.
- Preserve existing Pi, Claude, task, mobile, and cluster behavior.
- Keep review data scoped by authenticated user, project, and session path.
- Validate all new API input.
- Honor reduced-motion preferences for running indicators.

## Acceptance criteria

- Existing chats render Reviewed after deployment.
- A running chat visibly animates and appears under Running.
- A newly completed chat moves to Needs review even when another chat is selected.
- Opening that chat moves it to Reviewed.
- Counts update after running, completion, review, and filtering.
- Notification and sound preferences survive sign-out and listener restart.
- A completion can trigger both push notification delivery and the selected in-app sound.
