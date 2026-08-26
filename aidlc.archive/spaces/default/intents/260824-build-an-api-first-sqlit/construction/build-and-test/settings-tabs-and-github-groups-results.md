# Settings Tabs and GitHub Groups Results

## Validation
- `npm run typecheck` — clean.
- `npm run build` — clean.
- `node --check public/app.js` and `public/sw.js` — clean.
- `node --import tsx --test` over `github-account-groups`, `github-auth-sync`, `github-auth-mesh-api`, `settings-tabs-ui`, `audit`, `settings-api`, `account-settings` — 21 pass, 0 fail.
- Browser check at phone and desktop widths: all five tabs fit on one row without scrolling, panels switch on click and on Left/Right arrow keys, the selected tab keeps a visible focus ring, and the dialog no longer scrolls on the Account, GitHub, Cluster, and Projects tabs.

## Not verified
The live data paths (group list, cluster inventory, project assignment) were verified through the API and mesh tests, not through a logged-in browser session — bringing the local instance up requires creating an administrator account, which was out of scope for this check.

## Behaviour notes
- `personal` and `sela` migrate in place: ids are preserved, labels become "Personal" and "Sela", and `personal` becomes the default group. Existing tokens and project assignments survive.
- Exactly one group is the default. Projects that pick no group use it, which preserves the previous "everything falls back to the personal token" behaviour.
- Deleting a group clears it from its projects; those projects then fall back to the default group, or lose access if none remains.
- Account credential events now carry `{ label, token, isDefault }`. A peer on the pre-groups build still sends a bare token string and is accepted.
- `PUT /api/github-auth` is gone. Groups are managed with `POST /api/github-auth/groups`, `PUT /api/github-auth/groups/:id`, and `DELETE /api/github-auth/groups/:id`.
- `PUT /api/projects/:id/github-auth` now takes `{ group, token }` instead of `{ account, token }`.

## Pre-existing failures, untouched
`material-workspace-ui` and the service-worker cache test still assert the pre-rename cache name `pi-mobile-console-v*`, but the cache is `joint-bob-v*`. Both failed before this change and were left alone.
