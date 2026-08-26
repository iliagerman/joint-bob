# Conversation status indicators build and test results

## Delivered

- SQLite-backed review tracking scoped by user, project, and session path
- Running, Needs review, and Reviewed status on every conversation
- Automatic Reviewed transition when a completed conversation is opened
- Live filter counts for all three states
- Notification settings tab with per-device browser permission handling
- Project-wide push subscriptions so any completed chat can notify the browser
- Off, Chime, and Bell in-app completion sound choices with preview
- PWA cache version `joint-bob-v57`

## Validation

- `npm run typecheck`: passed
- `npm run build`: passed
- `node --check public/app.js`: passed
- Focused conversation, preferences, push, settings, and cache tests: 11 passed
- Full `npm test`: 163 passed, 0 failed
- `git diff --check`: passed

## Notes

Custom Chime and Bell sounds use Web Audio while the app is open. Background notification sound follows browser and operating-system settings because service workers cannot select custom notification audio.
