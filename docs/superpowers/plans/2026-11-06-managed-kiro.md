# Managed Kiro implementation plan

**Goal:** Install and use Joint Bob's own Kiro CLI v3, recover missing installations, and allow disabling Kiro without blocking Settings.

**Architecture:** Extend the existing harness updater with a native Kiro package installer. Use the official stable manifest, SHA-256 verification, staging and replacement only after version/ACP checks. Keep native credentials and transcript paths unchanged. Kiro defaults to the managed executable and is enabled after installation unless explicitly disabled.

**Approved scope:** Conversation request, including immediate usability after installation and no background sign-in popups.

## Tasks

- [x] Add failing installer tests for platform selection, checksum rejection, staged replacement, missing-install recovery and managed defaults.
- [x] Implement `src/kiro-install.ts`; integrate `src/harness-updater.ts` and `src/harnesses/kiro.harness.ts`. Never run the vendor installer or modify the external launcher. Migrate standard legacy launcher overrides, preserve explicit custom paths.
- [x] Add failing settings/runtime tests. Persist `kiroEnabled`, skip disabled probes/updates, reject new Kiro execution when disabled, retain readable history.
- [x] Add Settings toggle and browser regression for saving with an unavailable disabled executable. Preserve validation of newly entered enabled custom paths.
- [x] Run focused tests, typecheck, build, full tests and UI checks; report any failures.
- [x] Install and select the verified managed CLI on this node. Version 3.1.0 and `acp --agent-engine=v3 --help` passed. External launcher remains blocked.
- [ ] Complete authenticated live smoke after the user signs in. Both `whoami` and the runtime's profile-aware sign-in check report no signed-in account.

## Verification on 2026-11-07

Typecheck and build passed. The focused installer/settings/runtime/browser run passed 29 checks; after adding native self-update suppression, 17 focused checks passed again. Profile-disable and profile execution tests passed another 5 checks.

Full `npm test` and `npm run test:ui` were each attempted with a 30-minute limit; neither completed within it. Unit output reached over 3,100 tests and reported `test/control-center-bob-tasks-api.test.ts`, whose prompt lacked the expected attachment filename. UI failures were in `ui-accounts`, `ui-activity-chat-secrets`, `ui-activity-chat-settings`, `ui-activity-chat-status`, `ui-browser-executor`, `ui-by-the-way`, `ui-classification-filter`, and `ui-cluster-page`, with `Short one` versus `Short One` fixture-title mismatches. These are outside the focused Kiro checks; the full suites are not green. Logs: `/tmp/jb-kiro-full-tests.QsAdqS`, `/tmp/jb-kiro-ui-tests.T8PRqi`.

Independent review could not run: the default child agent requested an unsupported model and produced no review. Local diff review caught and fixed native profile probes bypassing the disable choice and disabled native self-updates for app-managed execution.

Managed installation and executable selection are live on the Mac. Settings toggle and updater changes still require deployment.

## Review focus

- A corrupt download or incompatible release must leave the working binary intact.
- An unavailable external launcher must not become an implicit fallback.
- Explicitly disabled Kiro must stay disabled after updates and restarts.
- Existing custom config and transcript roots must not change.
- First-install authentication may require the user; never open a login page from background discovery.
