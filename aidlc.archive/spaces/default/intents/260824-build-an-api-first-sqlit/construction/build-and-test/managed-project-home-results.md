# Managed project home build and test results

## Implementation

- Added one node-selectable `projects.homePath`, defaulting to `~/JointBob`.
- New managed projects use `<home>/projects/<personal|work>/<sanitized-name>`.
- New board-card workspaces use `<home>/tickets/<project-id>/<task-id>`.
- Added managed-root Git ignore rules for `projects/` and `tickets/`.
- Preserved explicit paths for legacy/external projects and did not move existing files.
- Blocked home changes while synchronized card workspaces exist.
- Updated existing Syncthing folder paths and retained mandatory root/nested `.git` exclusions.
- Updated settings/new-project UI, credential wording, README, and PWA cache.

## Validation

- Terra focused checks: 22 passed; typecheck passed.
- Sol focused checks: 22 passed.
- Sol full `npm test`: 183 passed, 0 failed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Browser JavaScript syntax, shell syntax, and `git diff --check`: passed.
- Browser automation was unavailable because `agent-browser` is not installed in PATH.

## Review

Sol reviewed all changed files and the full diff. One Terra repair removed swallowed Syncthing errors, fixed the fake-service test, sanitized managed project path segments, removed dead helpers, and corrected credential replication wording.
