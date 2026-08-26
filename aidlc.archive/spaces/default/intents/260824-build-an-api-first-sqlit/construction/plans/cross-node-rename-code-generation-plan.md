# Cross-Node Rename Code Generation Plan

- [x] `src/names.ts` — shared name store in `<repoRoot>/.pi-mobile-web/names.json`; project and session overrides keyed on node-stable basenames
- [x] `src/store.ts` — apply project overrides in `listProjects()`; add `renameProject()`
- [x] `src/pi-service.ts` — apply session title overrides to Pi and Claude summaries
- [x] `src/server.ts` — `PATCH /api/projects/:projectId` and `PUT /api/projects/:projectId/sessions/title`
- [x] `public/index.html` — project rename dialog; enable session rename for Claude
- [x] `public/app.js` — project rename row action; session rename over HTTP for both engines
- [x] `public/sw.js` — cache bump
- [x] Verify: typecheck, build, live rename round-trip, browser check
