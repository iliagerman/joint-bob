# Managed MCP implementation plan

**Goal:** Add MCP servers once in Joint Bob for Claude, Pi and Kiro, with one OAuth sign-in per user per machine.

**Architecture:** A bundled MCP SDK connects on behalf of the signed-in account. A conversation-scoped, local-only bridge lets native MCP harnesses use those connections without receiving upstream OAuth tokens. Pi receives the same tools through a built-in extension factory, including the bundled fallback Pi version. New server definitions and OAuth state live only in node-local storage, partitioned by account, never in replicated resources. Existing native MCP configurations remain supported and separate.

**Constraints:** No cross-user or cross-machine credential sharing. Preserve strict resource isolation, activation and personal assistant restrictions. No runtime client installation, the SDK ships as an npm dependency. Explicitly adding a stdio server authorizes its command to run as that user's runtime, not another user's account. No silent connection errors. Do not modify unrelated work in this shared checkout.

## Tasks

- [x] 1. Tests first for validated bulk configuration, per-account storage and OAuth isolation; add bundled SDK and client lifecycle.
- [x] 2. Add authenticated local broker, conversation-scoped capabilities and stdio bridge; prove account and server access restrictions with tests.
- [x] 3. Automatically register MCP tools in Pi and bridge configs in Claude/Kiro; test actual list/call round trips and failure reporting.
- [x] 4. Add MCP setup and shared sign-in controls to Resources, including bulk JSON import and Figma URL setup; test UI with isolated seeded node.
- [x] 5. Verify typecheck and build, run focused and full-suite checks, self-review and prepare the feature-only release in a private index. Deliver with commit and push to main.

## Review focus

- OAuth state, redirect origin, PKCE and per-user ownership must be checked; cancellation, removal and sign-out must close connections.
- A disabled server or a restricted assistant must never become callable through a previously minted capability.
- Tool failures must not be replayed; tool error and image results must remain meaningful in each harness.
- Missing or unauthenticated servers must not silently disappear or prevent unrelated tools from loading.
- New MCP setup must remain separate from legacy Claude-only sign-ins and credentials.

## Execution record

- User explicitly authorized implementation, commit and push on main. Fresh fetch before interruption showed HEAD equals origin/main.
- No changes or installation happened before service interruption. Resumed on main at 40e6b40d.
- Decision: use a bundled SDK/bridge rather than depend on a separately installed Pi extension. Covers both managed Pi 1.5 and bundled Pi 0.87.
- Configuration tests initially failed on the missing store; passed after implementing per-account persistence and validation. Concurrent-call test failed with two overlapping requests, then passed after serializing each account/server's requests to prevent refresh-token races.
- Tests cover a local OAuth issuer, forged/cross-account callbacks, sign-out, cancellation ownership, image/error results, no mutation replay, authenticated/CSRF routes, revoked capabilities, activation changes and personal assistant allowlists.
- A real bundled Pi SDK session loads and calls the managed tool without an installed extension. Claude/Kiro generated configuration uses the same bundled bridge without storing capability tokens in config files.
- Two isolated Chrome journeys passed, covering bulk installation, Pi/Claude/Kiro filters, remove, existing Resources behavior and no credential values in inventory.
- Full `npm test` was attempted and timed out after 1800 seconds. Failures included auto-respond cancellation, browser-agent cleanup, cluster secrets, file-sync worker/relay/records/shadow suites, and scoped skill sharing. Its obsolete Pi-has-no-MCP inventory assertion was updated and verified green. The cancellation failure was reproduced without MCP changes, using HEAD plus the pre-existing auto-respond-run.ts edit in a disposable baseline snapshot.
- Review: self-review, no subagent tool available. Checked node-local ownership, callback origin/state/PKCE, broker restrictions, error redaction and connection shutdown. Found and fixed stdio cwd handling with a failing test first.
- Scope: tools and image results; MCP resources, prompts and embedded Apps are not exposed by this bridge. Existing native OAuth credentials are not migrated. Real Figma authorization is not live-verified and may require an approved client registration.
- Final delivery uses a private git index, with only this feature's hunks from mixed files. The exact commit snapshot passed typecheck, build and all 39 selected tests, including both isolated Chrome journeys. Full-suite completion remains unverified due to the timeout and failures listed above. Commit and push are authorized by the user; the resulting git history is the delivery record.
