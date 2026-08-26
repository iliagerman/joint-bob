# List Loading Indicators Requirements

## Intent
Show visible loading feedback while project and conversation lists are fetched.

## Requirements
- Show an indeterminate loading bar during the initial project request.
- Show an indeterminate loading bar immediately after selecting a project and while its conversations are requested.
- Hide each bar when its request settles, including failures.
- Keep loading feedback accessible with `role="progressbar"` and a descriptive label.
- Match the existing light/dark visual system and honor reduced-motion preferences.

## Scope
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/sw.js`
- Frontend contract test

## Acceptance Criteria
1. Project bar is visible until `/api/projects` settles.
2. Conversation bar is visible while `/api/projects/:id/sessions` is pending.
3. Conversation panel opens before its request completes, making the bar visible.
4. Bars disappear after success or failure.
5. PWA shell cache version is bumped.
