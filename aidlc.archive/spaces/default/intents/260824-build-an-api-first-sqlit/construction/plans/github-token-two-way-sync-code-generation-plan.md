# GitHub Token Two-Way Sync Code Generation Plan

User authorization: “when I add github token from my mac they should be already avalible on the homeserver and vise versa, ti must be working on both devices”.

- [x] Step 1: Add a failing integration test covering Mac-to-homeserver and homeserver-to-Mac account/project credential changes.
- [x] Step 2: Store GitHub auth in the repository-local gitignored Syncthing folder while keeping askpass machine-local.
- [x] Step 3: Preserve and migrate an existing machine-local GitHub auth store.
- [x] Step 4: Document the default shared path and `PI_MOBILE_WEB_GITHUB_AUTH_PATH` override.
- [x] Step 5: Run local tests, typecheck, build, syntax, and diff checks.
- [x] Step 6: Deploy, verify Syncthing propagation, run homeserver validation, and confirm service health.
