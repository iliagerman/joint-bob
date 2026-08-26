# Material Workspace UI Requirements

## Intent
Replace the visually noisy desktop workspace with a polished, restrained Material-style interface while preserving the existing mobile-first navigation and all current behavior.

## Requirements
- Use a coherent Material-inspired surface hierarchy, tonal palette, typography scale, spacing system, elevation, and interaction states.
- Remove the muddy gradient-heavy presentation and serif body typography.
- Make project and conversation navigation compact, scannable, and visually subordinate to the active chat.
- Keep project/session actions accessible without letting them dominate desktop list rows.
- Improve message, tool-output, code-block, toolbar, composer, dialog, board, and status readability in light and dark themes.
- Preserve the existing one-panel-at-a-time mobile flow, bottom navigation, safe-area handling, 44px minimum touch targets, and horizontal overflow protection.
- Provide visible keyboard focus and reduced-motion behavior.
- Add no frontend dependencies and change no API behavior.
- Bump the PWA shell cache so installed clients receive the redesign.

## Scope
- `public/index.html`
- `public/styles.css`
- `public/app.js` only for theme metadata
- `public/sw.js`
- Frontend contract test
- Desktop and mobile browser verification

## Acceptance Criteria
1. Desktop uses a stable three-column Material workspace at 1024px and above.
2. Navigation cards are compact and use restrained hover/selected states; desktop row actions reveal on hover/focus.
3. Chat content has clear hierarchy, readable Markdown/code, and a visually anchored composer.
4. Light and dark themes use neutral tonal surfaces and one primary blue accent.
5. At a phone viewport, only the selected panel is shown and bottom navigation remains usable above safe-area insets.
6. Interactive elements have visible `:focus-visible` treatment and touch targets remain at least 44px where needed.
7. Existing automated tests, typecheck, build, and JavaScript syntax checks pass.
8. Browser screenshots verify desktop and phone layouts without overlap or horizontal overflow.
