# Settings Tabs and GitHub Groups Code Generation Plan

## Context
Two changes to one node. The settings dialog (`public/index.html:201`) is a single long scroll of six fieldsets; GitHub (`:406`) and Cluster (`:257`) live in separate dialogs. Separately, GitHub credentials are hardcoded to two accounts, `personal` and `sela`, in the type (`src/github-auth.ts:9`), the account list (`:34`), the API validation (`src/server.ts:210`), and the cluster credential-sync wire format (`src/server.ts:189`).

## Decisions
- Settings becomes 5 tabs: Account, GitHub, Cluster, Projects, Engines. Syncthing moves under Projects; Pi and Claude share Engines.
- A GitHub group is `{ id, label, token }`. `id` is stable so renaming a label never breaks project assignments.
- Existing `personal` / `sela` rows migrate in place: id stays, label becomes "Personal" / "Sela". No data loss, and in-flight cluster events keep resolving.
- Deleting a group leaves its projects with no group. They lose GitHub access until reassigned.
- The per-project token override stays.

## Steps
- [x] Step 1: Add failing tests — `test/github-account-groups.test.ts` (group CRUD, rename keeps assignments, delete orphans projects, legacy migration) and `test/settings-tabs-ui.test.ts` (tab markup, panel wiring, no orphaned dialogs).
- [x] Step 2: Backend store — add `label` column to `github_accounts`, replace `GitHubAccount` union with a group id string, make project `account` nullable, migrate `personal`/`sela` labels, add `listGitHubGroups` / `createGitHubGroup` / `updateGitHubGroup` / `deleteGitHubGroup`.
- [x] Step 3: Cluster sync — widen the account event payload from a bare token string to `{ label, token }`, accepting the legacy string form for older peers.
- [x] Step 4: API — replace `PUT /api/github-auth` with group CRUD routes, widen the project route to `{ group, token }`, swap `z.enum` validation for id/label string schemas.
- [x] Step 5: Markup — rebuild the settings dialog as a tablist with 5 panels, fold the GitHub and Cluster dialog bodies into their tabs, delete the two standalone dialogs.
- [x] Step 6: Styles — add tab strip, active-tab, and panel rules to `public/styles.css`; horizontal scroll on narrow screens; honour `prefers-reduced-motion`.
- [x] Step 7: Frontend logic — tab switching with keyboard support, GitHub group list rendering (add / rename / retoken / delete), project group dropdown, point the toolbar GitHub and Nodes buttons at the matching tab.
- [x] Step 8: Bump `CACHE_NAME` in `public/sw.js` so installed PWA clients pick up the new shell.
- [x] Step 9: Run `npm run typecheck`, `npm run build`, `npm test`; verify in a browser at desktop and phone widths.
- [x] Step 10: Record results in `aidlc-docs/construction/build-and-test/settings-tabs-and-github-groups-results.md`.
