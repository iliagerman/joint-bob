# Minimal Rebrand Code Generation Plan

- [x] Rewrite public/styles.css with the new token system, preserving every existing selector contract
- [x] Update public/index.html: title, theme-color meta, brand mark (inline SVG), nav SVG icons, empty-state mark, install banner mark
- [x] New public/icon.svg (geometric pi + cursor); regenerate icon-192.png / icon-512.png (full-bleed maskable)
- [x] Update public/manifest.webmanifest colors/names
- [x] Bump CACHE_NAME in public/sw.js to v39
- [x] Update hardcoded theme-color hexes in public/app.js setTheme()
- [x] Verify: npm run typecheck, npm run build, headless browser screenshots (390px and 1440px, light and dark)
