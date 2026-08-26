# Minimal Rebrand Requirements

## Intent
Complete visual rebranding of Pi Console: sleek, modern, minimalistic, no gimmicks. Includes logo and all brand surfaces. Must stay fully mobile-adapted and desktop-friendly.

## Functional Requirements
1. New design token system: monochrome surfaces (paper light / ink dark), hairline borders, no gradients or decorative glows.
2. Primary actions use solid ink buttons (dark-on-light, inverted in dark theme).
3. Engine identity (Pi = teal, Claude = violet) reduced to small dots/badges — never large colored surfaces.
4. Monospace micro-labels for section titles, statuses, badges, and paths (the "console" signature).
5. New logo: geometric pi mark on ink tile with teal cursor detail — SVG plus regenerated 192/512 maskable PNGs.
6. Replace emoji nav/brand glyphs with inline SVG line icons.
7. Update manifest + theme-color metas + service-worker cache bump so installed PWAs pick up the rebrand.
8. Light and dark themes both restyled; theme toggle behavior unchanged.

## Constraints
- Presentation-only: every class name, id, data-testid, and DOM structure the JS relies on is preserved.
- No new dependencies, no external fonts (offline PWA must keep working).
- Mobile-first single-panel flow and desktop three-column grid preserved.
- Accessibility preserved: focus-visible rings, reduced-motion support, aria labels.

## Out of Scope
- Server/API changes, behavior changes, renaming the product.
