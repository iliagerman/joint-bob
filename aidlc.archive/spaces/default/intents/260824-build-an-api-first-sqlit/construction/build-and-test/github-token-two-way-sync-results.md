# GitHub Token Two-Way Sync Build and Test Results

## Completed
2026-08-14T10:01:54Z

## Implementation
- GitHub account tokens and project overrides now default to `<repo>/.pi-mobile-web/github-auth.json`.
- The Git askpass helper remains in machine-local `PI_WEB_DATA_DIR`.
- Existing populated `~/.pi-mobile-web/github-auth.json` stores migrate when the shared store is absent.
- `PI_MOBILE_WEB_GITHUB_AUTH_PATH` overrides the shared store path.
- API responses continue to expose configuration booleans, never token values.

## Automated Validation
- Red test confirmed the previous machine-local implementation failed cross-device reads.
- `npm test`: 18 passed, 0 failed locally and on the homeserver.
- `npm run typecheck`: passed locally and on the homeserver.
- `npm run build`: passed locally and on the homeserver.
- `node --check public/app.js`: passed.
- `node --check public/sw.js`: passed.
- `git diff --check`: passed.

## Two-Way Syncthing Validation
A temporary fake-token credential store under `.pi-mobile-web/` verified the production Syncthing path:
1. Mac wrote; homeserver read successfully.
2. Homeserver replaced the value; Mac read successfully.
3. Mac deleted the probe; deletion reached the homeserver.
4. Probe data was removed from both devices.

No real token value was printed or copied into tracked files.

## Deployment Validation
- Touched files reached `/home/ilia/codebase/personal/pi-mobile-web` with matching SHA-256 checksums.
- Homeserver service restarted after build and became healthy at `/api/health`.
- `/api/github-auth` returned masked boolean status only.
- Headroom environment remained active: `OPENAI_BASE_URL`, `PI_MOBILE_WEB_PI_ALIAS=pi-hr`, and `PI_MOBILE_WEB_MODEL=openai-codex/gpt-5.6-sol`.
