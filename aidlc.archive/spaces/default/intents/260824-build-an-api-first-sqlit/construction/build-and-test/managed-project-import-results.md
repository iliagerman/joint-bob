# Managed project import build and test results

## Implementation

- Added complete local directory copy, move, and move-with-source-symlink operations.
- Added authenticated project API inputs for source paths and import modes.
- Added Add project UI controls and node-local folder browsing.
- Preserved source paths for existing conversation discovery.
- Kept imported folders unchanged by avoiding generated `AGENTS.md` files.
- Strengthened root and nested `node_modules` Syncthing exclusions.
- Bumped the PWA shell cache to `joint-bob-v12`.

## Validation

- Focused import/API/UI/Syncthing tests: passed.
- TypeScript typecheck: passed.
- Build: passed.
- Browser JavaScript syntax and `git diff --check`: passed.
- Full suite: 186 of 187 passed in one sequential run; the unrelated legacy GitHub startup timing test passed immediately when rerun alone. All tests after the normal parallel run's timeout passed as a focused group.
