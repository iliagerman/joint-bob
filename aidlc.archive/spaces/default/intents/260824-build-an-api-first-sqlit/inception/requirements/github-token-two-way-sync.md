# GitHub Token Two-Way Sync Requirements

## Intent Analysis
- **Request type**: Feature enhancement
- **Scope**: GitHub credential persistence and deployment documentation
- **Complexity**: Simple

## Problem
GitHub account tokens and project overrides currently live in each machine's `~/.pi-mobile-web/github-auth.json`. Saving a token on the Mac therefore does not configure the homeserver, and saving one on the homeserver does not configure the Mac.

## Functional Requirements
1. GitHub account tokens saved by either Pi Mobile Web instance become available to the other instance through the existing two-way Syncthing folder.
2. Project-level account selections and token overrides follow the same behavior.
3. Saving, replacing, and clearing credentials propagate in both directions.
4. Each running instance reads synchronized changes without restart or token re-entry.
5. Existing machine-local credentials remain available and migrate into shared storage when no shared store exists.
6. `PI_MOBILE_WEB_GITHUB_AUTH_PATH` can override the shared file location.

## Non-Functional Requirements
- Keep token values out of API responses, logs, source control, and generated documentation.
- Store the shared credential file with mode `0600` and its directory with mode `0700`.
- Keep the Git askpass helper machine-local.
- Add no dependency or external credential service.
- Preserve the existing GitHub auth API and UI contracts.

## Acceptance Criteria
- An automated integration test writes credentials as a Mac instance, reads and updates them as a homeserver instance, then observes the update and clear from both sides.
- The default shared store is under the repository's existing Syncthing scope and existing `.gitignore` coverage.
- Tests, typecheck, and build pass locally and on the homeserver.
- Homeserver service remains healthy with the Headroom environment preserved.
